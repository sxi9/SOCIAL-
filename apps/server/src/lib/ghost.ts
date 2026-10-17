// 👻 Ghost-group masks (v0.8b — API.md §1.68, FEATURES #79d, ADR-020).
// Anonymity is a SERIALIZATION rule: conversation_masks stores real user ids
// (the server always knows; admins and reports see real identity — the #77
// precedent); this module turns a member identity into the MASK UserLite /
// UserPublic for non-admin members at the DTO edge. The pseudo-id is an HMAC
// of (conversation_id, user_id) with a server secret — stable within the
// group, linkable to NOTHING outside it (and never reversible client-side).
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  GHOST_MASK_EMOJI,
  GHOST_MASK_NAMES,
  MASK_NAME_MAX_CHARS,
  type Avatar,
  type Message,
  type UserLite,
  type UserPublic,
} from '@socialchat/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import type { SqlExecutor } from './activity.js';

export interface MaskEntry {
  name: string;
  emoji: string;
}

export interface GhostCtx {
  convId: string;
  masks: Map<string, MaskEntry>;
  /** The recipient of this serialization. Their OWN identity stays real —
   * a client must be able to find itself (bubble alignment, "my role"). */
  viewerId?: string | null;
  /** Group admins see real identities (abuse handling needs a responsible
   * adult — ADR-020); receipts/last-seen suppression still applies to them. */
  viewerIsAdmin: boolean;
}

const FALLBACK_MASK: MaskEntry = { name: 'ghost', emoji: '👻' };

/** Derived, deterministic pseudo-id: HMAC-SHA256(secret, conv:user) → UUIDv4
 * shape (the DTO contract pins UserLite.id to a uuid). */
export function pseudoIdFor(convId: string, userId: string): string {
  const mac = createHmac('sha256', `ghost:${config.sessionSecret}`)
    .update(`${convId}:${userId}`)
    .digest();
  const b = Buffer.from(mac.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const EMPTY_AVATAR: Avatar = { status: 'none', version: 0, static_url: null, animated_url: null };

export function maskUserLite(ctx: GhostCtx, userId: string): UserLite {
  const mask = ctx.masks.get(userId) ?? FALLBACK_MASK;
  return {
    id: pseudoIdFor(ctx.convId, userId),
    username: '',
    display_name: mask.name,
    avatar: { ...EMPTY_AVATAR },
    mood: null, // identity tells never ride a masked frame (§1.68)
    name_style: 'none',
    mask_emoji: mask.emoji,
  };
}

/** Participant rows carry UserPublic — same mask, profile facts zeroed. The
 * extra mask_emoji key is deliberate (clients render the emoji glyph). */
export function maskUserPublic(ctx: GhostCtx, userId: string): UserPublic & { mask_emoji: string } {
  const lite = maskUserLite(ctx, userId);
  return {
    id: lite.id,
    username: '',
    display_name: lite.display_name,
    bio: '',
    avatar: { ...EMPTY_AVATAR },
    last_seen_at: null, // last-seen is an identity side channel (§1.68)
    beacons_created: 0,
    beacons_sparked: 0,
    mood: null,
    name_style: 'none',
    mask_emoji: lite.mask_emoji ?? FALLBACK_MASK.emoji,
  };
}

export async function loadMasks(convId: string): Promise<Map<string, MaskEntry>> {
  const rows = (await db.execute(sql`
    SELECT user_id, mask_name, mask_emoji FROM conversation_masks
    WHERE conversation_id = ${convId}
  `)) as unknown as { user_id: string; mask_name: string; mask_emoji: string }[];
  return new Map(rows.map((r) => [r.user_id, { name: r.mask_name, emoji: r.mask_emoji }]));
}

/**
 * Auto-assign masks from the GHOST_MASK_* pools to every listed member that
 * has none yet (the §1.68 switch-to-ghost transaction + every later join).
 * Names are unique per group (case-insensitive by route doctrine) — when the
 * pool is exhausted a numeric suffix keeps the invariant.
 */
export async function assignMasksTx(
  tx: SqlExecutor,
  convId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const existing = (await tx.execute(sql`
    SELECT user_id, lower(mask_name) AS lname FROM conversation_masks
    WHERE conversation_id = ${convId}
  `)) as unknown as { user_id: string; lname: string }[];
  const have = new Set(existing.map((r) => r.user_id));
  const taken = new Set(existing.map((r) => r.lname));
  const pool = [...GHOST_MASK_NAMES].sort(() => Math.random() - 0.5);
  for (const userId of userIds) {
    if (have.has(userId)) continue;
    let name: string | null = pool.find((n) => !taken.has(n)) ?? null;
    if (!name) {
      const base = GHOST_MASK_NAMES[Math.floor(Math.random() * GHOST_MASK_NAMES.length)]!;
      for (let i = 2; ; i += 1) {
        const candidate = `${base}-${i}`.slice(0, MASK_NAME_MAX_CHARS);
        if (!taken.has(candidate)) {
          name = candidate;
          break;
        }
      }
    }
    taken.add(name.toLowerCase());
    have.add(userId);
    const emoji = GHOST_MASK_EMOJI[Math.floor(Math.random() * GHOST_MASK_EMOJI.length)]!;
    await tx.execute(sql`
      INSERT INTO conversation_masks (conversation_id, user_id, mask_name, mask_emoji)
      VALUES (${convId}, ${userId}, ${name}, ${emoji})
      ON CONFLICT (conversation_id, user_id) DO NOTHING
    `);
  }
}

/** Group-admin user ids of one conversation (active rows). */
export async function groupAdminIdsOf(convId: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT user_id FROM conversation_participants
    WHERE conversation_id = ${convId} AND left_at IS NULL AND role = 'admin'
  `)) as unknown as { user_id: string }[];
  return new Set(rows.map((r) => r.user_id));
}

function pseudoOrSelf(ctx: GhostCtx, userId: string): string {
  return userId === ctx.viewerId ? userId : pseudoIdFor(ctx.convId, userId);
}

/**
 * Mask ONE message DTO for a non-admin ghost-group member: sender id becomes
 * the pseudo-id, stamp faces / vibe reply refs / reply-context authors become
 * masks, system actor/target ids become pseudo-ids, and @mentions are dropped
 * (a mention is an identity assertion — §1.68). The viewer's OWN identity
 * stays real everywhere. Admin viewers never reach this function.
 */
export function ghostMessageDto(msg: Message, ctx: GhostCtx): Message {
  const out: Message = JSON.parse(JSON.stringify(msg)) as Message;
  if (out.sender_id && out.sender_id !== ctx.viewerId) {
    out.sender_id = pseudoIdFor(ctx.convId, out.sender_id);
  }
  out.stamps = (out.stamps ?? []).map((u) =>
    u.id === ctx.viewerId ? u : maskUserLite(ctx, u.id),
  );
  if (out.vibe) {
    out.vibe.replies = out.vibe.replies.map((r) => ({
      ...r,
      user: r.user.id === ctx.viewerId ? r.user : maskUserLite(ctx, r.user.id),
      // A photo/doodle thumb is not an identity; stamp tiles render the mask
      // avatar shell (thumb_url already null on stamps by construction).
    }));
  }
  if (out.reply_context?.author && out.reply_context.author.id !== ctx.viewerId) {
    out.reply_context.author = maskUserLite(ctx, out.reply_context.author.id);
  }
  const meta = out.metadata as Record<string, unknown>;
  if (meta && typeof meta === 'object') {
    delete meta.mentions;
    const sys = meta.system as { actor_id?: string; target_id?: string } | undefined;
    if (sys && typeof sys === 'object') {
      if (typeof sys.actor_id === 'string') sys.actor_id = pseudoOrSelf(ctx, sys.actor_id);
      if (typeof sys.target_id === 'string') sys.target_id = pseudoOrSelf(ctx, sys.target_id);
    }
    // §1.27 game_ttt state: players.{x,o} are user ids — real uuids here would
    // map masked senders back to profiles (the §1.68 deanonymization leak).
    // The viewer's own id stays real (isPlayer / my-symbol detection).
    const game = meta.game as { players?: { x?: unknown; o?: unknown } } | undefined;
    if (game && typeof game === 'object' && game.players && typeof game.players === 'object') {
      if (typeof game.players.x === 'string') game.players.x = pseudoOrSelf(ctx, game.players.x);
      if (typeof game.players.o === 'string') game.players.o = pseudoOrSelf(ctx, game.players.o);
    }
    // Forward snapshots never carry a ghost member's name out OR in — inside
    // a ghost group the snapshot stays whatever the forwarder could see.
  }
  return out;
}

export function ghostMessageDtos(msgs: Message[], ctx: GhostCtx): Message[] {
  return msgs.map((m) => ghostMessageDto(m, ctx));
}
