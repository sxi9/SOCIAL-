// QR cross-device login (v0.9 — API.md §1.71, ADR-021, FEATURES #83).
// WhatsApp-Web style, pure first-party, built ON the sessions table: the
// logged-out laptop mints a link (full 32-byte code = the QR payload and the
// ONLY poll/redeem capability; 6-char display code = approve-only human
// fallback), the logged-in phone approves it with eyes open (laptop UA + a
// coarse ip hint), and the laptop's NEXT poll mints a standard §1.1 session
// on the laptop's OWN request — the token never transits the phone or a row.
// Status is a one-way pending → approved → consumed walk; every transition is
// an atomic UPDATE … WHERE status='<prev>' RETURNING (the race rule); every
// failure is one byte-identical 410 link_gone.
import { randomBytes, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApproveLoginLinkRequestSchema,
  DenyLoginLinkRequestSchema,
  LOGIN_LINK_APPROVE_RATE_PER_MIN,
  LOGIN_LINK_CREATE_RATE_PER_HOUR,
  LOGIN_LINK_DISPLAY_ALPHABET,
  LOGIN_LINK_DISPLAY_CODE_LEN,
  LOGIN_LINK_CODE_BYTES,
  LOGIN_LINK_TTL_S,
  LookupLoginLinkRequestSchema,
  PollLoginLinkRequestSchema,
  type PollLoginLinkResponse,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { userPrivateDto } from '../../lib/dto.js';
import { gone, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { authed, requireAuth } from './guard.js';
import { setSessionCookie, storableIp } from './minting.js';
import { createSession, hashCode } from './service.js';

type LinkRow = typeof schema.loginLinks.$inferSelect;

/** Display codes are typed by humans: uppercase, strip spaces/dashes. The
 *  alphabet already excludes 0/O/1/I/L so there is nothing else to fix. */
function normalizeDisplayCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

function newDisplayCode(): string {
  let out = '';
  for (let i = 0; i < LOGIN_LINK_DISPLAY_CODE_LEN; i++) {
    out += LOGIN_LINK_DISPLAY_ALPHABET[randomInt(LOGIN_LINK_DISPLAY_ALPHABET.length)];
  }
  return out;
}

/** Match a loose user-supplied code against BOTH hash columns: the full code
 *  (poll capability, also valid on the phone via /link/<code>) or the typed
 *  display code (approve-only — lookup/approve are the only callers that pass
 *  tryDisplay). */
function codeMatch(code: string, tryDisplay: boolean) {
  const full = eq(schema.loginLinks.codeHash, hashCode(code.trim()));
  if (!tryDisplay) return full;
  return or(full, eq(schema.loginLinks.displayCodeHash, hashCode(normalizeDisplayCode(code))))!;
}

/** The approve sheet's COARSE locality hint (§1.71): never the raw address. */
export function ipHint(laptopIp: string | null, phoneIp: string | undefined): string | null {
  if (!laptopIp) return null;
  if (!phoneIp || isIP(phoneIp) === 0) return 'elsewhere';
  if (laptopIp === phoneIp) return 'this network';
  if (isIP(laptopIp) === 4 && isIP(phoneIp) === 4) {
    const a = laptopIp.split('.').slice(0, 3).join('.');
    const b = phoneIp.split('.').slice(0, 3).join('.');
    if (a === b) return 'this network';
  }
  return 'elsewhere';
}

const LINK_GONE = () => gone('link_gone');

export async function loginLinkRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.71 POST /api/auth/link — the logged-out laptop mints a link. `code`
  // is returned ONCE; only hashes persist.
  app.post('/api/auth/link', async (req, reply) => {
    const rate = await fixedWindow(`linkcreate:${req.ip}`, LOGIN_LINK_CREATE_RATE_PER_HOUR, 3600);
    if (!rate.allowed) throw rateLimited(rate.retryAfterS);
    const code = randomBytes(LOGIN_LINK_CODE_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + LOGIN_LINK_TTL_S * 1000);
    // display_code_hash is UNIQUE — regenerate on the (rare) collision with a
    // not-yet-GC'd row rather than failing the login page.
    for (let attempt = 0; ; attempt++) {
      const displayCode = newDisplayCode();
      try {
        await db.insert(schema.loginLinks).values({
          id: newId(),
          codeHash: hashCode(code),
          displayCodeHash: hashCode(displayCode),
          userAgent: req.headers['user-agent'] ?? null,
          ip: storableIp(req.ip),
          expiresAt,
        });
        return reply.status(201).send({
          code,
          display_code: displayCode,
          url: `/link/${code}`,
          expires_at: expiresAt.toISOString(),
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505' && attempt < 4) continue;
        throw err;
      }
    }
  });

  // §1.71 POST /api/auth/link/poll — the laptop, every 2 s. The first poll
  // after approval atomically flips approved → consumed and mints the session
  // ON THIS REQUEST. Unknown/expired/consumed → 410, byte-identical.
  app.post('/api/auth/link/poll', { schema: { body: PollLoginLinkRequestSchema } }, async (req, reply) => {
    // Defensive ceiling only — the documented cadence is well under it.
    const rate = await fixedWindow(`linkpoll:${req.ip}`, 120, 60);
    if (!rate.allowed) throw rateLimited(rate.retryAfterS);
    const [row] = await db
      .select()
      .from(schema.loginLinks)
      .where(codeMatch(req.body.code, false))
      .limit(1);
    if (!row || row.expiresAt.getTime() <= Date.now() || row.status === 'consumed') {
      throw LINK_GONE();
    }
    if (row.status === 'pending') {
      const pending: PollLoginLinkResponse = {
        status: 'pending',
        expires_at: row.expiresAt.toISOString(),
      };
      return reply.status(200).send(pending);
    }
    // approved → consumed: the atomic one-way claim (exactly one poll wins).
    const claimed = (await db
      .update(schema.loginLinks)
      .set({ status: 'consumed' })
      .where(
        and(
          eq(schema.loginLinks.id, row.id),
          eq(schema.loginLinks.status, 'approved'),
          gt(schema.loginLinks.expiresAt, new Date()),
        ),
      )
      .returning({ approvedBy: schema.loginLinks.approvedBy })) as {
      approvedBy: string | null;
    }[];
    const approvedBy = claimed[0]?.approvedBy;
    if (!approvedBy) throw LINK_GONE();
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, approvedBy))
      .limit(1);
    // Approver vanished/suspended/banned since approving: same silent 410.
    if (!user || user.suspendedAt !== null || user.bannedAt !== null) throw LINK_GONE();
    // Standard §1.1 session, UA/IP captured from the LAPTOP's own request;
    // new_session_id is a plain audit FK (ADR-021).
    const { token, session } = await createSession(
      user.id,
      req.headers['user-agent'] ?? null,
      storableIp(req.ip),
    );
    await db
      .update(schema.loginLinks)
      .set({ newSessionId: session.id })
      .where(eq(schema.loginLinks.id, row.id));
    setSessionCookie(reply, token);
    const consumed: PollLoginLinkResponse = { status: 'consumed', user: userPrivateDto(user) };
    return reply.status(200).send(consumed);
  });

  // §1.71 POST /api/auth/link/lookup — the phone's approve sheet facts about
  // the laptop. Full OR display code; pending links only.
  app.post(
    '/api/auth/link/lookup',
    { preHandler: requireAuth, schema: { body: LookupLoginLinkRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`linklookup:${user.id}`, LOGIN_LINK_APPROVE_RATE_PER_MIN, 60);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const [row] = await db
        .select()
        .from(schema.loginLinks)
        .where(
          and(
            codeMatch(req.body.code, true),
            eq(schema.loginLinks.status, 'pending'),
            gt(schema.loginLinks.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!row) throw LINK_GONE();
      return {
        link: {
          created_at: row.createdAt.toISOString(),
          expires_at: row.expiresAt.toISOString(),
          user_agent: row.userAgent,
          ip_hint: ipHint(row.ip, req.ip),
        },
      };
    },
  );

  // §1.3 POST /api/auth/link/deny — a real Deny: the pending row is deleted
  // and the laptop's next poll answers 410 link_gone at once. Any signed-in
  // user may deny (the sheet is only reachable by someone holding the code).
  app.post(
    '/api/auth/link/deny',
    { preHandler: requireAuth, schema: { body: DenyLoginLinkRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`linkdeny:${user.id}`, LOGIN_LINK_APPROVE_RATE_PER_MIN, 60);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      await db
        .delete(schema.loginLinks)
        .where(and(codeMatch(req.body.code, true), eq(schema.loginLinks.status, 'pending')));
      return reply.status(204).send();
    },
  );

  // §1.71 POST /api/auth/link/approve — the phone's session is the factor;
  // the sheet it just read is the informed consent. Atomic pending→approved.
  app.post(
    '/api/auth/link/approve',
    { preHandler: requireAuth, schema: { body: ApproveLoginLinkRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`linkapprove:${user.id}`, LOGIN_LINK_APPROVE_RATE_PER_MIN, 60);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const approved = await db
        .update(schema.loginLinks)
        .set({ status: 'approved', approvedBy: user.id })
        .where(
          and(
            codeMatch(req.body.code, true),
            eq(schema.loginLinks.status, 'pending'),
            gt(schema.loginLinks.expiresAt, new Date()),
          ),
        )
        .returning({ id: schema.loginLinks.id });
      if (approved.length === 0) throw LINK_GONE();
      return reply.status(204).send();
    },
  );
}
