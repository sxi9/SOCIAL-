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
  INVITE_TOKEN_BYTES,
  MAX_GROUP_PARTICIPANTS,
  type InvitePrivate,
  type InvitePublic,
  type InviteStatus,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import {
  activeParticipantUserIds,
  loadConversationDto,
  type UserRow,
} from '../../lib/dto.js';
import { ApiError, badRequest, notFound } from '../../lib/errors.js';
import { publishToUsers } from '../../ws/events.js';
import { sendSystemMessage } from '../messages/service.js';

export type InviteRow = typeof schema.invites.$inferSelect;

// A user may hold at most this many simultaneously OPEN (status 'valid')
// invites — mint past it → 409 invite_limit. Server-local policy knob (not a
// protocol constant in @socialchat/shared): clients only ever see the error.
export const INVITE_OPEN_MAX = 20;

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

export function invitePrivateDto(row: InviteRow): InvitePrivate {
  return {
    id: row.id,
    token: row.token,
    // App-origin PATH — web prefixes window.location.origin when copying.
    url: `/join/${row.token}`,
    kind: row.conversationId ? 'group' : 'dm',
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
): InvitePublic {
  const status = inviteStatus(row);
  const servable =
    status === 'valid' && inviter.avatarStatus === 'ready' && inviter.avatarStaticKey !== null;
  const base = `/api/invites/${row.token}/avatar`;
  const ver = inviter.avatarVersion;
  return {
    status,
    kind: row.conversationId ? 'group' : 'dm',
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

async function fanOutJoin(convId: string, joinerId: string, existingMemberIds: string[]): Promise<void> {
  // Mirrors §1.4: conv.new to the joiner, conv.updated to members — all via
  // the Redis `events` channel.
  const dto = await loadConversationDto(convId);
  if (!dto) return;
  await publishToUsers(existingMemberIds, { t: 'conv.updated', d: { conversation: dto } });
  await publishToUsers([joinerId], { t: 'conv.new', d: { conversation: dto } });
}

/**
 * Accept an invite for `joinerId` — the shared flow behind
 * POST /api/invites/:token/accept AND register-with-token (the caller decides
 * whether failures surface as HTTP errors or degrade to `invite: null`).
 *
 * Idempotent re-accept: already an active participant (or the DM already
 * exists) → the conversation id WITHOUT incrementing use_count and without a
 * system message.
 */
export async function acceptInvite(
  invite: InviteRow,
  joinerId: string,
): Promise<{ conversation_id: string }> {
  if (invite.inviterId === joinerId) throw badRequest('invite_own');

  const status = inviteStatus(invite);
  if (status !== 'valid') throw goneByStatus(status);

  if (invite.conversationId === null) {
    // DM-with-inviter invite: create-or-dedupe via dm_key, exactly like
    // POST /api/conversations {type:'dm'}.
    const dmKey = [invite.inviterId, joinerId].sort().join(':');
    const [existing] = await db.select().from(convs).where(eq(convs.dmKey, dmKey)).limit(1);
    if (existing) return { conversation_id: existing.id }; // idempotent, no increment

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

  // Group invite.
  const [conv] = await db.select().from(convs).where(eq(convs.id, invite.conversationId)).limit(1);
  // The FK cascades invites away with their group; defensive all the same.
  if (!conv) throw notFound('invite_not_found');

  const [myPart] = await db
    .select()
    .from(cp)
    .where(and(eq(cp.conversationId, conv.id), eq(cp.userId, joinerId)))
    .limit(1);
  if (myPart && myPart.leftAt === null) return { conversation_id: conv.id }; // idempotent

  const existingActive = await activeParticipantUserIds(conv.id);
  if (existingActive.length + 1 > MAX_GROUP_PARTICIPANTS) throw badRequest('group_too_large');

  if (!(await claimUse(invite.id))) await refuseClaim(invite.id);

  // Same upsert as the §1.4 add-participants path: join_seq = last_seq (the
  // history floor), role 'member', watermarks start at the floor; a departed
  // member re-joining gets a fresh window.
  const joinSeq = conv.lastSeq;
  const nowIso = new Date().toISOString();
  await db.execute(sql`
    INSERT INTO conversation_participants
      (conversation_id, user_id, role, joined_at, join_seq, left_at, last_delivered_seq, last_read_seq)
    VALUES (${conv.id}, ${joinerId}, 'member', ${nowIso}::timestamptz, ${joinSeq}::bigint, NULL, ${joinSeq}::bigint, ${joinSeq}::bigint)
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET
      role = 'member',
      joined_at = ${nowIso}::timestamptz,
      join_seq = ${joinSeq}::bigint,
      left_at = NULL,
      left_seq = NULL,
      last_delivered_seq = GREATEST(conversation_participants.last_delivered_seq, ${joinSeq}::bigint),
      last_read_seq = GREATEST(conversation_participants.last_read_seq, ${joinSeq}::bigint)
  `);
  await sendSystemMessage(conv.id, 'invite_joined', 'joined via invite', joinerId, invite.inviterId);
  await fanOutJoin(conv.id, joinerId, existingActive);
  return { conversation_id: conv.id };
}
