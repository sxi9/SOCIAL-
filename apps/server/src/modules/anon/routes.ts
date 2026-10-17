// Anonymous reveal game routes (v0.8b — API.md §1.62, FEATURES #77, ADR-019).
// Hard rules carried here: refusals to open a thread are INVISIBLE and
// byte-identical (404 anon_unavailable for unknown / opted-out / unmet
// 'connections' / blocked either way / banned / self); the game is TEXT ONLY
// and lives OFF the seq log (no receipts, no typing, no reactions); the
// recipient's view of the sender rides ONLY the thread-gated blur proxy until
// reveal — the real avatar URL/pixels never reach them early (client-side
// blur would ship the answer).
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import sharp from 'sharp';
import {
  ANON_AVATAR_CACHE_TTL_S,
  ANON_BLUR_SIGMA_MAX,
  ANON_NEW_THREAD_RATE_PER_DAY,
  ANON_SEND_RATE_PER_HOUR,
  AnonMessageRequestSchema,
  AnswerRiddleRequestSchema,
  CreateAnonThreadRequestSchema,
  SetRevealRequestSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { connectionIdsOf } from '../../lib/connections.js';
import { badRequest, conflict, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { getObjectBuffer } from '../../s3.js';
import { authed, requireAuth } from '../auth/guard.js';
import {
  anonMessageDto,
  anonThreadDto,
  fanAnonUpdated,
  isRevealed,
  loadAnonThread,
  loadLastAnonMessage,
  pushAnonMessage,
  type AnonThreadRow,
} from './service.js';

const at = schema.anonThreads;
const am = schema.anonMessages;
const IdParams = z.object({ id: z.string().uuid() });

const MessagesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Party-only thread load — anything else is one undifferentiated 404. */
async function requirePartyThread(id: string, userId: string): Promise<AnonThreadRow> {
  const row = await loadAnonThread(id);
  if (!row || (row.senderId !== userId && row.recipientId !== userId)) {
    throw notFound('not_found');
  }
  return row;
}

async function viewerThreadResponse(row: AnonThreadRow, viewerId: string) {
  const users = await db
    .select()
    .from(schema.users)
    .where(sql`${schema.users.id} IN (${row.senderId}::uuid, ${row.recipientId}::uuid)`);
  const sender = users.find((u) => u.id === row.senderId) ?? null;
  const recipient = users.find((u) => u.id === row.recipientId) ?? null;
  return { thread: anonThreadDto(row, viewerId, sender, recipient, await loadLastAnonMessage(row.id)) };
}

async function chargeSendRate(userId: string): Promise<void> {
  const rate = await fixedWindow(`anonsend:${userId}`, ANON_SEND_RATE_PER_HOUR, 3600);
  if (!rate.allowed) throw rateLimited(rate.retryAfterS);
}

async function insertAnonMessage(
  threadId: string,
  fromSender: boolean,
  body: string,
  isRiddleAnswer = false,
) {
  const [row] = await db
    .insert(am)
    .values({ id: newId(), threadId, fromSender, body, isRiddleAnswer })
    .returning();
  return row!;
}

/** The mascot-blob fallback (the §1.53 asset, square) — the blur proxy is
 * good with or without a sender avatar, and leaks nothing either way. */
function mascotPng(): Promise<Buffer> {
  const svg = Buffer.from(`<svg width="512" height="512" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg">
  <rect width="320" height="320" fill="#e7ebff"/>
  <path d="M160 52c62 0 112 44 112 106 0 64-50 110-112 110S48 222 48 158C48 96 98 52 160 52z" fill="#6f8cff"/>
  <circle cx="122" cy="150" r="20" fill="#ffffff"/>
  <circle cx="198" cy="150" r="20" fill="#ffffff"/>
  <circle cx="126" cy="154" r="9" fill="#1d2440"/>
  <circle cx="202" cy="154" r="9" fill="#1d2440"/>
  <path d="M128 208q32 26 64 0" stroke="#1d2440" stroke-width="10" stroke-linecap="round" fill="none"/>
</svg>`);
  return sharp(svg).resize(512, 512).png().toBuffer();
}

export async function anonRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.62 POST /api/anon/threads — open my open thread to user_id (201), or
  // append to it (200): ONE open thread per direction (the partial unique).
  app.post(
    '/api/anon/threads',
    { preHandler: requireAuth, schema: { body: CreateAnonThreadRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const targetId = req.body.user_id;

      // INVISIBLE refusals — every cause answers the SAME 404 (§1.62):
      // self, unknown, banned, blocked either way, 'nobody', unmet
      // 'connections'. The setting is never confirmable from outside.
      const refuse = () => notFound('anon_unavailable');
      if (targetId === user.id) throw refuse();
      const [target] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, targetId))
        .limit(1);
      if (!target || target.bannedAt !== null) throw refuse();
      if (await isBlockedPair(user.id, targetId)) throw refuse();
      if (target.anonMessages === 'nobody') throw refuse();
      if (target.anonMessages === 'connections') {
        const conns = await connectionIdsOf(targetId);
        if (!conns.has(user.id)) throw refuse();
      }

      await chargeSendRate(user.id);

      const [open] = await db
        .select()
        .from(at)
        .where(and(eq(at.senderId, user.id), eq(at.recipientId, targetId), isNull(at.revealedAt)))
        .limit(1);

      let row: AnonThreadRow;
      let created = false;
      if (open) {
        row = open;
      } else {
        // Brand-new thread: the distinct-recipient day budget (also blunts
        // delete-and-retry games — §1.62).
        const day = await fixedWindow(
          `anonnew:${user.id}:${utcDay()}`,
          ANON_NEW_THREAD_RATE_PER_DAY,
          86_400,
        );
        if (!day.allowed) throw rateLimited(day.retryAfterS);
        try {
          const [inserted] = await db
            .insert(at)
            .values({ id: newId(), senderId: user.id, recipientId: targetId })
            .returning();
          row = inserted!;
          created = true;
        } catch (err) {
          // A raced duplicate open thread: append to the winner.
          if ((err as { code?: string }).code === '23505') {
            const [raced] = await db
              .select()
              .from(at)
              .where(
                and(eq(at.senderId, user.id), eq(at.recipientId, targetId), isNull(at.revealedAt)),
              )
              .limit(1);
            if (!raced) throw err;
            row = raced;
          } else {
            throw err;
          }
        }
      }

      const msg = await insertAnonMessage(row.id, true, req.body.body);
      await fanAnonUpdated(row, msg);
      await pushAnonMessage(row, row.recipientId);
      return reply.status(created ? 201 : 200).send(await viewerThreadResponse(row, user.id));
    },
  );

  // §1.62 GET /api/anon/threads — mine (both roles), newest activity first,
  // VIEWER-STAMPED (the recipient's counterpart is null until revealed).
  app.get('/api/anon/threads', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = (await db.execute(sql`
      SELECT t.id FROM anon_threads t
      LEFT JOIN LATERAL (
        SELECT created_at FROM anon_messages
        WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1
      ) lm ON true
      WHERE t.sender_id = ${user.id} OR t.recipient_id = ${user.id}
      ORDER BY COALESCE(lm.created_at, t.created_at) DESC
      LIMIT 200
    `)) as unknown as { id: string }[];
    const threads = [];
    for (const r of rows) {
      const row = await loadAnonThread(r.id);
      if (row) threads.push((await viewerThreadResponse(row, user.id)).thread);
    }
    return { threads };
  });

  // §1.62 GET /api/anon/threads/:id/messages — created_at ASC, party-only.
  app.get(
    '/api/anon/threads/:id/messages',
    { preHandler: requireAuth, schema: { params: IdParams, querystring: MessagesQuery } },
    async (req) => {
      const { user } = authed(req);
      const row = await requirePartyThread(req.params.id, user.id);
      const conds = [eq(am.threadId, row.id)];
      if (req.query.cursor) {
        const decoded = Buffer.from(req.query.cursor, 'base64url').toString('utf8');
        const sep = decoded.lastIndexOf('|');
        if (sep === -1 || Number.isNaN(Date.parse(decoded.slice(0, sep)))) {
          throw badRequest('bad_cursor');
        }
        conds.push(
          sql`(${am.createdAt}, ${am.id}) > (${decoded.slice(0, sep)}::timestamptz, ${decoded.slice(sep + 1)}::uuid)`,
        );
      }
      const rows = await db
        .select()
        .from(am)
        .where(and(...conds))
        .orderBy(asc(am.createdAt), asc(am.id))
        .limit(req.query.limit + 1);
      const page = rows.slice(0, req.query.limit);
      const last = page[page.length - 1];
      return {
        messages: page.map(anonMessageDto),
        next_cursor:
          rows.length > req.query.limit && last
            ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`, 'utf8').toString('base64url')
            : null,
      };
    },
  );

  // §1.62 POST .../messages — either party; a block created mid-thread
  // freezes it exactly like a §1.14 DM (404, both directions, no reason).
  app.post(
    '/api/anon/threads/:id/messages',
    { preHandler: requireAuth, schema: { params: IdParams, body: AnonMessageRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requirePartyThread(req.params.id, user.id);
      if (await isBlockedPair(row.senderId, row.recipientId)) throw notFound('not_found');
      await chargeSendRate(user.id);
      const fromSender = user.id === row.senderId;
      const msg = await insertAnonMessage(row.id, fromSender, req.body.body);
      await fanAnonUpdated(row, msg);
      await pushAnonMessage(row, fromSender ? row.recipientId : row.senderId);
      return reply.status(201).send({ message: anonMessageDto(msg) });
    },
  );

  // §1.62 POST .../request-reveal — RECIPIENT only; idempotent; no timer on
  // the request and no nag for the sender.
  app.post(
    '/api/anon/threads/:id/request-reveal',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await requirePartyThread(req.params.id, user.id);
      if (user.id !== row.recipientId) throw forbidden();
      await db.execute(sql`
        UPDATE anon_threads SET reveal_requested_at = COALESCE(reveal_requested_at, now())
        WHERE id = ${row.id}
      `);
      const fresh = (await loadAnonThread(row.id))!;
      await fanAnonUpdated(fresh, null);
      return viewerThreadResponse(fresh, user.id);
    },
  );

  // §1.62 POST .../set-reveal — SENDER only; re-setting replaces (a riddle
  // may become a timer); 409 already_revealed after reveal (resolved live).
  app.post(
    '/api/anon/threads/:id/set-reveal',
    { preHandler: requireAuth, schema: { params: IdParams, body: SetRevealRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const row = await requirePartyThread(req.params.id, user.id);
      if (user.id !== row.senderId) throw forbidden();
      if (isRevealed(row)) throw conflict('already_revealed');
      if (req.body.mode === 'timer') {
        const revealAt = new Date(Date.now() + req.body.timer_s * 1000);
        await db
          .update(at)
          .set({
            revealMode: 'timer',
            revealTimerS: req.body.timer_s,
            revealAt,
            riddleQ: null,
          })
          .where(eq(at.id, row.id));
      } else {
        await db
          .update(at)
          .set({ revealMode: 'riddle', revealTimerS: null, revealAt: null, riddleQ: req.body.riddle_q })
          .where(eq(at.id, row.id));
      }
      const fresh = (await loadAnonThread(row.id))!;
      await fanAnonUpdated(fresh, null);
      return viewerThreadResponse(fresh, user.id);
    },
  );

  // §1.62 POST .../answer-riddle — RECIPIENT, riddle mode only. The answer is
  // an ordinary AnonMessage with is_riddle_answer — satisfying is the
  // SENDER's call ("that's right ✓" taps the reveal endpoint), by design.
  app.post(
    '/api/anon/threads/:id/answer-riddle',
    { preHandler: requireAuth, schema: { params: IdParams, body: AnswerRiddleRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requirePartyThread(req.params.id, user.id);
      if (user.id !== row.recipientId) throw forbidden();
      if (row.revealMode !== 'riddle') throw badRequest('not_a_riddle');
      if (isRevealed(row)) throw conflict('already_revealed');
      if (await isBlockedPair(row.senderId, row.recipientId)) throw notFound('not_found');
      await chargeSendRate(user.id);
      const msg = await insertAnonMessage(row.id, false, req.body.answer, true);
      await fanAnonUpdated(row, msg);
      await pushAnonMessage(row, row.senderId);
      return reply.status(201).send({ message: anonMessageDto(msg) });
    },
  );

  // §1.62 POST .../reveal — SENDER only, anytime (the riddle confirm AND the
  // reveal-anytime button). Idempotent; the recipient's next frame carries
  // the full counterpart UserLite.
  app.post(
    '/api/anon/threads/:id/reveal',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await requirePartyThread(req.params.id, user.id);
      if (user.id !== row.senderId) throw forbidden();
      await db.execute(sql`
        UPDATE anon_threads SET revealed_at = COALESCE(revealed_at, LEAST(COALESCE(reveal_at, now()), now()))
        WHERE id = ${row.id}
      `);
      const fresh = (await loadAnonThread(row.id))!;
      await fanAnonUpdated(fresh, null);
      return viewerThreadResponse(fresh, user.id);
    },
  );

  // §1.62 DELETE /api/anon/threads/:id — either party; HARD-deletes thread +
  // messages (no archive of a game nobody wants). Frees the open-thread slot;
  // the day budget blunts delete-and-retry.
  app.delete(
    '/api/anon/threads/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requirePartyThread(req.params.id, user.id);
      await db.delete(at).where(eq(at.id, row.id)); // messages cascade
      return reply.status(204).send();
    },
  );

  // §1.62 GET .../avatar?v=static — the thread-gated BLURRED-avatar proxy:
  // the server renders the pixels (sigma = ANON_BLUR_SIGMA_MAX × factor), so
  // the real avatar never reaches the recipient early. Pre-consent (reveal
  // mode none/riddle) it serves the MASCOT only — even max blur over real
  // pixels is reversible to identity by dictionary-matching the pipeline over
  // candidates' public avatars. Static ONLY (motion identifies). Short
  // private cache — the blur must keep moving.
  app.get(
    '/api/anon/threads/:id/avatar',
    {
      preHandler: requireAuth,
      schema: { params: IdParams, querystring: z.object({ v: z.string().optional() }) },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requirePartyThread(req.params.id, user.id);

      // factor: 1 under none/riddle, the live countdown under a timer, 0 once
      // revealed — clamp((reveal_at − now) / reveal_timer_s, 0, 1).
      let factor = 1;
      if (isRevealed(row)) factor = 0;
      else if (row.revealMode === 'timer' && row.revealAt && row.revealTimerS) {
        factor = Math.min(
          1,
          Math.max(0, (row.revealAt.getTime() - Date.now()) / (row.revealTimerS * 1000)),
        );
      }

      // Sender identity must be absent from every recipient-reachable byte
      // until the sender CONSENTS to a reveal mechanism: a max-blurred real
      // avatar is dictionary-matchable (re-run resize→blur→jpeg over candidate
      // avatars), so under reveal_mode 'none'/'riddle' the proxy serves the
      // MASCOT, never real pixels. Real pixels enter the pipeline only once a
      // timer is running (the sender picked it — un-blurring is the game) or
      // the thread is revealed.
      const senderConsented =
        isRevealed(row) || (row.revealMode === 'timer' && row.revealAt !== null);

      let source: Buffer | null = null;
      if (senderConsented) {
        const [sender] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, row.senderId))
          .limit(1);
        if (sender && sender.avatarStatus === 'ready' && sender.avatarStaticKey) {
          try {
            source = await getObjectBuffer(sender.avatarStaticKey);
          } catch {
            source = null; // storage hiccup → the mascot keeps the game good
          }
        }
      }
      if (!source) source = await mascotPng();

      const sigma = ANON_BLUR_SIGMA_MAX * factor;
      let pipeline = sharp(source).resize(512, 512, { fit: 'cover' });
      if (sigma >= 0.3) pipeline = pipeline.blur(sigma);
      const out = await pipeline.jpeg({ quality: 82 }).toBuffer();

      reply.header('cache-control', `private, max-age=${ANON_AVATAR_CACHE_TTL_S}`);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-type', 'image/jpeg');
      reply.header('content-length', String(out.length));
      return reply.send(out);
    },
  );
}
