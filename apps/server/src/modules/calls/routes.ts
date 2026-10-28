// v0.6 calls — the REST half (API.md §1.42, ADR-014): durable lifecycle
// writes (create / join / end / reject), the call log read, and TURN
// credential minting. The live half (SDP/ICE relays, ringing UX) is §2.12 in
// the WS gateway; these routes never carry signaling.
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CALL_LINK_JOIN_RATE_PER_HOUR,
  CALL_RING_TIMEOUT_S,
  CALL_SELFTEST_RATE_PER_HOUR,
  CreateCallLinkRequestSchema,
  CreateCallRequestSchema,
  MAX_GROUP_PARTICIPANTS,
  SHARE_TOKEN_REGEX,
  EndCallRequestSchema,
  TurnCredentialsQuerySchema,
} from '@socialchat/shared';
import { ApiError, badRequest, conflict, gone, notFound, rateLimited } from '../../lib/errors.js';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { allAccepted } from '../../lib/dmPolicy.js';
import { activeParticipantUserIds, ghostCtxFor } from '../../lib/dto.js';
import { pseudoIdFor } from '../../lib/ghost.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { mintSelftestTurnCredentials, mintTurnCredentials } from '../../lib/turn.js';
import { config } from '../../config.js';
import { enqueueCallRingTimeout } from '../../queues.js';
import { redis } from '../../redis.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant, requireActiveParticipant } from '../conversations/routes.js';
import { joinGroupTx } from '../conversations/visibility.js';
import { isBannedFrom } from '../../lib/bans.js';
import { publishConversationToUsers } from '../../lib/dto.js';
import { loadOpenTokenByToken, mintOrReturnToken, shareLinkDto } from '../sharepages/service.js';
import { forbidden } from '../../lib/errors.js';
import {
  addCallMember,
  callDto,
  callMemberIds,
  callMembersKey,
  deleteCallMembers,
  enqueueCallRingPushes,
  isCallMember,
  isLiveStatus,
  loadCall,
  publishCallUpdated,
  removeCallMember,
  runMissedCall,
  stopCallRing,
  type CallRow, roomLinkStanding } from './service.js';

const IdParams = z.object({ id: z.string().uuid() });
// §1.42: 20/hour/user, the CONVERSATION_CREATE_RATE_PER_HOUR-style window.
const CALL_CREATE_RATE_PER_HOUR = 20;

const calls = schema.calls;
const convs = schema.conversations;

/**
 * The §1.42 authorization anchor, 404-shaped per §1.14: the caller must be an
 * active participant of the call's conversation, and a frozen DM (blocked
 * pair) answers exactly like an unknown call.
 */
async function requireCallAccess(callId: string, userId: string): Promise<CallRow> {
  const call = await loadCall(callId);
  if (!call) throw notFound('not_found');
  await requireCallConversationAccess(call.conversationId, userId);
  return call;
}

async function requireCallConversationAccess(convId: string, userId: string): Promise<void> {
  const part = await requireActiveParticipant(convId, userId).catch(() => null);
  if (!part) throw notFound('not_found');
  const [conv] = await db
    .select({ type: convs.type })
    .from(convs)
    .where(eq(convs.id, convId))
    .limit(1);
  if (!conv) throw notFound('not_found');
  if (conv.type === 'dm') {
    const peer = (await activeParticipantUserIds(convId)).find((id) => id !== userId);
    if (peer && (await isBlockedPair(userId, peer))) throw notFound('not_found');
  }
}

export async function callRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Phase 5 (AUDIT-PLAN §1b, migration 0019) POST /api/calls/links — the room
  // link of a LIVE group call I am in: mint-or-return the call's ONE open
  // share token (type 'call'; the same token POST /api/share-links mints).
  // DM calls take no third person → 400 not_public. Dies with the call.
  app.post(
    '/api/calls/links',
    { preHandler: requireAuth, schema: { body: CreateCallLinkRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const call = await loadCall(req.body.call_id);
      if (!call || !isLiveStatus(call.status)) throw notFound('not_found');
      if (!(await isCallMember(call.id, user.id))) throw notFound('not_found');
      const standing = await roomLinkStanding(call, user.id);
      if (standing === 'not_member') throw notFound('not_found');
      if (standing === 'not_group') throw badRequest('not_public');
      if (standing === 'admin_required') throw forbidden();
      const row = await mintOrReturnToken('call', call.id, user.id, 'full');
      // The mint and the last hang-up can race: a token for an ended call
      // would otherwise live forever (deleteCallMembers already ran).
      const fresh = await loadCall(call.id);
      if (!fresh || !isLiveStatus(fresh.status)) {
        await deleteCallMembers(call.id);
        throw notFound('not_found');
      }
      return { share_link: shareLinkDto(row) };
    },
  );

  // Phase 5 POST /api/calls/links/:token/join — AUTHED: join the GROUP
  // through the room link (the token is the invite), then the client lands
  // on /c/<conversation_id>?call=<call_id> and the ordinary §1.42 join runs
  // (mesh cap → 409 call_full there). 404 share_not_found for an unknown /
  // revoked token, an ended call, a ghost group, a banned joiner or a
  // blocked pair with the inviter — one shape. Already a member → straight
  // through. Rate CALL_LINK_JOIN_RATE_PER_HOUR.
  app.post(
    '/api/calls/links/:token/join',
    { preHandler: requireAuth, schema: { params: z.object({ token: z.string().min(1).max(256) }) } },
    async (req) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`calllinkjoin:${user.id}`, CALL_LINK_JOIN_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      if (!SHARE_TOKEN_REGEX.test(req.params.token)) throw notFound('share_not_found');
      const tok = await loadOpenTokenByToken(req.params.token);
      if (!tok || tok.objectType !== 'call') throw notFound('share_not_found');
      const call = await loadCall(tok.objectId);
      if (!call || !isLiveStatus(call.status) || !call.isGroup) throw notFound('share_not_found');
      const [conv] = await db.select().from(convs).where(eq(convs.id, call.conversationId)).limit(1);
      if (!conv || conv.type !== 'group' || conv.visibility === 'ghost') throw notFound('share_not_found');
      // The inviter must still stand where they stood at mint: alive,
      // unbanned, in the group (and its admin for a private group) — the
      // public page already 404s on the first two; the door must agree.
      if (!tok.createdBy) throw notFound('share_not_found');
      const [inviter] = await db.select({ bannedAt: schema.users.bannedAt, deletedAt: schema.users.deletedAt }).from(schema.users).where(eq(schema.users.id, tok.createdBy)).limit(1);
      if (!inviter || inviter.bannedAt !== null || inviter.deletedAt !== null) throw notFound('share_not_found');
      if ((await roomLinkStanding(call, tok.createdBy)) !== 'ok') throw notFound('share_not_found');
      if (await isBlockedPair(user.id, tok.createdBy)) throw notFound('share_not_found');
      const mine = await getParticipant(conv.id, user.id);
      if (!mine || mine.leftAt !== null) {
        if (await isBannedFrom(conv.id, user.id)) throw notFound('share_not_found');
        const active = await activeParticipantUserIds(conv.id);
        if (active.length + 1 > MAX_GROUP_PARTICIPANTS) throw badRequest('group_too_large');
        await joinGroupTx(conv.id, user.id);
        await publishConversationToUsers(conv.id, [user.id], 'conv.new');
        await publishConversationToUsers(conv.id, active, 'conv.updated');
      }
      return { conversation_id: conv.id, call_id: call.id, kind: call.kind as 'audio' | 'video' };
    },
  );

  // §1.42 POST /api/conversations/:id/calls — start ringing. The row insert
  // claims the one-live-call-per-conversation slot atomically (calls_live_idx,
  // the dm_key pattern); the initiator then sends the WS call.invite frame.
  app.post(
    '/api/conversations/:id/calls',
    { preHandler: requireAuth, schema: { params: IdParams, body: CreateCallRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      await requireActiveParticipant(req.params.id, user.id);
      const [conv] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
      if (!conv) throw notFound('conversation_not_found');
      // Calls exist for dm + group only (§1.42).
      if (conv.type === 'channel') throw badRequest('call_bad_conversation');
      // v0.8b (§1.68): no calls in 👻 ghost groups — the call DTO and the
      // §2.12 signaling frames carry REAL user ids (before anyone accepts),
      // which would link every member's real uuid to the conversation. Masks
      // never ring.
      if (conv.visibility === 'ghost') throw badRequest('call_bad_conversation');
      // §1.14: a frozen DM cannot be called into — 404-shaped.
      if (conv.type === 'dm') {
        const peer = (await activeParticipantUserIds(req.params.id)).find((id) => id !== user.id);
        if (peer && (await isBlockedPair(user.id, peer))) throw notFound('conversation_not_found');
        // Wave 1.7: a parked request cannot be rung into — same 404 shape.
        if (!(await allAccepted(req.params.id))) throw notFound('conversation_not_found');
      }
      const rate = await fixedWindow(`callcreate:${user.id}`, CALL_CREATE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const callId = newId();
      let row: CallRow;
      try {
        const [inserted] = await db
          .insert(calls)
          .values({
            id: callId,
            conversationId: req.params.id,
            initiatorId: user.id,
            kind: req.body.kind,
            isGroup: conv.type === 'group',
            status: 'ringing',
          })
          .returning();
        row = inserted!;
      } catch (err) {
        // calls_live_idx: one live call per conversation → join it instead.
        if ((err as { code?: string }).code === '23505') throw conflict('call_active');
        throw err;
      }

      await redis.sadd(callMembersKey(callId), user.id);
      await enqueueCallRingTimeout(callId, CALL_RING_TIMEOUT_S * 1000);
      await publishCallUpdated(row);
      // v0.7.1 (§1.55/§2.9): ring pushes for every callee with no live socket.
      await enqueueCallRingPushes(row);
      return reply
        .status(201)
        .send({ call: callDto(row, [user.id]), turn: mintTurnCredentials(user.id) });
    },
  );

  // §1.42 POST /api/calls/:id/join — the DM accept and the group join are the
  // same durable transition. The mesh cap is enforced by the atomic Redis
  // check-and-add BEFORE the status flip, so a full mesh never goes ongoing
  // for the ninth head.
  app.post(
    '/api/calls/:id/join',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      let call = await requireCallAccess(req.params.id, user.id);
      if (!isLiveStatus(call.status)) throw gone('call_ended');

      const added = await addCallMember(call.id, user.id);
      if (added === 'full') throw conflict('call_full');
      if (added === 'already_member') {
        // Idempotent re-join: 200, no event (§1.42).
        const members = await callMemberIds(call);
        return reply
          .status(200)
          .send({ call: callDto(call, members), turn: mintTurnCredentials(user.id) });
      }

      if (call.status === 'ringing') {
        // First join: guarded flip (a raced timeout/reject wins and the
        // re-read below answers 410).
        await db.execute(sql`
          UPDATE calls SET status = 'ongoing', answered_at = now()
          WHERE id = ${call.id} AND status = 'ringing'
        `);
      }
      const fresh = await loadCall(call.id);
      if (!fresh || !isLiveStatus(fresh.status)) {
        // The ring resolved under us (timeout/reject): undo the member add.
        await removeCallMember(call.id, user.id);
        if (fresh && !isLiveStatus(fresh.status)) await deleteCallMembers(call.id);
        throw gone('call_ended');
      }
      // v0.7.1 (§1.55/§2.9): the call is HANDLED — retract every ring push
      // (answered-elsewhere lock screens go quiet). Idempotent; runs on the
      // ringing→ongoing transition and is a no-op for later group joins.
      if (call.status === 'ringing') await stopCallRing(call.id);
      call = fresh;
      await publishCallUpdated(call);
      const members = await callMemberIds(call);
      return reply
        .status(200)
        .send({ call: callDto(call, members), turn: mintTurnCredentials(user.id) });
    },
  );

  // §1.42 POST /api/calls/:id/end — hang up (the durable record; the WS
  // call.leave/call.end frames are the instant signals).
  app.post(
    '/api/calls/:id/end',
    { preHandler: requireAuth, schema: { params: IdParams, body: EndCallRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const call = await requireCallAccess(req.params.id, user.id);

      // Idempotent on terminal calls → 200 (§1.42).
      if (!isLiveStatus(call.status)) {
        return reply.status(200).send({ call: callDto(call, []) });
      }

      if (call.status === 'ringing') {
        // Cancel-before-answer, initiator only: reads as missed for callees —
        // the full §1.42 missed-call machinery runs (system message + push).
        if (call.initiatorId !== user.id) throw badRequest('call_bad_end');
        await runMissedCall(call.id);
        const fresh = await loadCall(call.id);
        return reply.status(200).send({ call: callDto(fresh ?? call, []) });
      }

      // ongoing: remove me from the mesh; ≤ 1 live member left ends the call.
      if (!(await isCallMember(call.id, user.id))) throw badRequest('call_not_member');
      const remaining = await removeCallMember(call.id, user.id);
      if (remaining <= 1) {
        const status = req.body.reason === 'failed' ? 'failed' : 'completed';
        await db.execute(sql`
          UPDATE calls SET status = ${status}, ended_at = now()
          WHERE id = ${call.id} AND status = 'ongoing'
        `);
        await deleteCallMembers(call.id);
      }
      const fresh = (await loadCall(call.id)) ?? call;
      await publishCallUpdated(fresh);
      const members = await callMemberIds(fresh);
      return reply.status(200).send({ call: callDto(fresh, members) });
    },
  );

  // §1.42 POST /api/calls/:id/reject — DM callee only, while ringing. In
  // groups a decline is personal and ephemeral (the WS call.reject frame is
  // all there is) → 400 call_bad_reject.
  app.post(
    '/api/calls/:id/reject',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const call = await requireCallAccess(req.params.id, user.id);
      if (call.isGroup) throw badRequest('call_bad_reject');
      if (call.initiatorId === user.id) throw badRequest('call_bad_reject');

      if (call.status === 'rejected') {
        return reply.status(200).send({ call: callDto(call, []) });
      }
      if (!isLiveStatus(call.status) || call.status === 'ongoing') throw gone('call_ended');

      const rows = (await db.execute(sql`
        UPDATE calls SET status = 'rejected', ended_at = now()
        WHERE id = ${call.id} AND status = 'ringing'
        RETURNING id
      `)) as unknown as { id: string }[];
      if (rows.length === 0) {
        const fresh = (await loadCall(call.id)) ?? call;
        if (fresh.status === 'rejected') return reply.status(200).send({ call: callDto(fresh, []) });
        throw gone('call_ended');
      }
      await deleteCallMembers(call.id);
      // v0.7.1 (§1.55/§2.9): a DM decline is "handled anywhere" — retract the
      // ring push on every device that got one.
      await stopCallRing(call.id);
      const fresh = (await loadCall(call.id)) ?? call;
      // No system message: a decline is not an archive entry (liking gap).
      await publishCallUpdated(fresh);
      return reply.status(200).send({ call: callDto(fresh, []) });
    },
  );

  // §1.42 GET /api/conversations/:id/calls — the call log, started_at DESC.
  app.get(
    '/api/conversations/:id/calls',
    {
      preHandler: requireAuth,
      schema: {
        params: IdParams,
        querystring: z.object({
          before: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (req) => {
      const { user } = authed(req);
      await requireActiveParticipant(req.params.id, user.id);
      // v0.8b (§1.68): the call LOG is durable history — pre-switch calls in a
      // now-👻 conversation carry real user ids, so non-admin members read
      // them pseudo-id-masked (own id stays real).
      const [convRow] = await db
        .select({ id: convs.id, visibility: convs.visibility })
        .from(convs)
        .where(eq(convs.id, req.params.id))
        .limit(1);
      if (!convRow) throw notFound('not_found');
      const ghost = await ghostCtxFor(convRow, user.id);
      const maskId = (id: string | null): string | null =>
        ghost && !ghost.viewerIsAdmin && id && id !== user.id
          ? pseudoIdFor(convRow.id, id)
          : id;

      const conditions = [sql`${calls.conversationId} = ${req.params.id}`];
      if (req.query.before) {
        const decoded = Buffer.from(req.query.before, 'base64url').toString('utf8');
        const sep = decoded.lastIndexOf('|');
        if (sep === -1) throw badRequest('bad_cursor');
        const ts = decoded.slice(0, sep);
        const id = decoded.slice(sep + 1);
        if (Number.isNaN(Date.parse(ts)) || !z.string().uuid().safeParse(id).success) {
          throw badRequest('bad_cursor');
        }
        conditions.push(
          sql`(${calls.startedAt}, ${calls.id}) < (${ts}::timestamptz, ${id}::uuid)`,
        );
      }
      const rows = await db
        .select()
        .from(calls)
        .where(sql.join(conditions, sql` AND `))
        .orderBy(sql`${calls.startedAt} DESC`, sql`${calls.id} DESC`)
        .limit(req.query.limit);

      const dtos = [];
      for (const row of rows) {
        const dto = callDto(row, await callMemberIds(row));
        if (ghost && !ghost.viewerIsAdmin) {
          dto.initiator_id = maskId(dto.initiator_id);
          dto.participant_ids = dto.participant_ids.map((id) => maskId(id) ?? id);
        }
        dtos.push(dto);
      }
      let nextCursor: string | null = null;
      if (rows.length === req.query.limit) {
        const last = rows[rows.length - 1]!;
        nextCursor = Buffer.from(
          `${last.startedAt.toISOString()}|${last.id}`,
          'utf8',
        ).toString('base64url');
      }
      return { calls: dtos, next_cursor: nextCursor };
    },
  );

  // §1.42 GET /api/turn-credentials?call_id= — participant-gated fresh mint
  // (long calls refresh before expiry and setConfiguration the peers).
  app.get(
    '/api/turn-credentials',
    { preHandler: requireAuth, schema: { querystring: TurnCredentialsQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      if (!config.turnSecret) throw new ApiError(503, 'turn_unconfigured');
      const call = await requireCallAccess(req.query.call_id, user.id);
      if (!isLiveStatus(call.status)) throw notFound('not_found');
      const turn = mintTurnCredentials(user.id);
      if (!turn) throw new ApiError(503, 'turn_unconfigured');
      return { turn };
    },
  );

  // §1.55 GET /api/call-selftest (v0.7.1, ADR-017) — the ONE authed read of
  // the instance's TURN state, consumed by Settings → Call self-test, the
  // pre-dial caller warning, and the admin panel. Participant-FREE by design
  // (the point is finding out BEFORE a call fails) but authed + rate-limited,
  // so the relay cannot be farmed anonymously. turn_configured mirrors
  // TURN_SECRET; when configured, `turn` carries SHORT-lived probe creds
  // (username "<expiry>:selftest:<user_id>") for the client's relay gather —
  // reachability itself is judged CLIENT-side (only the browser can test the
  // UDP path from where the user sits). Unconfigured → turn: null, never 503:
  // "no relay" is this endpoint's honest ANSWER, not an error.
  app.get('/api/call-selftest', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rate = await fixedWindow(`callselftest:${user.id}`, CALL_SELFTEST_RATE_PER_HOUR, 3600);
    if (!rate.allowed) throw rateLimited(rate.retryAfterS);
    const turn = mintSelftestTurnCredentials(user.id);
    return { turn_configured: config.turnSecret !== null, turn };
  });
}
