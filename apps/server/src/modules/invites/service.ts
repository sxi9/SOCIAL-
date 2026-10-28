// Invite links (v0.2 — API.md §1.11, ARCHITECTURE §9, ADR-007).
// Tokens are 32 random bytes base64url stored PLAINTEXT (the owner list must
// re-display /join/<token>; a token is a revocable capability, not a
// credential). `status` is DERIVED, precedence revoked > expired > exhausted >
// valid. Accepts go through one atomic guarded UPDATE so concurrency can never
// over-redeem, and reuse the existing join machinery verbatim: dm_key dedupe,
// join_seq = last_seq history floor, an `invite_joined` system message,
// conv.new/conv.updated fan-out over the Redis `events` channel.
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  CHANNEL_MAX,
  INVITE_TOKEN_BYTES,
  MAX_GROUP_PARTICIPANTS,
  type InviteKind,
  type InvitePrivate,
  type InvitePublic,
  type InviteStatus,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { isBannedFrom } from '../../lib/bans.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { assignMasksTx } from '../../lib/ghost.js';
import {
  activeParticipantUserIds,
  publishConversationToUsers,
  type UserRow,
} from '../../lib/dto.js';
import { ApiError, badRequest, notFound } from '../../lib/errors.js';
import { invitesEnabled } from '../admin/service.js';
import { sendSystemMessage } from '../messages/service.js';

export type InviteRow = typeof schema.invites.$inferSelect;

// The open-invite mint cap now lives in @socialchat/shared as INVITE_OPEN_MAX
// (API.md §1.11); routes.ts imports it from there.

const convs = schema.conversations;
const cp = schema.conversationParticipants;

export function newInviteToken(): string {
  // Same generator as session tokens: 32 random bytes base64url = 43 chars,
  // which INVITE_TOKEN_REGEX accepts (ADR-007).
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
}

/** Derived status — precedence revoked > expired > exhausted > valid. */
export function inviteStatus(row: InviteRow): InviteStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  if (row.useCount >= row.maxUses) return 'exhausted';
  return 'valid';
}

export function invitePrivateDto(row: InviteRow, kind?: InviteKind): InvitePrivate {
  return {
    id: row.id,
    token: row.token,
    // App-origin PATH — web prefixes window.location.origin when copying.
    url: `/join/${row.token}`,
    // v0.5a (§1.35): 'channel' when the scoped conversation is one — callers
    // that know the conversation type pass it; the fallback keeps v0.2 shape.
    kind: kind ?? (row.conversationId ? 'group' : 'dm'),
    conversation_id: row.conversationId,
    status: inviteStatus(row),
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    max_uses: row.maxUses,
    use_count: row.useCount,
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/**
 * The UNAUTHENTICATED /join/<token> view. Avatar URLs point at the token-gated
 * proxy GET /api/invites/:token/avatar — NEVER /api/media/:key — and are null
 * unless status === 'valid' AND the inviter's avatar is 'ready' (revoking an
 * invite instantly kills its avatar proxy). `ver` is a cache-buster the proxy
 * accepts and ignores.
 */
export function invitePublicDto(
  row: InviteRow,
  inviter: UserRow,
  groupTitle: string | null,
  kind?: InviteKind,
  // Phase 2: the group card (routes.ts builds it for kind 'group', non-ghost).
  group: InvitePublic['group'] = null,
): InvitePublic {
  const status = inviteStatus(row);
  const servable =
    status === 'valid' && inviter.avatarStatus === 'ready' && inviter.avatarStaticKey !== null;
  const base = `/api/invites/${row.token}/avatar`;
  const ver = inviter.avatarVersion;
  return {
    status,
    kind: kind ?? (row.conversationId ? 'group' : 'dm'),
    // §1.35: group_title is non-null for group AND channel kinds (the field
    // name is kept stable for old clients).
    group_title: row.conversationId ? groupTitle : null,
    inviter: {
      username: inviter.username,
      display_name: inviter.displayName,
      avatar: {
        status: inviter.avatarStatus as InvitePublic['inviter']['avatar']['status'],
        version: ver,
        // v=animated falls back to the static JPEG server-side when no
        // animated rendition exists, so both URLs are emitted together.
        static_url: servable ? `${base}?v=static&ver=${ver}` : null,
        animated_url: servable ? `${base}?v=animated&ver=${ver}` : null,
      },
    },
    expires_at: row.expiresAt.toISOString(),
    // Phase 2: both only while valid — a dead link names nothing joinable.
    conversation_id: status === 'valid' ? row.conversationId : null,
    group: status === 'valid' ? group : null,
  };
}

export async function findInviteByToken(token: string): Promise<InviteRow | null> {
  const [row] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.token, token))
    .limit(1);
  return row ?? null;
}

/**
 * The atomic redemption guard (API.md §1.11): zero rows = not acceptable.
 * Concurrent accepts can never push use_count past max_uses.
 */
async function claimUse(inviteId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    UPDATE invites SET use_count = use_count + 1
    WHERE id = ${inviteId}
      AND revoked_at IS NULL
      AND expires_at > now()
      AND use_count < max_uses
    RETURNING id
  `)) as unknown as { id: string }[];
  return rows.length > 0;
}

function goneByStatus(status: InviteStatus): ApiError {
  // 410 invite_expired | invite_exhausted | invite_revoked (API.md §1.11).
  return new ApiError(410, status === 'valid' ? 'invite_exhausted' : `invite_${status}`);
}

/** The claim failed — re-read and answer with the precise derived status. */
async function refuseClaim(inviteId: string): Promise<never> {
  const [fresh] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.id, inviteId))
    .limit(1);
  if (!fresh) throw notFound('invite_not_found');
  throw goneByStatus(inviteStatus(fresh));
}

/**
 * The §1.4-style join upsert, shared by the group accept and the DM
 * reactivation so their semantics can never drift: join_seq = last_seq (the
 * history floor), role 'member', watermarks start at the floor; a departed
 * member re-joining gets a fresh window (left_at / left_seq cleared).
 */
async function upsertParticipantJoin(
  convId: string,
  userId: string,
  joinSeq: number,
): Promise<void> {
  // ISO string, not a Date instance: raw db.execute params are passed through
  // to postgres-js untyped, and it cannot serialize Dates.
  const nowIso = new Date().toISOString();
  await db.execute(sql`
    INSERT INTO conversation_participants
      (conversation_id, user_id, role, joined_at, join_seq, left_at, last_delivered_seq, last_read_seq)
    VALUES (${convId}, ${userId}, 'member', ${nowIso}::timestamptz, ${joinSeq}::bigint, NULL, ${joinSeq}::bigint, ${joinSeq}::bigint)
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET
      role = 'member',
      joined_at = ${nowIso}::timestamptz,
      join_seq = ${joinSeq}::bigint,
      left_at = NULL,
      left_seq = NULL,
      last_delivered_seq = GREATEST(conversation_participants.last_delivered_seq, ${joinSeq}::bigint),
      last_read_seq = GREATEST(conversation_participants.last_read_seq, ${joinSeq}::bigint)
  `);
}

async function fanOutJoin(convId: string, joinerId: string, existingMemberIds: string[]): Promise<void> {
  // Mirrors §1.4: conv.new to the joiner, conv.updated to members — all via
  // the Redis `events` channel, per-recipient clamped (§1.13/§1.14).
  await publishConversationToUsers(convId, existingMemberIds, 'conv.updated');
  await publishConversationToUsers(convId, [joinerId], 'conv.new');
}

/**
 * Accept an invite for `joinerId` — the shared flow behind
 * POST /api/invites/:token/accept AND register-with-token (the caller decides
 * whether failures surface as HTTP errors or degrade to `invite: null`).
 *
 * Idempotent re-accept: already an ACTIVE participant (or an active party of
 * the existing DM) → the conversation id WITHOUT incrementing use_count and
 * without a system message. That dedupe resolves BEFORE status validation, so
 * it answers even on an expired/revoked/exhausted invite. A re-join after
 * leaving — DM and group alike — is a genuinely-new join: it status-gates
 * (the token stays a revocable capability, ADR-007) and claims a use before
 * the §1.4 re-join upsert (left_at/left_seq cleared, fresh join_seq floor).
 */
export async function acceptInvite(
  invite: InviteRow,
  joinerId: string,
): Promise<{ conversation_id: string }> {
  if (invite.inviterId === joinerId) throw badRequest('invite_own');

  // v0.5b (§1.41): instance-wide invite switch — accepts refuse 403 with NO
  // use_count claim; register-with-token degrades to invite: null (§1.1,
  // the caller's catch). GET /:token/public still renders — the join page
  // explains on accept.
  if (!(await invitesEnabled())) throw new ApiError(403, 'invites_disabled');

  // §1.14: an invite whose inviter is blocked w.r.t. the joiner reads as
  // nonexistent — 404-shaped, both directions, before any use is claimed.
  if (await isBlockedPair(invite.inviterId, joinerId)) throw notFound('invite_not_found');

  // §1.13 invites_paused: accepts of a paused inviter's invites 403 with no
  // use_count claim (register-with-token degrades to invite: null in §1.1).
  const [inviter] = await db
    .select({ invitesPaused: schema.users.invitesPaused })
    .from(schema.users)
    .where(eq(schema.users.id, invite.inviterId))
    .limit(1);
  if (inviter?.invitesPaused) throw new ApiError(403, 'invites_paused');

  if (invite.conversationId === null) {
    // DM-with-inviter invite: create-or-dedupe via dm_key, exactly like
    // POST /api/conversations {type:'dm'}. The dedupe resolves BEFORE status
    // validation (§1.11): when the DM already exists the accept answers
    // 200 {conversation_id} without consuming a use — even on an invite that
    // has since expired / been revoked / exhausted.
    const dmKey = [invite.inviterId, joinerId].sort().join(':');
    const [existing] = await db.select().from(convs).where(eq(convs.dmKey, dmKey)).limit(1);
    if (existing) {
      const [myPart] = await db
        .select()
        .from(cp)
        .where(and(eq(cp.conversationId, existing.id), eq(cp.userId, joinerId)))
        .limit(1);
      // Still an ACTIVE party of the DM → idempotent 200 BEFORE status
      // validation, no use consumed — even on a dead invite (§1.11).
      if (myPart && myPart.leftAt === null) {
        return { conversation_id: existing.id }; // idempotent, no increment
      }
      // The joiner had LEFT the DM (handing back the bare id would strand
      // them on 404 conversation_not_found). A re-join after leaving is a
      // genuinely-new join, exactly like the group path below: the invite
      // must still be redeemable — a revoked/expired/exhausted token must NOT
      // remain a permanent re-entry capability for an ex-member (ADR-007:
      // the token is a revocable capability) — and a use is claimed. Then
      // the same §1.4 re-join upsert reactivates them (fresh join_seq =
      // last_seq history floor, left_at / left_seq cleared) and the usual
      // join machinery re-announces the conversation.
      const dmStatus = inviteStatus(invite);
      if (dmStatus !== 'valid') throw goneByStatus(dmStatus);
      if (!(await claimUse(invite.id))) await refuseClaim(invite.id);
      await upsertParticipantJoin(existing.id, joinerId, existing.lastSeq);
      await sendSystemMessage(existing.id, 'invite_joined', 'joined via invite', joinerId, invite.inviterId);
      await fanOutJoin(existing.id, joinerId, [invite.inviterId]);
      return { conversation_id: existing.id };
    }

    // Genuinely-new DM: only now does invite status gate the join.
    const status = inviteStatus(invite);
    if (status !== 'valid') throw goneByStatus(status);

    if (!(await claimUse(invite.id))) await refuseClaim(invite.id);

    const convId = newId();
    try {
      await db.transaction(async (tx) => {
        await tx
          .insert(convs)
          .values({ id: convId, type: 'dm', dmKey, createdBy: invite.inviterId });
        await tx.insert(cp).values([
          { conversationId: convId, userId: invite.inviterId },
          { conversationId: convId, userId: joinerId },
        ]);
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // dm_key race: another create won — converge on it (idempotent).
        const [raced] = await db.select().from(convs).where(eq(convs.dmKey, dmKey)).limit(1);
        if (raced) return { conversation_id: raced.id };
      }
      throw err;
    }
    await sendSystemMessage(convId, 'invite_joined', 'joined via invite', joinerId, invite.inviterId);
    await fanOutJoin(convId, joinerId, [invite.inviterId]);
    return { conversation_id: convId };
  }

  // Group / channel invite (v0.5a §1.35: channels join through this exact
  // flow — the invite page carries the pitch, join_seq = last_seq keeps the
  // standard history floor).
  const [conv] = await db.select().from(convs).where(eq(convs.id, invite.conversationId)).limit(1);
  // The FK cascades invites away with their group; defensive all the same.
  if (!conv) throw notFound('invite_not_found');

  const [myPart] = await db
    .select()
    .from(cp)
    .where(and(eq(cp.conversationId, conv.id), eq(cp.userId, joinerId)))
    .limit(1);
  // Already an ACTIVE member → idempotent 200 BEFORE status validation and
  // without consuming a use (§1.11) — even on a dead invite.
  if (myPart && myPart.leftAt === null) return { conversation_id: conv.id }; // idempotent

  // §2.5 (migration 0016): a member an admin removed is banned — the link
  // answers exactly what a blocked pair gets, and never burns a use.
  if (await isBannedFrom(conv.id, joinerId)) throw notFound('invite_not_found');

  // Genuinely-new join (first join, or a re-join after leaving): invite
  // status gates it, then the cap, then the atomic claim.
  const status = inviteStatus(invite);
  if (status !== 'valid') throw goneByStatus(status);

  const existingActive = await activeParticipantUserIds(conv.id);
  if (conv.type === 'channel') {
    // §1.35: invite accept at the cap → 400 channel_full (watermark receipts
    // make 10k safe — ADR-002; the cap is the route's guard, not the DB's).
    if (existingActive.length + 1 > CHANNEL_MAX) throw badRequest('channel_full');
  } else if (existingActive.length + 1 > MAX_GROUP_PARTICIPANTS) {
    throw badRequest('group_too_large');
  }

  if (!(await claimUse(invite.id))) await refuseClaim(invite.id);

  // Same upsert as the §1.4 add-participants path (see upsertParticipantJoin).
  await upsertParticipantJoin(conv.id, joinerId, conv.lastSeq);
  // v0.8b (§1.68): joining a 👻 ghost group auto-assigns a mask from the
  // GHOST_MASK_* pools (re-pickable via PUT …/mask) — invites are the only
  // door into a ghost group, so this is THE join-time hook.
  if (conv.visibility === 'ghost') {
    await assignMasksTx(db, conv.id, [joinerId]);
  }
  // §1.35: membership is NEVER exposed to the channel member body (no list,
  // no count) — so a channel join posts NO `invite_joined` system message.
  // The message would land on the seq log: msg.new to all 10k members, an
  // unread bump for every one of them, and a membership announcement the DTO
  // deliberately withholds. Owner/admins learn of the join through the
  // restricted conv.updated below (their DTO carries the participant frame).
  if (conv.type !== 'channel') {
    await sendSystemMessage(conv.id, 'invite_joined', 'joined via invite', joinerId, invite.inviterId);
  }
  // §1.35: channel membership frames never fan to the member body (no list,
  // no count) — owner/admins + the joiner only; groups keep §1.4 fan-out.
  if (conv.type === 'channel') {
    const privileged = (await db.execute(sql`
      SELECT user_id FROM conversation_participants
      WHERE conversation_id = ${conv.id} AND left_at IS NULL AND role IN ('owner','admin')
    `)) as unknown as { user_id: string }[];
    await fanOutJoin(conv.id, joinerId, privileged.map((r) => r.user_id));
  } else {
    await fanOutJoin(conv.id, joinerId, existingActive);
  }
  return { conversation_id: conv.id };
}
