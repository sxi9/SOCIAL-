// Drizzle schema — mirrors docs/SCHEMA.sql table-for-table, column-for-column.
// Migrations are hand-written SQL (src/db/migrations); this file is the typed
// query surface.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  type AnyPgColumn,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ============================== identity ====================================

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    username: citext('username').notNull().unique(),
    email: citext('email').notNull().unique(),
    emailVerifiedAt: timestamptz('email_verified_at'),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    bio: text('bio').notNull().default(''),
    avatarStatus: text('avatar_status').notNull().default('none'),
    avatarStaticKey: text('avatar_static_key'),
    avatarAnimatedKey: text('avatar_animated_key'),
    avatarVersion: integer('avatar_version').notNull().default(0),
    avatarMotion: text('avatar_motion').notNull().default('auto'),
    lastSeenAt: timestamptz('last_seen_at'),
    // v0.3 (migration 0003): self-declared coarse area — citext so 'area'
    // beacon visibility is case-insensitive equality. PRIVATE: UserPrivate
    // only, never serialized to other users (FEATURES #30).
    area: citext('area'),
    // v0.3 plan karma (UserPublic): profile facts, never ranked (PSYCHOLOGY
    // design rule 3). created bumps on POST /api/beacons + run-it-back (not on
    // worker ritual re-creations); sparked bumps in the spark transaction.
    beaconsCreated: integer('beacons_created').notNull().default(0),
    beaconsSparked: integer('beacons_sparked').notNull().default(0),
    // v0.3 privacy settings (ADR-009) — columns, not a settings table: one row
    // read on the presence/typing/receipt hot paths, like avatar_motion.
    // read_receipts is RECIPROCAL: off hides your reads from everyone AND
    // everyone's reads from you (serialization-time filtering; watermarks
    // still advance for unread counts + push suppression).
    readReceipts: boolean('read_receipts').notNull().default(true),
    showLastSeen: text('show_last_seen').notNull().default('everyone'),
    showTyping: boolean('show_typing').notNull().default(true),
    invitesPaused: boolean('invites_paused').notNull().default(false),
    beaconDefaultAudience: text('beacon_default_audience').notNull().default('friends'),
    groupAddPolicy: text('group_add_policy').notNull().default('everyone'),
    // v0.5a (migration 0005, API.md §1.37): interest tags, ≤ INTERESTS_MAX
    // (cardinality CHECK); the ≤ 24-char per-tag bound is Zod/route-enforced.
    // Serialized on the profile page response only — never into participants.
    interests: text('interests').array().notNull().default(sql`'{}'::text[]`),
    // v0.5b admin & account state (migration 0006, API.md §1.41, ADR-013).
    // is_admin is set ONLY via the ops CLI (grant-admin / revoke-admin) — no
    // web path to adminhood. suspended_at: login refused 403 account_suspended,
    // sessions revoked, sockets closed 4401. banned_at: suspension PLUS public
    // invisibility (profile/listings/stories/posts hidden at read/fan-out
    // time — serialization-side, like every §1.13/§1.14 rule).
    isAdmin: boolean('is_admin').notNull().default(false),
    suspendedAt: timestamptz('suspended_at'),
    bannedAt: timestamptz('banned_at'),
    // Captured at register; NULLED by the nightly retention GC after
    // IP_RETENTION_DAYS (90) — sessions.ip ages out on the same sweep.
    registrationIp: inet('registration_ip'),
    // v0.8a moods (migration 0009, API.md §1.57, ADR-018) — columns, not a
    // table: the mood rides EVERY UserLite serialization, so it must be the
    // same one-row read as the privacy settings (the ADR-009 pattern). All
    // NULL = no mood. Reads filter mood_expires_at > now() LIVE (never
    // stale); the sweep clears columns + fans user.updated. kind 'swing'
    // keeps the chosen set in mood_swing_set ([{emoji,label}…], Zod shape
    // authority) and the worker rotates the current chip every
    // MOOD_SWING_INTERVAL_S ± jitter from mood_swing_rotated_at. Moods are
    // NEVER written to activities and never pushed (ADR-018).
    moodEmoji: text('mood_emoji'),
    moodLabel: text('mood_label'),
    moodKind: text('mood_kind'),
    moodVisibility: text('mood_visibility').notNull().default('everyone'),
    moodSwingSet: jsonb('mood_swing_set'),
    moodExpiresAt: timestamptz('mood_expires_at'),
    moodSwingRotatedAt: timestamptz('mood_swing_rotated_at'),
    // v0.8a animated names (migration 0009, API.md §1.58): pure CSS text
    // effect, serialized on UserLite/UserPublic; 'surprise' rotation is
    // client-deterministic (no server state).
    nameStyle: text('name_style').notNull().default('none'),
    // v0.8a (§1.58): per-VIEWER toggle — do I render other people's
    // mood-reactive bubble effects. Settings column for cross-device sync.
    moodEffects: boolean('mood_effects').notNull().default(true),
    // v0.8a activity privacy (migration 0009, API.md §1.59): per-GROUP
    // visibility of my activity strip (ACTIVITY_KIND_GROUP maps kinds here).
    // Always INTERSECTED with the underlying object's audience at read time —
    // these can only narrow, never widen.
    activityBeacons: text('activity_beacons').notNull().default('connections'),
    activityPosts: text('activity_posts').notNull().default('connections'),
    activityListings: text('activity_listings').notNull().default('connections'),
    activityGames: text('activity_games').notNull().default('connections'),
    // v0.8a (§1.61): "new since your last visit" cursor — the newest release
    // version the user dismissed/saw. Register stamps the current newest so
    // new accounts never get a card storm.
    lastSeenRelease: text('last_seen_release'),
    // v0.8b (migration 0010, API.md §1.62, ADR-019): who may open an
    // anonymous thread to me. DEFAULT 'connections' (accepted §1.28
    // connections literally, NOT friends-of). Enforced INVISIBLY at send —
    // 'nobody', an unmet 'connections' and a §1.14 block all answer the same
    // 404 anon_unavailable.
    anonMessages: text('anon_messages').notNull().default('connections'),
    // v0.8b (migration 0010, API.md §1.63): may the worker send me the
    // batched anonymous wave nudge during a live discovery opt-in. Off kills
    // both the push and the in-app discovery.nudge frame.
    waveNudges: boolean('wave_nudges').notNull().default(true),
    // Share-everything plumbing (migration 0014, AUDIT-PLAN §1b / Wave 1.7).
    // dm_policy: who may open a DM / start a call with me — stored here,
    // ENFORCED at DM/call creation in the profile-share phase (404-shaped
    // like blocks; a stranger's message lands in Requests). DEFAULT
    // 'connections' for NEW accounts per §1.7; 0014 backfilled every
    // pre-existing account to 'everyone' (owner decision, 2026-10-27).
    dmPolicy: text('dm_policy').notNull().default('connections'),
    // profile_visibility: how much of my profile a logged-out share link may
    // show — 'public' = the full teaser (never counts), 'connections' |
    // 'private' = avatar + name only. Same value set as the activity_* toggles.
    profileVisibility: text('profile_visibility').notNull().default('public'),
    // v0.9 TOTP (migration 0011, API.md §1.73, ADR-021): the RFC 6238 shared
    // secret, AES-256-GCM-encrypted at rest with a SESSION_SECRET-derived key
    // (HKDF-SHA256, info 'totp:'; stored as v1:<iv>:<ct>:<tag> base64url
    // parts). The ONE secret the server must read back, hence encrypted, not
    // hashed. NEVER serialized — UserPrivate and the §1.41 export carry only
    // the totp_enabled boolean. Both columns move together (shape CHECK).
    totpSecret: text('totp_secret'),
    totpEnabledAt: timestamptz('totp_enabled_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    avatarStatusCheck: check(
      'users_avatar_status_check',
      sql`${t.avatarStatus} IN ('none','processing','ready','failed')`,
    ),
    avatarMotionCheck: check(
      'users_avatar_motion_check',
      sql`${t.avatarMotion} IN ('auto','reduced','off')`,
    ),
    areaCheck: check('users_area_check', sql`char_length(${t.area}) <= 64`),
    interestsCheck: check('users_interests_check', sql`cardinality(${t.interests}) <= 10`),
    beaconsCreatedCheck: check('users_beacons_created_check', sql`${t.beaconsCreated} >= 0`),
    beaconsSparkedCheck: check('users_beacons_sparked_check', sql`${t.beaconsSparked} >= 0`),
    showLastSeenCheck: check(
      'users_show_last_seen_check',
      sql`${t.showLastSeen} IN ('everyone','dm_partners','nobody')`,
    ),
    beaconDefaultAudienceCheck: check(
      'users_beacon_default_audience_check',
      sql`${t.beaconDefaultAudience} IN ('friends','area','public')`,
    ),
    groupAddPolicyCheck: check(
      'users_group_add_policy_check',
      sql`${t.groupAddPolicy} IN ('everyone','dm_partners','nobody')`,
    ),
    // ---- v0.8a (migration 0009) ----
    moodKindCheck: check(
      'users_mood_kind_check',
      sql`${t.moodKind} IN ('preset','custom','swing','drunk')`,
    ),
    moodVisibilityCheck: check(
      'users_mood_visibility_check',
      sql`${t.moodVisibility} IN ('everyone','connections','nobody')`,
    ),
    // All-or-nothing mood shape: a mood has emoji+label+kind+expiry together.
    moodShapeCheck: check(
      'users_mood_shape_check',
      sql`((${t.moodKind} IS NULL) = (${t.moodEmoji} IS NULL))
          AND ((${t.moodKind} IS NULL) = (${t.moodLabel} IS NULL))
          AND ((${t.moodKind} IS NULL) = (${t.moodExpiresAt} IS NULL))`,
    ),
    // The swing set exists exactly for kind='swing' (Zod pins entry shape).
    moodSwingShapeCheck: check(
      'users_mood_swing_shape_check',
      sql`(${t.moodKind} = 'swing') = (${t.moodSwingSet} IS NOT NULL)`,
    ),
    moodEmojiCheck: check(
      'users_mood_emoji_check',
      sql`char_length(${t.moodEmoji}) BETWEEN 1 AND 16`,
    ),
    moodLabelCheck: check(
      'users_mood_label_check',
      sql`char_length(${t.moodLabel}) BETWEEN 1 AND 24`,
    ),
    nameStyleCheck: check(
      'users_name_style_check',
      sql`${t.nameStyle} IN ('none','glow','shimmer','rainbow','surprise')`,
    ),
    activityBeaconsCheck: check(
      'users_activity_beacons_check',
      sql`${t.activityBeacons} IN ('public','connections','private')`,
    ),
    activityPostsCheck: check(
      'users_activity_posts_check',
      sql`${t.activityPosts} IN ('public','connections','private')`,
    ),
    activityListingsCheck: check(
      'users_activity_listings_check',
      sql`${t.activityListings} IN ('public','connections','private')`,
    ),
    activityGamesCheck: check(
      'users_activity_games_check',
      sql`${t.activityGames} IN ('public','connections','private')`,
    ),
    // ---- v0.8b (migration 0010) ----
    anonMessagesCheck: check(
      'users_anon_messages_check',
      sql`${t.anonMessages} IN ('nobody','connections','everyone')`,
    ),
    // ---- share-everything plumbing (migration 0014) ----
    dmPolicyCheck: check(
      'users_dm_policy_check',
      sql`${t.dmPolicy} IN ('everyone','connections','nobody')`,
    ),
    profileVisibilityCheck: check(
      'users_profile_visibility_check',
      sql`${t.profileVisibility} IN ('public','connections','private')`,
    ),
    // ---- v0.9 (migration 0011) ----
    totpShapeCheck: check(
      'users_totp_shape_check',
      sql`(${t.totpSecret} IS NULL) = (${t.totpEnabledAt} IS NULL)`,
    ),
    // Expiry sweep + swing-rotation walks (partial: most users have no mood).
    moodExpiryIdx: index('users_mood_expiry_idx')
      .on(t.moodExpiresAt)
      .where(sql`${t.moodExpiresAt} IS NOT NULL`),
    moodSwingIdx: index('users_mood_swing_idx')
      .on(t.moodSwingRotatedAt)
      .where(sql`${t.moodKind} = 'swing'`),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    expiredIdx: index('sessions_expired_idx').on(t.expiresAt),
  }),
);

// ============================ conversations =================================

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    title: text('title'),
    avatarStatus: text('avatar_status').notNull().default('none'),
    avatarStaticKey: text('avatar_static_key'),
    avatarAnimatedKey: text('avatar_animated_key'),
    avatarVersion: integer('avatar_version').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    dmKey: text('dm_key').unique(),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastMessageAt: timestamptz('last_message_at'),
    // v0.4 (migration 0004, API.md §1.25): disappearing-messages TTL. NULL =
    // off; else one of DISAPPEAR_TTL_OPTIONS_S. Conversation-wide (not
    // personal); changed via PATCH .../disappearing (any DM participant /
    // group admin), announced by a 'disappear_changed' system message. The
    // worker sweep tombstones (never deletes) expired rows — seqs are never
    // reused.
    disappearTtlS: integer('disappear_ttl_s'),
    // v0.6 (migration 0007, API.md §1.44/§1.45): the house jsonb rider.
    // Holds {"origin":"roulette","roulette":{"kept_by":[...]}} while a
    // roulette DM is provisional ({"origin":"roulette"} once kept) and
    // {"origin":"discovery"} on mutual-wave DMs. Shape authority is the
    // shared Zod contract; the DB pins only the json type.
    metadata: jsonb('metadata').notNull().default({}),
    // v0.6 (migration 0007, API.md §1.45): non-null = this conversation
    // self-destructs — the `discovery` worker sweep HARD-DELETES it (messages
    // and participants cascade). Set on roulette provisional DMs (+5 min);
    // cleared by the both-kept guarded UPDATE.
    expiresAt: timestamptz('expires_at'),
    // v1.0a (migration 0012, #95): a background the WHOLE conversation sees
    // (DM: either side sets; group: admins). Per-user prefs still override
    // locally. GC anti-joins the partial index (the 0009 prefs pattern).
    sharedBackgroundAttachmentId: uuid('shared_background_attachment_id').references(
      (): AnyPgColumn => attachments.id,
      { onDelete: 'set null' },
    ),
    // #95b (migration 0013): shared theme + wallpaper — same audience and
    // permission as the shared background; per-user prefs override locally.
    sharedTheme: text('shared_theme'),
    sharedWallpaper: text('shared_wallpaper'),
    // v0.8b (migration 0010, API.md §1.68, ADR-020): group visibility mode —
    // GROUPS ONLY (DMs/channels stay 'private', shape CHECK below). 'public'
    // and 'invite_only' power the §1.67 share pages; 'ghost' is unlisted
    // everywhere (search, suggestions, activity, share) and serializes member
    // MASKS to non-admins. Ghost is a ONE-WAY door (route-enforced
    // 400 ghost_is_forever — members spoke under masks).
    visibility: text('visibility').notNull().default('private'),
    // v0.8b (§1.68): group description — the group card + share page copy.
    description: text('description').notNull().default(''),
    // v0.8b (§1.68): conversations.last_seq at the admin-confirmed switch to
    // 'public'. ONLY messages with seq > this ever render publicly (history
    // is never retro-exposed); cleared when the group leaves 'public' (a
    // later re-publicize stamps a FRESH floor). Its presence doubles as the
    // member-banner flag in the DTO.
    publicSinceSeq: bigint('public_since_seq', { mode: 'number' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    // v0.5a adds 'channel' (migration 0005, API.md §1.35): broadcast
    // conversations — owner/admins send, everyone reads + reacts; cap
    // CHANNEL_MAX=10000, route-enforced (watermark receipts keep it safe,
    // ADR-002); joined via invites; typing suppressed; no seen-by exposure.
    typeCheck: check('conversations_type_check', sql`${t.type} IN ('dm','group','channel')`),
    avatarStatusCheck: check(
      'conversations_avatar_status_check',
      sql`${t.avatarStatus} IN ('none','processing','ready','failed')`,
    ),
    dmKeyCheck: check('conversations_dm_key_check', sql`(${t.type} = 'dm') = (${t.dmKey} IS NOT NULL)`),
    disappearTtlCheck: check(
      'conversations_disappear_ttl_s_check',
      sql`${t.disappearTtlS} IN (3600, 86400, 604800, 2592000)`,
    ),
    // v0.6 (migration 0007): jsonb rider shape pin.
    metadataCheck: check(
      'conversations_metadata_check',
      sql`jsonb_typeof(${t.metadata}) = 'object'`,
    ),
    activityIdx: index('conversations_activity_idx').on(sql`${t.lastMessageAt} DESC NULLS LAST`),
    disappearingIdx: index('conversations_disappearing_idx')
      .on(t.id)
      .where(sql`${t.disappearTtlS} IS NOT NULL`),
    // v0.6 (migration 0007): the roulette hard-delete sweep walk.
    expiryIdx: index('conversations_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
    // ---- v0.8b (migration 0010, §1.68) ----
    visibilityCheck: check(
      'conversations_visibility_check',
      sql`${t.visibility} IN ('private','invite_only','public','ghost')`,
    ),
    visibilityGroupCheck: check(
      'conversations_visibility_group_check',
      sql`${t.visibility} = 'private' OR ${t.type} = 'group'`,
    ),
    descriptionCheck: check(
      'conversations_description_check',
      sql`char_length(${t.description}) <= 300`,
    ),
    publicSinceShapeCheck: check(
      'conversations_public_since_shape_check',
      sql`(${t.visibility} = 'public') = (${t.publicSinceSeq} IS NOT NULL)`,
    ),
    // Discovery/search listing walk for PUBLIC groups (ghost groups never
    // appear in any listing — unlisted everywhere, §1.68).
    publicIdx: index('conversations_public_idx')
      .on(sql`${t.createdAt} DESC`)
      .where(sql`${t.visibility} = 'public'`),
  }),
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    joinedAt: timestamptz('joined_at').notNull().defaultNow(),
    joinSeq: bigint('join_seq', { mode: 'number' }).notNull().default(0),
    leftAt: timestamptz('left_at'),
    // conversations.last_seq at leave time: the departed-member history floor
    // (seq <= left_seq). NULL while active.
    leftSeq: bigint('left_seq', { mode: 'number' }),
    // Monotonic watermark cursors; writes use GREATEST(stored, incoming).
    lastDeliveredSeq: bigint('last_delivered_seq', { mode: 'number' }).notNull().default(0),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
    mutedUntil: timestamptz('muted_until'),
    // Wave 1.7 (migration 0015): NULL = this member has not accepted the
    // conversation (a stranger's DM parked in their Requests). DEFAULT now()
    // keeps every other insert path accepted; lib/dmPolicy.ts owns the rules.
    acceptedAt: timestamptz('accepted_at').defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId] }),
    // v0.5a adds 'owner' (migration 0005): the channel creator — exactly one
    // per channel, never used in DMs/groups (their creator stays 'admin').
    roleCheck: check('participants_role_check', sql`${t.role} IN ('member','admin','owner')`),
    byUserIdx: index('participants_by_user_idx')
      .on(t.userId)
      .where(sql`${t.leftAt} IS NULL`),
  }),
);

// =============================== messages ===================================

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').notNull().unique(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
    clientMsgId: uuid('client_msg_id'),
    type: text('type').notNull(),
    body: text('body'),
    metadata: jsonb('metadata').notNull().default({}),
    // v0.1 seam, RETIRED in v0.5a (always NULL from migration 0005 on):
    // replies are keyed by seq (reply_to_seq below), the message identity
    // reactions/polls/reports already use.
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    // v0.5a (migration 0005, API.md §1.29): the replied-to message's seq in
    // the SAME conversation (composite self-FK below; CHECK < seq — replies
    // only point backwards). The DTO carries a server-resolved reply_context
    // snippet; tombstoned targets render deleted:true.
    replyToSeq: bigint('reply_to_seq', { mode: 'number' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    editedAt: timestamptz('edited_at'),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.seq] }),
    seqCheck: check('messages_seq_check', sql`${t.seq} > 0`),
    // v0.3 adds 'poll' (migration 0003): a poll is a message on the seq log.
    // v0.4 adds 'audio' (voice notes), 'vibe_check' (prompt; replies carry
    // metadata.vibe_reply_seq), 'game_ttt' (state in metadata.game) and
    // 'puzzle_result' (metadata.puzzle, server-populated) — migration 0004.
    // v0.7 adds 'location' (migration 0008, §1.52): a "📍 join me here" drop —
    // the place rides metadata.location (+ optional metadata.join_me).
    typeCheck: check(
      'messages_type_check',
      sql`${t.type} IN ('text','image','video','file','system','poll','audio','vibe_check','game_ttt','puzzle_result','location')`,
    ),
    // v0.4 (§1.22): metadata.effect pinned to the MESSAGE_EFFECTS set.
    metadataEffectCheck: check(
      'messages_metadata_effect_check',
      sql`NOT (${t.metadata} ? 'effect') OR ${t.metadata}->>'effect' IN ('confetti','hearts','fireworks','snow')`,
    ),
    // v0.5a: replies point backwards within the conversation. The FK only
    // ever cascades on whole-conversation deletion — individual messages are
    // tombstoned, never deleted (ADR-003), so a reply's target always exists.
    replyToSeqCheck: check(
      'messages_reply_to_seq_check',
      sql`${t.replyToSeq} IS NULL OR (${t.replyToSeq} > 0 AND ${t.replyToSeq} < ${t.seq})`,
    ),
    replyToFk: foreignKey({
      name: 'messages_reply_to_fk',
      columns: [t.conversationId, t.replyToSeq],
      // Self-reference via the callback's own columns (the outer `messages`
      // const would make type inference circular).
      foreignColumns: [t.conversationId, t.seq],
    }).onDelete('cascade'),
    idempotencyIdx: uniqueIndex('messages_idempotency_idx')
      .on(t.conversationId, t.senderId, t.clientMsgId)
      .where(sql`${t.clientMsgId} IS NOT NULL`),
    // v0.4 (§1.25): the disappearing sweep's inner walk (system rows exempt).
    disappearSweepIdx: index('messages_disappear_sweep_idx')
      .on(t.conversationId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL AND ${t.type} <> 'system'`),
  }),
);

// ================================ invites ===================================
// v0.2 (ADR-007). token is PLAINTEXT + unique index — not hashed like session
// tokens, because GET /api/invites re-displays the /join/<token> URL and the
// token is a revocable capability, not an auth credential. status is derived
// (revoked_at > expires_at > use_count >= max_uses > valid), never stored;
// accepts increment use_count through an atomic guarded UPDATE (see migration
// 0002).

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey(),
    token: text('token').notNull().unique(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // NULL = DM-with-inviter invite; set = the group this invite joins.
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at')
      .notNull()
      .default(sql`now() + interval '7 days'`),
    maxUses: integer('max_uses').notNull().default(50),
    useCount: integer('use_count').notNull().default(0),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => ({
    maxUsesCheck: check('invites_max_uses_check', sql`${t.maxUses} > 0`),
    useCountCheck: check('invites_use_count_check', sql`${t.useCount} >= 0`),
    byInviterIdx: index('invites_by_inviter_idx').on(t.inviterId, sql`${t.createdAt} DESC`),
  }),
);

// =========================== message reactions ==============================
// v0.2. Keyed by the messages PK (conversation_id, seq): the composite FK
// cascades with message deletion and the PK prefix serves the per-message
// GROUP BY emoji aggregate. The 8-distinct-emoji-per-user-per-message cap
// (REACTIONS_PER_USER_PER_MESSAGE_MAX) is enforced in the route transaction.

export const messageReactions = pgTable(
  'message_reactions',
  {
    conversationId: uuid('conversation_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    // v0.4 avatar stamps (migration 0004, API.md §1.19): kind='stamp' rows
    // hold the ':stamp:' sentinel (STAMP_REACTION_KEY) in emoji, so the PK
    // enforces one stamp per user per message for free. The 8-distinct route
    // cap counts kind='emoji' rows only.
    kind: text('kind').notNull().default('emoji'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.seq, t.userId, t.emoji] }),
    messageFk: foreignKey({
      name: 'message_reactions_message_fk',
      columns: [t.conversationId, t.seq],
      foreignColumns: [messages.conversationId, messages.seq],
    }).onDelete('cascade'),
    emojiCheck: check(
      'message_reactions_emoji_check',
      sql`char_length(${t.emoji}) BETWEEN 1 AND 16`,
    ),
    kindCheck: check('message_reactions_kind_check', sql`${t.kind} IN ('emoji','stamp')`),
    stampKeyCheck: check(
      'message_reactions_stamp_key_check',
      sql`(${t.kind} = 'stamp') = (${t.emoji} = ':stamp:')`,
    ),
  }),
);

// ============================ link previews =================================

export const linkPreviews = pgTable('link_previews', {
  urlHash: text('url_hash').primaryKey(),
  url: text('url').notNull(),
  status: text('status').notNull().default('pending'),
  siteName: text('site_name'),
  title: text('title'),
  description: text('description'),
  imageKey: text('image_key'),
  fetchedAt: timestamptz('fetched_at'),
  expiresAt: timestamptz('expires_at'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

// ============================ share-target inbox ============================

export const shareImports = pgTable(
  'share_imports',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    textBody: text('text_body'),
    url: text('url'),
    previewUrlHash: text('preview_url_hash').references(() => linkPreviews.urlHash, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('open'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    consumedAt: timestamptz('consumed_at'),
  },
  (t) => ({
    statusCheck: check('share_imports_status_check', sql`${t.status} IN ('open','consumed','expired')`),
    openIdx: index('share_imports_open_idx')
      .on(t.userId, sql`${t.createdAt} DESC`)
      .where(sql`${t.status} = 'open'`),
  }),
);

// ============================== attachments =================================

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    shareImportId: uuid('share_import_id').references(() => shareImports.id, {
      onDelete: 'set null',
    }),
    // v0.4 (migration 0004, §1.26): bound to a pending scheduled message —
    // keeps the orphan GC off it while it waits for delivery.
    scheduledMessageId: uuid('scheduled_message_id').references(
      (): AnyPgColumn => scheduledMessages.id,
      { onDelete: 'set null' },
    ),
    // v0.5a (migration 0005, §1.36): bound to a feed post — the orphan-GC
    // shield for post media (posts.attachment_ids jsonb keeps the ordering).
    postId: uuid('post_id').references((): AnyPgColumn => posts.id, {
      onDelete: 'set null',
    }),
    // v0.5b (migration 0006, §1.38): bound to a room listing — same pattern
    // (listings.details.attachment_ids keeps the author's ordering).
    listingId: uuid('listing_id').references((): AnyPgColumn => listings.id, {
      onDelete: 'set null',
    }),
    // v0.7 (migration 0008, §1.51): bound to a feed comment — same pattern
    // (post_comments.attachment_id is the reference, this is the GC shield).
    commentId: uuid('comment_id').references((): AnyPgColumn => postComments.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    originalKey: text('original_key').notNull(),
    thumbKey: text('thumb_key'),
    blurhash: text('blurhash'),
    mime: text('mime').notNull(),
    fileName: text('file_name'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    // v0.4 voice notes (migration 0004, §1.20): AUDIO_WAVEFORM_BUCKETS (48)
    // integer peaks 0..100, worker-computed; NULL for non-audio kinds and
    // while 'pending'. Inlined into the Attachment DTO.
    waveform: jsonb('waveform'),
    status: text('status').notNull().default('pending'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    // v0.4 adds 'audio' (migration 0004).
    kindCheck: check(
      'attachments_kind_check',
      sql`${t.kind} IN ('image','video','file','audio')`,
    ),
    statusCheck: check('attachments_status_check', sql`${t.status} IN ('pending','ready','failed')`),
    waveformCheck: check(
      'attachments_waveform_check',
      sql`${t.waveform} IS NULL OR (jsonb_typeof(${t.waveform}) = 'array' AND jsonb_array_length(${t.waveform}) = 48)`,
    ),
    messageIdx: index('attachments_message_idx').on(t.messageId),
    // v0.5a (migration 0005): the refcount guard for RE-REFERENCED objects —
    // forwarding (§1.31) and recap-to-story (§1.34) create new attachment
    // rows over the SAME content-hashed MinIO objects, so every object
    // deletion first checks no other row shares original_key/thumb_key.
    originalKeyIdx: index('attachments_original_key_idx').on(t.originalKey),
    // CANDIDATE list only: the GC worker additionally guards with indexed
    // NOT EXISTS over stories.attachment_id and profile_media.attachment_id
    // (partial indexes cannot reference other tables).
    orphanIdx: index('attachments_orphan_idx')
      .on(t.createdAt)
      .where(
        sql`${t.messageId} IS NULL AND ${t.shareImportId} IS NULL AND ${t.scheduledMessageId} IS NULL AND ${t.postId} IS NULL AND ${t.listingId} IS NULL AND ${t.commentId} IS NULL`,
      ),
  }),
);

// ================================ web push ==================================

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastSuccessAt: timestamptz('last_success_at'),
    failCount: integer('fail_count').notNull().default(0),
  },
  (t) => ({
    byUserIdx: index('push_by_user_idx').on(t.userId),
  }),
);

// ================================ beacons ===================================
// v0.3 (ADR-008, API.md §1.15, migration 0003). Audience resolution happens at
// fan-out/read time: friends = shares a DM with the creator; area = users.area
// citext-equals beacons.area (SNAPSHOTTED from the creator at mint); public =
// everyone; always minus blocks (either direction, viewer <-> creator).
// spark_threshold counts JOINERS (creator excluded). The spark runs inside the
// join transaction under SELECT ... FOR UPDATE on the beacon row, flipped by
// the guarded UPDATE ... WHERE status = 'open' (see migration 0003 comments).
// Ritual chains link weekly runs via ritualParentId (one child max — partial
// unique index); ritual_count counts UP, ritual_skips auto-pauses the chain at
// RITUAL_AUTO_PAUSE_SKIPS with zero guilt copy.

export const beacons = pgTable(
  'beacons',
  {
    id: uuid('id').primaryKey(),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vibe: text('vibe').notNull(),
    // v0.7 (migration 0008, §1.47): the creator's own chip — emoji + word,
    // both non-null exactly when vibe='custom' (shape CHECK below).
    customVibeEmoji: text('custom_vibe_emoji'),
    customVibeLabel: text('custom_vibe_label'),
    note: text('note').notNull().default(''),
    audience: text('audience').notNull(),
    // Creator-area snapshot; required iff audience = 'area'.
    area: citext('area'),
    // v0.7 (migration 0008, §1.52): optional place chip {label, lat?, lng?} —
    // jsonb type pinned here, shape authority is the shared LocationSchema.
    location: jsonb('location'),
    // v0.7 (§1.47): set on every effective creator edit (the "edited" marker;
    // no edit history is stored — the §1.30 pattern).
    editedAt: timestamptz('edited_at'),
    // v0.7 (§1.47): the T-30min starting-soon ping, claimed once per beacon
    // via the guarded UPDATE ... WHERE starting_soon_pinged_at IS NULL (the
    // repinged_at pattern).
    startingSoonPingedAt: timestamptz('starting_soon_pinged_at'),
    startsAt: timestamptz('starts_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    sparkThreshold: integer('spark_threshold').notNull().default(2),
    status: text('status').notNull().default('open'),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    // "Needs 1 more" re-ping: set once via a guarded UPDATE (max once per beacon).
    repingedAt: timestamptz('repinged_at'),
    ritualRrule: text('ritual_rrule'),
    ritualCount: integer('ritual_count').notNull().default(0),
    ritualSkips: integer('ritual_skips').notNull().default(0),
    ritualParentId: uuid('ritual_parent_id').references((): AnyPgColumn => beacons.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    // v0.7 (migration 0008) adds 'custom' — BEACON_VIBE_VALUES.
    vibeCheck: check(
      'beacons_vibe_check',
      sql`${t.vibe} IN ('food','chai','walk','game','movie','study','sport','chill','custom')`,
    ),
    customVibeEmojiCheck: check(
      'beacons_custom_vibe_emoji_check',
      sql`char_length(${t.customVibeEmoji}) BETWEEN 1 AND 16`,
    ),
    customVibeLabelCheck: check(
      'beacons_custom_vibe_label_check',
      sql`char_length(${t.customVibeLabel}) BETWEEN 1 AND 24`,
    ),
    customVibeShapeCheck: check(
      'beacons_custom_vibe_shape_check',
      sql`(${t.vibe} = 'custom') = (${t.customVibeEmoji} IS NOT NULL AND ${t.customVibeLabel} IS NOT NULL)`,
    ),
    locationCheck: check(
      'beacons_location_check',
      sql`${t.location} IS NULL OR jsonb_typeof(${t.location}) = 'object'`,
    ),
    noteCheck: check('beacons_note_check', sql`char_length(${t.note}) <= 140`),
    audienceCheck: check(
      'beacons_audience_check',
      sql`${t.audience} IN ('friends','area','public')`,
    ),
    sparkThresholdCheck: check(
      'beacons_spark_threshold_check',
      sql`${t.sparkThreshold} BETWEEN 2 AND 10`,
    ),
    statusCheck: check(
      'beacons_status_check',
      sql`${t.status} IN ('open','sparked','expired','cancelled')`,
    ),
    ritualRruleCheck: check('beacons_ritual_rrule_check', sql`${t.ritualRrule} = 'FREQ=WEEKLY'`),
    ritualCountCheck: check('beacons_ritual_count_check', sql`${t.ritualCount} >= 0`),
    ritualSkipsCheck: check('beacons_ritual_skips_check', sql`${t.ritualSkips} >= 0`),
    windowCheck: check('beacons_window_check', sql`${t.expiresAt} > ${t.startsAt}`),
    areaAudienceCheck: check(
      'beacons_area_audience_check',
      sql`${t.audience} <> 'area' OR ${t.area} IS NOT NULL`,
    ),
    // One-directional on purpose: ON DELETE SET NULL must not violate it.
    conversationSparkedCheck: check(
      'beacons_conversation_sparked_check',
      sql`${t.conversationId} IS NULL OR ${t.status} = 'sparked'`,
    ),
    creatorIdx: index('beacons_creator_idx').on(t.creatorId, sql`${t.createdAt} DESC`),
    openExpiryIdx: index('beacons_open_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'open'`),
    afterglowIdx: index('beacons_afterglow_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'sparked'`),
    areaIdx: index('beacons_area_idx')
      .on(t.area)
      .where(sql`${t.status} = 'open' AND ${t.audience} = 'area'`),
    ritualDueIdx: index('beacons_ritual_due_idx')
      .on(t.startsAt)
      .where(sql`${t.ritualRrule} IS NOT NULL`),
    ritualParentIdx: uniqueIndex('beacons_ritual_parent_idx')
      .on(t.ritualParentId)
      .where(sql`${t.ritualParentId} IS NOT NULL`),
    // v0.7 (§1.47): the starting-soon sweep walk (worker queue `beacons`).
    startingSoonIdx: index('beacons_starting_soon_idx')
      .on(t.startsAt)
      .where(sql`${t.status} IN ('open','sparked') AND ${t.startingSoonPingedAt} IS NULL`),
  }),
);

export const beaconJoins = pgTable(
  'beacon_joins',
  {
    beaconId: uuid('beacon_id')
      .notNull()
      .references(() => beacons.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.beaconId, t.userId] }),
    byUserIdx: index('beacon_joins_by_user_idx').on(t.userId),
  }),
);

// Named micro-roles on the plan card (PSYCHOLOGY §4). Mutations fan out the
// FULL roles list via the plan.updated WS event.
export const beaconRoles = pgTable(
  'beacon_roles',
  {
    id: uuid('id').primaryKey(),
    beaconId: uuid('beacon_id')
      .notNull()
      .references(() => beacons.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    done: boolean('done').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    labelCheck: check('beacon_roles_label_check', sql`char_length(${t.label}) BETWEEN 1 AND 40`),
    byBeaconIdx: index('beacon_roles_by_beacon_idx').on(t.beaconId, t.createdAt),
  }),
);

// Private "glad you came / glad you posted" (PSYCHOLOGY §9). The PK makes
// re-sends idempotent; delivered to the recipient ONLY, never counted publicly.
export const beaconKudos = pgTable(
  'beacon_kudos',
  {
    beaconId: uuid('beacon_id')
      .notNull()
      .references(() => beacons.id, { onDelete: 'cascade' }),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.beaconId, t.fromUserId, t.toUserId] }),
    kindCheck: check(
      'beacon_kudos_kind_check',
      sql`${t.kind} IN ('glad_you_came','glad_you_posted')`,
    ),
    notSelfCheck: check('beacon_kudos_not_self_check', sql`${t.fromUserId} <> ${t.toUserId}`),
    toIdx: index('beacon_kudos_to_idx').on(t.toUserId),
  }),
);

// ================================= polls ====================================
// v0.3 (API.md §1.17, migration 0003). A poll IS a message (type 'poll');
// identity is the messages PK (conversation_id, seq) — the message_reactions
// pattern. Votes UPSERT on (poll_id, user_id): revoting replaces. option_idx
// upper bound (< options length) and closes_at are route-enforced.

export const polls = pgTable(
  'polls',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    question: text('question').notNull(),
    options: jsonb('options').notNull(), // array of 2..6 option strings
    closesAt: timestamptz('closes_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    messageUnique: uniqueIndex('polls_conversation_id_seq_key').on(t.conversationId, t.seq),
    messageFk: foreignKey({
      name: 'polls_message_fk',
      columns: [t.conversationId, t.seq],
      foreignColumns: [messages.conversationId, messages.seq],
    }).onDelete('cascade'),
    questionCheck: check(
      'polls_question_check',
      sql`char_length(${t.question}) BETWEEN 1 AND 200`,
    ),
    optionsCheck: check(
      'polls_options_check',
      sql`jsonb_typeof(${t.options}) = 'array' AND jsonb_array_length(${t.options}) BETWEEN 2 AND 6`,
    ),
  }),
);

export const pollVotes = pgTable(
  'poll_votes',
  {
    pollId: uuid('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    optionIdx: integer('option_idx').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.pollId, t.userId] }),
    optionIdxCheck: check('poll_votes_option_idx_check', sql`${t.optionIdx} >= 0`),
  }),
);

// ================================= blocks ===================================
// v0.3 (ADR-009). Mutual invisibility; enforcement is 404-shaped wherever a
// 403 would confirm the block exists (per-surface table in API.md §1.14).

export const blocks = pgTable(
  'blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.blockerId, t.blockedId] }),
    notSelfCheck: check('blocks_not_self_check', sql`${t.blockerId} <> ${t.blockedId}`),
    byBlockedIdx: index('blocks_by_blocked_idx').on(t.blockedId),
  }),
);

// ================================ reports ===================================
// v0.3 (API.md §1.14). Audit log for the future admin dashboard: targets have
// NO foreign keys on purpose — a report must survive deletion of what it
// reports. Exactly one target shape per kind (CHECK).

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey(),
    // v0.8b (migration 0010, API.md §1.67): NULLABLE — non-user share-page
    // reports store NULL + reporter_ip (aged by the IP_RETENTION_DAYS sweep).
    reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    // v0.8b doctrine note: target_user_id doubles as the SERVER-ATTACHED
    // identity on 'anon_message' (the reported anon party — FEATURES #77) and
    // 'story_overlay' (the overlay author) rows; never client-supplied.
    targetUserId: uuid('target_user_id'),
    targetConversationId: uuid('target_conversation_id'),
    targetSeq: bigint('target_seq', { mode: 'number' }),
    targetBeaconId: uuid('target_beacon_id'),
    // v0.8b (migration 0010, §1.62/§1.66/§1.67): the new target pointers —
    // still NO FKs (reports outlive their targets, the 0003 doctrine).
    targetObjectType: text('target_object_type'),
    targetObjectId: uuid('target_object_id'),
    targetOverlayId: uuid('target_overlay_id'),
    targetAnonThreadId: uuid('target_anon_thread_id'),
    targetAnonMessageId: uuid('target_anon_message_id'),
    // v0.8b (§1.69): the reporter's EXPLICIT include-context choice on message
    // reports — the ONLY key that opens the admin context viewer (ADR-020).
    contextConsent: boolean('context_consent').notNull().default(false),
    // v0.8b (§1.67): the non-user reporter's IP (rate-limit audit), nulled by
    // the retention GC like every stored IP.
    reporterIp: inet('reporter_ip'),
    reason: text('reason').notNull().default(''),
    status: text('status').notNull().default('open'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    // v0.5b (migration 0006, API.md §1.41): the admin queue consumes this
    // table at last (FEATURES #54). Closing is an admin action — who, when,
    // optional note — and is always ring-logged too.
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
    closedAt: timestamptz('closed_at'),
    closeNote: text('close_note').notNull().default(''),
  },
  (t) => ({
    // v0.8b (migration 0010) widens the kind set.
    kindCheck: check(
      'reports_kind_check',
      sql`${t.kind} IN ('user','message','beacon','anon_message','story_overlay','share_page')`,
    ),
    reasonCheck: check('reports_reason_check', sql`char_length(${t.reason}) <= 500`),
    statusCheck: check('reports_status_check', sql`${t.status} IN ('open','closed')`),
    closeNoteCheck: check(
      'reports_close_note_check',
      sql`char_length(${t.closeNote}) <= 500`,
    ),
    closedShapeCheck: check(
      'reports_closed_shape_check',
      sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL)`,
    ),
    targetObjectTypeCheck: check(
      'reports_target_object_type_check',
      sql`${t.targetObjectType} IN ('post','beacon','listing','story','group')`,
    ),
    // Exactly one target shape per kind (the 0003 CHECK, widened by 0010).
    targetCheck: check(
      'reports_target_check',
      sql`(${t.kind} = 'user' AND ${t.targetUserId} IS NOT NULL AND ${t.targetConversationId} IS NULL AND ${t.targetSeq} IS NULL AND ${t.targetBeaconId} IS NULL AND ${t.targetObjectType} IS NULL AND ${t.targetOverlayId} IS NULL AND ${t.targetAnonThreadId} IS NULL) OR (${t.kind} = 'message' AND ${t.targetConversationId} IS NOT NULL AND ${t.targetSeq} IS NOT NULL AND ${t.targetUserId} IS NULL AND ${t.targetBeaconId} IS NULL AND ${t.targetObjectType} IS NULL AND ${t.targetOverlayId} IS NULL AND ${t.targetAnonThreadId} IS NULL) OR (${t.kind} = 'beacon' AND ${t.targetBeaconId} IS NOT NULL AND ${t.targetUserId} IS NULL AND ${t.targetConversationId} IS NULL AND ${t.targetSeq} IS NULL AND ${t.targetObjectType} IS NULL AND ${t.targetOverlayId} IS NULL AND ${t.targetAnonThreadId} IS NULL) OR (${t.kind} = 'anon_message' AND ${t.targetAnonThreadId} IS NOT NULL AND ${t.targetAnonMessageId} IS NOT NULL AND ${t.targetUserId} IS NOT NULL AND ${t.targetConversationId} IS NULL AND ${t.targetSeq} IS NULL AND ${t.targetBeaconId} IS NULL AND ${t.targetObjectType} IS NULL AND ${t.targetOverlayId} IS NULL) OR (${t.kind} = 'story_overlay' AND ${t.targetObjectType} = 'story' AND ${t.targetObjectId} IS NOT NULL AND ${t.targetOverlayId} IS NOT NULL AND ${t.targetUserId} IS NOT NULL AND ${t.targetConversationId} IS NULL AND ${t.targetSeq} IS NULL AND ${t.targetBeaconId} IS NULL AND ${t.targetAnonThreadId} IS NULL) OR (${t.kind} = 'share_page' AND ${t.targetObjectType} IS NOT NULL AND ${t.targetObjectId} IS NOT NULL AND ${t.targetConversationId} IS NULL AND ${t.targetSeq} IS NULL AND ${t.targetBeaconId} IS NULL AND ${t.targetOverlayId} IS NULL AND ${t.targetAnonThreadId} IS NULL)`,
    ),
    // context_consent exists only on message reports; only non-user
    // share-page rows may lack a reporter.
    contextConsentShapeCheck: check(
      'reports_context_consent_shape_check',
      sql`${t.contextConsent} = false OR ${t.kind} = 'message'`,
    ),
    reporterShapeCheck: check(
      'reports_reporter_shape_check',
      sql`${t.reporterId} IS NOT NULL OR ${t.kind} = 'share_page'`,
    ),
    queueIdx: index('reports_queue_idx').on(t.status, sql`${t.createdAt} DESC`),
  }),
);

// ========================= scheduled messages ================================
// v0.4 (migration 0004, API.md §1.26, ADR-010). Payload mirrors a §1.5 send;
// attachments bind via attachments.scheduled_message_id (keeps the orphan GC
// off them while they wait). Delivery = worker queue `timers` (delayed job per
// row + minute safety sweep over scheduled_due_idx); the claim is the guarded
//   UPDATE ... SET status='sent', sent_at=now(), sent_seq=$seq
//     WHERE id=$1 AND status='pending'
// in the same transaction as the real message insert — idempotent under job
// retries and sweep/job races. Undeliverable (author left / DM frozen /
// conversation gone) flips to 'cancelled'. A time capsule is the same row with
// metadata.capsule = true.

export const scheduledMessages = pgTable(
  'scheduled_messages',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientMsgId: uuid('client_msg_id').notNull(),
    type: text('type').notNull(),
    body: text('body'),
    metadata: jsonb('metadata').notNull().default({}), // {effect?, capsule?} only
    deliverAt: timestamptz('deliver_at').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    sentAt: timestamptz('sent_at'),
    // The delivered message's seq (author jump-to after delivery).
    sentSeq: bigint('sent_seq', { mode: 'number' }),
  },
  (t) => ({
    typeCheck: check(
      'scheduled_messages_type_check',
      sql`${t.type} IN ('text','image','video','file','audio')`,
    ),
    bodyCheck: check('scheduled_messages_body_check', sql`char_length(${t.body}) <= 8192`),
    metadataEffectCheck: check(
      'scheduled_messages_metadata_check',
      sql`NOT (${t.metadata} ? 'effect') OR ${t.metadata}->>'effect' IN ('confetti','hearts','fireworks','snow')`,
    ),
    statusCheck: check(
      'scheduled_messages_status_check',
      sql`${t.status} IN ('pending','sent','cancelled')`,
    ),
    sentShapeCheck: check(
      'scheduled_sent_shape_check',
      sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL AND ${t.sentSeq} IS NOT NULL)`,
    ),
    idempotencyIdx: uniqueIndex('scheduled_idempotency_idx').on(t.authorId, t.clientMsgId),
    dueIdx: index('scheduled_due_idx')
      .on(t.deliverAt)
      .where(sql`${t.status} = 'pending'`),
    byAuthorIdx: index('scheduled_by_author_idx').on(t.authorId, sql`${t.createdAt} DESC`),
    authorPendingIdx: index('scheduled_author_pending_idx')
      .on(t.authorId)
      .where(sql`${t.status} = 'pending'`),
  }),
);

// ============================== chat prefs ===================================
// v0.4 (migration 0004, API.md §1.24). ALL PERSONAL: per (conversation, user),
// serialized to the owner only, synced across their devices via prefs.updated
// (own sockets only). Fixed theme/wallpaper sets (CHAT_THEMES /
// CHAT_WALLPAPERS); wallpapers are CSS patterns — no uploads in v0.4. NULL =
// app default.

export const conversationPrefs = pgTable(
  'conversation_prefs',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    theme: text('theme'),
    wallpaper: text('wallpaper'),
    // v0.8a (migration 0009, API.md §1.60): my GIF/video chat background —
    // MY OWN upload (uploader ownership checked at PATCH), kind image|video,
    // §1.60 caps. SET NULL keeps the prefs row when the attachment goes; the
    // orphan GC anti-joins conversation_prefs_background_idx so a referenced
    // attachment is never collected (it cannot ride the attachments_orphan_idx
    // partial-index pattern — the reference points the other way).
    backgroundAttachmentId: uuid('background_attachment_id').references(
      (): AnyPgColumn => attachments.id,
      { onDelete: 'set null' },
    ),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId] }),
    backgroundIdx: index('conversation_prefs_background_idx')
      .on(t.backgroundAttachmentId)
      .where(sql`${t.backgroundAttachmentId} IS NOT NULL`),
    themeCheck: check(
      'conversation_prefs_theme_check',
      sql`${t.theme} IN ('classic','sunset','ocean','forest','grape','bubblegum','mono','midnight')`,
    ),
    wallpaperCheck: check(
      'conversation_prefs_wallpaper_check',
      sql`${t.wallpaper} IN ('dots','grid','waves','stars','scribbles','blobs')`,
    ),
  }),
);

// The owner's private nickname for a target member of one conversation
// (self-nicknames allowed). Never serialized to anyone but the owner.
export const memberNicknames = pgTable(
  'member_nicknames',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nickname: text('nickname').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.ownerId, t.targetId] }),
    nicknameCheck: check(
      'member_nicknames_nickname_check',
      sql`char_length(${t.nickname}) BETWEEN 1 AND 32`,
    ),
  }),
);

// ========================== daily puzzle attempts ============================
// v0.4 (migration 0004, API.md §1.27). One row per (user, UTC day); guesses is
// the ordered attempt log [{guess, score}]. The day's word is NEVER stored —
// recomputed from PUZZLE_WORDLIST + env PUZZLE_SECRET, so a dump spoils
// nothing. NO leaderboard, NO rankings, NO streaks (PSYCHOLOGY never-build).

export const puzzleAttempts = pgTable(
  'puzzle_attempts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    puzzleDate: date('puzzle_date', { mode: 'string' }).notNull(), // 'YYYY-MM-DD' (UTC day)
    guesses: jsonb('guesses').notNull().default([]),
    solved: boolean('solved').notNull().default(false),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.puzzleDate] }),
    guessesCheck: check(
      'puzzle_attempts_guesses_check',
      sql`jsonb_typeof(${t.guesses}) = 'array' AND jsonb_array_length(${t.guesses}) <= 6`,
    ),
  }),
);

// ============================== connections ==================================
// v0.5a (migration 0005, API.md §1.28, ADR-011). One row per UNORDERED pair
// (unique on LEAST/GREATEST); status 'pending' until the addressee accepts.
// Decline DELETES the row and is silent to the requester (no rejection ping —
// PSYCHOLOGY §9 liking gap); a block deletes pending rows and makes accepted
// ones DORMANT (friends-of excludes blocked pairs at read time; the row
// survives, §1.14). FRIENDS-OF = accepted connections ∪ dm-partners, minus
// blocks — the v0.5a audience primitive (stories, feed, upgraded beacon
// 'friends'), resolved at read/fan-out time, never stored.

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addresseeId: uuid('addressee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    respondedAt: timestamptz('responded_at'),
  },
  (t) => ({
    statusCheck: check('connections_status_check', sql`${t.status} IN ('pending','accepted')`),
    notSelfCheck: check('connections_not_self_check', sql`${t.requesterId} <> ${t.addresseeId}`),
    respondedShapeCheck: check(
      'connections_responded_shape_check',
      sql`(${t.status} = 'accepted') = (${t.respondedAt} IS NOT NULL)`,
    ),
    pairIdx: uniqueIndex('connections_pair_idx').on(
      sql`LEAST(${t.requesterId}, ${t.addresseeId})`,
      sql`GREATEST(${t.requesterId}, ${t.addresseeId})`,
    ),
    byRequesterIdx: index('connections_by_requester_idx').on(t.requesterId, t.status),
    byAddresseeIdx: index('connections_by_addressee_idx').on(t.addresseeId, t.status),
  }),
);

// ============================ conversation pins ==============================
// v0.5a (migration 0005, API.md §1.32). ≤ MAX_PINS per conversation (route-
// enforced under the conversation row lock). Keyed by the message identity;
// tombstoning a pinned message removes its pin in the same transaction.
// Pins ride the Conversation DTO; mutations fan out conv.updated.

export const conversationPins = pgTable(
  'conversation_pins',
  {
    conversationId: uuid('conversation_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    pinnedBy: uuid('pinned_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.seq] }),
    messageFk: foreignKey({
      name: 'conversation_pins_message_fk',
      columns: [t.conversationId, t.seq],
      foreignColumns: [messages.conversationId, messages.seq],
    }).onDelete('cascade'),
  }),
);

// ================================ stories ===================================
// v0.5a (migration 0005, API.md §1.34). 24 h ephemera over the existing §1.6
// upload pipeline; audience CHECK-pinned to 'friends_of' (one value today,
// enum stable). Visibility = author's friends-of minus blocks + the author.
// The worker sweep (queue `timers`) HARD-deletes expired stories: rows, views
// (cascade), the attachment row and its MinIO objects (refcount-guarded —
// recap shares re-reference objects). story.new fans to the audience only.

// v1.0a (migration 0012, #94): "My gallery" saves — a save row keeps the
// attachment alive past its binding (the GC anti-joins it). Today's one
// source: the story auto-saver (sweep expiry moves the author's media here
// instead of hard-deleting). Owner-private; deleting the save re-orphans.
export const gallerySaves = pgTable(
  'gallery_saves',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    source: text('source').notNull().default('story'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.attachmentId] }),
    sourceCheck: check('gallery_saves_source_check', sql`${t.source} IN ('story')`),
    attachmentIdx: index('gallery_saves_attachment_idx').on(t.attachmentId),
  }),
);

export const stories = pgTable(
  'stories',
  {
    id: uuid('id').primaryKey(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    caption: text('caption').notNull().default(''),
    audience: text('audience').notNull().default('friends_of'),
    // v0.8b (migration 0010, API.md §1.66, ADR-020): the canvas invitation —
    // DEFAULT 'off' (being drawable is always the author's choice); 'approve'
    // holds viewer overlays as 'pending' until the author approves each one.
    // Switchable mid-life via PATCH /api/stories/:id (author only).
    canvasMode: text('canvas_mode').notNull().default('off'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at')
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => ({
    captionCheck: check('stories_caption_check', sql`char_length(${t.caption}) <= 140`),
    audienceCheck: check('stories_audience_check', sql`${t.audience} IN ('friends_of')`),
    canvasModeCheck: check(
      'stories_canvas_mode_check',
      sql`${t.canvasMode} IN ('off','open','approve')`,
    ),
    byAuthorIdx: index('stories_by_author_idx').on(t.authorId, t.createdAt),
    expiryIdx: index('stories_expiry_idx').on(t.expiresAt),
    attachmentIdx: index('stories_attachment_idx').on(t.attachmentId),
  }),
);

// Who viewed which story. DELIBERATELY NO TIMESTAMP COLUMN: the DB cannot
// leak what it does not store — the author-private view list is faces ordered
// by username (§1.18 seen-by pattern; "seen X min ago" is on the PSYCHOLOGY
// never-build list). The author's own views are never recorded.

export const storyViews = pgTable(
  'story_views',
  {
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    viewerId: uuid('viewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.storyId, t.viewerId] }),
  }),
);

// ================================== feed ====================================
// v0.5a (migration 0005, API.md §1.36). The FINITE feed: posts by the
// viewer's friends-of set + their own, newest first, cursor-paginated to a
// hard all_caught_up end — no wraparound, no ranking, no share/repost
// mechanic (PSYCHOLOGY design rule 5). attachment_ids keeps the author's
// ordering; attachments.post_id is the binding/GC shield.

export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // v0.7 (migration 0008, §1.50): 'text' | 'poll' | 'game' | 'join_card'.
    // Poll state lives in post_polls/post_poll_votes; the game claim lives
    // here (columns below); a join_card's target lives in `ref`.
    kind: text('kind').notNull().default('text'),
    body: text('body').notNull().default(''),
    attachmentIds: jsonb('attachment_ids').notNull().default([]),
    // v0.7 (§1.49) adds 'public' — the discover lane. Resolved at read/
    // fan-out time minus blocks and banned authors, like every audience.
    audience: text('audience').notNull().default('friends_of'),
    // v0.7 (§1.50): join_card target {type: 'beacon'|'listing', id} — stored
    // VERBATIM (shape authority: shared PostRefSchema); the live summary is
    // resolved per viewer at serialization time. The audience-intersection
    // rule (a post may never widen its ref's audience) binds at create.
    ref: jsonb('ref'),
    // v0.7 (§1.50): the open-challenge claim — NULL until the FIRST claimer
    // wins the advisory-locked guarded UPDATE ... WHERE game_claimed_by IS
    // NULL (the spark pattern). The board itself is an ordinary game_ttt
    // message in the claimer↔author DM.
    gameClaimedBy: uuid('game_claimed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    // v0.7 (migration 0008, §1.52): optional place chip — jsonb type pinned
    // here, shape authority is the shared LocationSchema.
    location: jsonb('location'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check(
      'posts_kind_check',
      sql`${t.kind} IN ('text','poll','game','join_card')`,
    ),
    bodyCheck: check('posts_body_check', sql`char_length(${t.body}) <= 2000`),
    attachmentIdsCheck: check(
      'posts_attachment_ids_check',
      sql`jsonb_typeof(${t.attachmentIds}) = 'array' AND jsonb_array_length(${t.attachmentIds}) <= 4`,
    ),
    // v0.7 (migration 0008) adds 'public' — POST_AUDIENCES.
    audienceCheck: check(
      'posts_audience_check',
      sql`${t.audience} IN ('friends_of','public')`,
    ),
    refCheck: check('posts_ref_check', sql`${t.ref} IS NULL OR jsonb_typeof(${t.ref}) = 'object'`),
    refShapeCheck: check(
      'posts_ref_shape_check',
      sql`(${t.kind} = 'join_card') = (${t.ref} IS NOT NULL)`,
    ),
    gameClaimShapeCheck: check(
      'posts_game_claim_shape_check',
      sql`${t.gameClaimedBy} IS NULL OR ${t.kind} = 'game'`,
    ),
    locationCheck: check(
      'posts_location_check',
      sql`${t.location} IS NULL OR jsonb_typeof(${t.location}) = 'object'`,
    ),
    byAuthorIdx: index('posts_by_author_idx').on(t.authorId, sql`${t.createdAt} DESC`),
    // v0.7 (§1.49): the discover-lane read — finite keyset, like the friends lane.
    discoverIdx: index('posts_discover_idx')
      .on(sql`${t.createdAt} DESC`)
      .where(sql`${t.audience} = 'public'`),
  }),
);

// Reactions render as NAMED FACES — the DTO carries the first 12 reactors as
// UserLite + has_more, NEVER a numeric total (PSYCHOLOGY rule 3). created_at
// orders the face row and is never serialized. The 8-distinct-emoji cap
// (REACTIONS_PER_USER_PER_POST_MAX) is enforced in the route transaction.

export const postReactions = pgTable(
  'post_reactions',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.postId, t.userId, t.emoji] }),
    emojiCheck: check('post_reactions_emoji_check', sql`char_length(${t.emoji}) BETWEEN 1 AND 16`),
  }),
);

export const postComments = pgTable(
  'post_comments',
  {
    id: uuid('id').primaryKey(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // v0.7 (migration 0008, §1.51): body may be empty — an image/GIF-only
    // comment is legal; at least one of body/attachment is route-enforced.
    body: text('body').notNull().default(''),
    // v0.7 (§1.51): one optional image attachment via the EXISTING §1.6
    // pipeline (attachments.comment_id is the binding/GC shield twin; the
    // explicit AnyPgColumn annotations break the two-table inference cycle).
    attachmentId: uuid('attachment_id').references((): AnyPgColumn => attachments.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    // v0.7 (migration 0008): the BETWEEN 1 AND 500 lower bound is dropped.
    bodyCheck: check('post_comments_body_check', sql`char_length(${t.body}) <= 500`),
    byPostIdx: index('post_comments_by_post_idx').on(t.postId, t.createdAt),
    attachmentIdx: index('post_comments_attachment_idx').on(t.attachmentId),
  }),
);

// v0.7 (migration 0008, §1.50). One poll per poll post (post_id PK); options
// jsonb like the §1.17 chat polls (per-option bound Zod-enforced — the house
// metadata pattern). No closes_at: a post poll lives and dies with its post.
// Counts here are a VOTE TALLY on options — a decision tool, never approval
// attached to a person (ADR-016 argues the PSYCHOLOGY rule-3 distinction).

export const postPolls = pgTable(
  'post_polls',
  {
    postId: uuid('post_id')
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    options: jsonb('options').notNull(), // array of 2..6 option strings
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    questionCheck: check(
      'post_polls_question_check',
      sql`char_length(${t.question}) BETWEEN 1 AND 120`,
    ),
    optionsCheck: check(
      'post_polls_options_check',
      sql`jsonb_typeof(${t.options}) = 'array' AND jsonb_array_length(${t.options}) BETWEEN 2 AND 6`,
    ),
  }),
);

// Revote REPLACES (UPSERT on the PK — the §1.17 poll_votes semantics). The
// only reads are per-option aggregates and the voter's own my_vote row: no
// voter lists, no vote timestamps in any payload.

export const postPollVotes = pgTable(
  'post_poll_votes',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => postPolls.postId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    optionIdx: integer('option_idx').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.postId, t.userId] }),
    optionIdxCheck: check('post_poll_votes_option_idx_check', sql`${t.optionIdx} >= 0`),
  }),
);

// v0.7 (migration 0008, §1.51). Emoji + avatar-stamp reactions on comments —
// the §1.19 machinery re-applied: a stamp is kind='stamp' with the ':stamp:'
// sentinel (STAMP_REACTION_KEY) in the emoji column, so the PK enforces one
// stamp per user per comment; the 8-distinct-emoji route cap counts
// kind='emoji' rows only. Rendered as capped FACES lists, never totals.

export const commentReactions = pgTable(
  'comment_reactions',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => postComments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    kind: text('kind').notNull().default('emoji'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.commentId, t.userId, t.emoji, t.kind] }),
    emojiCheck: check(
      'comment_reactions_emoji_check',
      sql`char_length(${t.emoji}) BETWEEN 1 AND 16`,
    ),
    kindCheck: check('comment_reactions_kind_check', sql`${t.kind} IN ('emoji','stamp')`),
    stampKeyCheck: check(
      'comment_reactions_stamp_key_check',
      sql`(${t.kind} = 'stamp') = (${t.emoji} = ':stamp:')`,
    ),
  }),
);

// ============================== rich profiles ================================
// v0.5a (migration 0005, API.md §1.37). Work/skill portfolio rows + the 3-GIF
// strip. PATCH /users/me/profile full-replaces each present set in one
// transaction (order_idx = array order). Profile data rides the profile page
// response only; blocked viewers get the §1.14 404 for the whole page.

export const profileEntries = pgTable(
  'profile_entries',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    orderIdx: integer('order_idx').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check('profile_entries_kind_check', sql`${t.kind} IN ('work','skill')`),
    titleCheck: check(
      'profile_entries_title_check',
      sql`char_length(${t.title}) BETWEEN 1 AND 80`,
    ),
    detailCheck: check('profile_entries_detail_check', sql`char_length(${t.detail}) <= 160`),
    orderIdxCheck: check('profile_entries_order_idx_check', sql`${t.orderIdx} >= 0`),
    orderUnique: uniqueIndex('profile_entries_user_id_order_idx_key').on(t.userId, t.orderIdx),
  }),
);

export const profileMedia = pgTable(
  'profile_media',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    orderIdx: integer('order_idx').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.orderIdx] }),
    orderIdxCheck: check('profile_media_order_idx_check', sql`${t.orderIdx} BETWEEN 0 AND 2`),
    attachmentIdx: index('profile_media_attachment_idx').on(t.attachmentId),
  }),
);

// ================================ listings ===================================
// v0.5b (migration 0006, API.md §1.38, ADR-012, FEATURES #39–#43). ONE table,
// four card kinds; per-kind payloads live in `details` jsonb validated by the
// shared Zod discriminated union (the house metadata pattern). `area` is a
// citext SNAPSHOT of the author's users.area at mint (beacons.area pattern);
// visibility = same area OR is_public, minus §1.14 blocks both ways, resolved
// at read time. price_text is DISPLAY TEXT ONLY — no payment machinery exists
// (FEATURES #45). Expiry: gig/room = created_at + LISTING_TTL_S; ride = the
// details departs_at copied here at write time (sweep/reads never parse
// jsonb); place_review = NULL (evergreen). The board is PULL-BASED: no WS
// events, no push (PSYCHOLOGY design rules 2/4) — reads also filter
// `expires_at > now()` live, so the hourly `timers` sweep is bookkeeping.
// conversation_id = the gig team-up group, claimed once via the guarded
// UPDATE ... WHERE conversation_id IS NULL (the beacon-spark pattern).

export const listings = pgTable(
  'listings',
  {
    id: uuid('id').primaryKey(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    priceText: text('price_text'),
    area: citext('area').notNull(),
    isPublic: boolean('is_public').notNull().default(false),
    details: jsonb('details').notNull().default({}),
    status: text('status').notNull().default('active'),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    // v0.7 (migration 0008, §1.52): optional place chip — jsonb type pinned
    // here, shape authority is the shared LocationSchema.
    location: jsonb('location'),
    // v0.7 (§1.48): set on every effective author edit (the "edited" marker).
    editedAt: timestamptz('edited_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at'),
  },
  (t) => ({
    kindCheck: check(
      'listings_kind_check',
      sql`${t.kind} IN ('gig','ride','room','place_review')`,
    ),
    titleCheck: check('listings_title_check', sql`char_length(${t.title}) BETWEEN 1 AND 80`),
    bodyCheck: check('listings_body_check', sql`char_length(${t.body}) <= 2000`),
    priceTextCheck: check('listings_price_text_check', sql`char_length(${t.priceText}) <= 40`),
    areaCheck: check('listings_area_check', sql`char_length(${t.area}) <= 64`),
    detailsCheck: check('listings_details_check', sql`jsonb_typeof(${t.details}) = 'object'`),
    statusCheck: check(
      'listings_status_check',
      sql`${t.status} IN ('active','closed','expired')`,
    ),
    locationCheck: check(
      'listings_location_check',
      sql`${t.location} IS NULL OR jsonb_typeof(${t.location}) = 'object'`,
    ),
    expiryShapeCheck: check(
      'listings_expiry_shape_check',
      sql`(${t.kind} = 'place_review') = (${t.expiresAt} IS NULL)`,
    ),
    boardIdx: index('listings_board_idx')
      .on(t.area, sql`${t.createdAt} DESC`)
      .where(sql`${t.status} = 'active'`),
    publicIdx: index('listings_public_idx')
      .on(sql`${t.createdAt} DESC`)
      .where(sql`${t.status} = 'active' AND ${t.isPublic}`),
    byAuthorIdx: index('listings_by_author_idx').on(t.authorId, sql`${t.createdAt} DESC`),
    expiryIdx: index('listings_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active' AND ${t.expiresAt} IS NOT NULL`),
  }),
);

// One row per (listing, contacter) — written by POST /api/listings/:id/contact
// in the same transaction as the DM create/dedupe + 'listing_contact' system
// message. Load-bearing three ways: contact idempotency (re-POST returns the
// DM, no second system message), the author's team-up pick pool (§1.39), and
// THE GATE for §1.40 person reviews. Rows cascade with the listing; reviews
// already written survive (person_reviews snapshots what it needs).

export const listingContacts = pgTable(
  'listing_contacts',
  {
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.listingId, t.userId] }),
    byUserIdx: index('listing_contacts_by_user_idx').on(t.userId),
  }),
);

// ============================ person reviews =================================
// v0.5b (migration 0006, API.md §1.40, ADR-012, FEATURES #44). Marketplace
// trust: a review exists ONLY between the two parties of a listing contact,
// each reviewing the OTHER (route-enforced; blocked pairs 404-shaped, §1.14).
// listing_id is SET NULL on listing deletion with listing_kind SNAPSHOTTED,
// because trust data must survive its subject matter (the reports precedent)
// — a cascading FK would let an author purge bad reviews by deleting the
// listing. The once-per-(listing, reviewer) guard is a partial unique index:
// it binds at creation time, when the listing necessarily still exists.
// Star averages are SAFETY INFORMATION, not social approval (ADR-012 argues
// the distinction vs PSYCHOLOGY rule 3): avg hidden under TRUST_AVG_MIN_
// REVIEWS, and nothing anywhere ranks or sorts people by rating.

export const personReviews = pgTable(
  'person_reviews',
  {
    id: uuid('id').primaryKey(),
    listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'set null' }),
    listingKind: text('listing_kind').notNull(),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    body: text('body').notNull().default(''),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    listingKindCheck: check(
      'person_reviews_listing_kind_check',
      sql`${t.listingKind} IN ('gig','ride','room','place_review')`,
    ),
    ratingCheck: check('person_reviews_rating_check', sql`${t.rating} BETWEEN 1 AND 5`),
    bodyCheck: check('person_reviews_body_check', sql`char_length(${t.body}) <= 500`),
    notSelfCheck: check(
      'person_reviews_not_self_check',
      sql`${t.reviewerId} <> ${t.subjectId}`,
    ),
    onceIdx: uniqueIndex('person_reviews_once_idx')
      .on(t.listingId, t.reviewerId)
      .where(sql`${t.listingId} IS NOT NULL`),
    bySubjectIdx: index('person_reviews_by_subject_idx').on(
      t.subjectId,
      sql`${t.createdAt} DESC`,
    ),
  }),
);

// ============================ instance settings ==============================
// v0.5b (migration 0006, API.md §1.41, ADR-013). Operator-tunable instance
// state: key PK + jsonb value — adding a setting is an INSERT, not a
// migration. One key today: invites_enabled (boolean, seeded true) — enforced
// at invite MINT and ACCEPT (403 invites_disabled); register-with-token
// degrades to invite: null per §1.1, like every bad invite.

export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

// =================================== calls ===================================
// v0.6 (migration 0007, API.md §1.42 + §2.12, ADR-014, FEATURES #49–#50). The
// durable call LOG and the signaling authorization anchor — nothing live is
// in here: mesh membership is Redis (`call:{id}:members`, deleted on any
// terminal status) and SDP/ICE frames are relayed, never persisted (no such
// columns exist anywhere, by contract). ONE live call per conversation is the
// partial unique below — claimed atomically by the INSERT, the dm_key
// pattern. Status reachability: ringing → ongoing | rejected | missed;
// ongoing → completed | failed. is_group snapshots the conversation type at
// start; initiator_id SET NULL — the log outlives the account.

export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    initiatorId: uuid('initiator_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    isGroup: boolean('is_group').notNull().default(false),
    status: text('status').notNull().default('ringing'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    answeredAt: timestamptz('answered_at'),
    endedAt: timestamptz('ended_at'),
  },
  (t) => ({
    kindCheck: check('calls_kind_check', sql`${t.kind} IN ('audio','video')`),
    statusCheck: check(
      'calls_status_check',
      sql`${t.status} IN ('ringing','ongoing','completed','missed','rejected','failed')`,
    ),
    // Terminal states carry ended_at; live states don't.
    endedShapeCheck: check(
      'calls_ended_shape_check',
      sql`(${t.status} IN ('ringing','ongoing')) = (${t.endedAt} IS NULL)`,
    ),
    answeredShapeCheck: check(
      'calls_answered_shape_check',
      sql`(${t.status} IN ('ringing','missed','rejected') AND ${t.answeredAt} IS NULL)
          OR (${t.status} IN ('ongoing','completed','failed') AND ${t.answeredAt} IS NOT NULL)`,
    ),
    // The §1.42 409 call_active guard.
    liveIdx: uniqueIndex('calls_live_idx')
      .on(t.conversationId)
      .where(sql`${t.status} IN ('ringing','ongoing')`),
    byConversationIdx: index('calls_by_conversation_idx').on(
      t.conversationId,
      sql`${t.startedAt} DESC`,
    ),
    // Ring-timeout safety sweep (the delayed `timers` job is primary).
    ringingIdx: index('calls_ringing_idx')
      .on(t.startedAt)
      .where(sql`${t.status} = 'ringing'`),
  }),
);

// ============================ discovery opt-ins ==============================
// v0.6 (migration 0007, API.md §1.44, ADR-015, FEATURES #52). Being
// discoverable is a MOMENT, not a setting: one row per user, upserted with
// expires_at = now() + DISCOVERY_OPTIN_TTL_S; every read joins
// `expires_at > now()` live. scope 'area' requires users.area (route-
// enforced); the area TEXT is never serialized to other users — matching is
// server-side citext equality (FEATURES #30).

export const discoveryOptins = pgTable(
  'discovery_optins',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    note: text('note').notNull().default(''),
    // v0.8b (migration 0010, API.md §1.65): the optional what-for chip
    // (DISCOVERY_VIBES) — opt-in data the owner chose to share; the §1.65
    // card filters only ever NARROW on it. Re-PUT re-scopes/clears it.
    vibe: text('vibe'),
    // v0.8b (migration 0010, API.md §1.63): the once-per-opt-in wave-nudge
    // claim. The worker claims via the guarded UPDATE (… WHERE wave_nudged_at
    // IS NULL AND expires_at > now()) AFTER the NUDGE_MIN_POOL check, so a
    // too-small pool leaves the hour's claim open for a later wave. A re-PUT
    // clears it with the fresh opt-in.
    waveNudgedAt: timestamptz('wave_nudged_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => ({
    scopeCheck: check('discovery_optins_scope_check', sql`${t.scope} IN ('area','public')`),
    noteCheck: check('discovery_optins_note_check', sql`char_length(${t.note}) <= 80`),
    // v0.8b (migration 0010): DISCOVERY_VIBES — keep in sync with the shared
    // tuple and the SQL CHECK.
    vibeCheck: check(
      'discovery_optins_vibe_check',
      sql`${t.vibe} IN ('food','chai','walk','game','movie','study','sport','chill')`,
    ),
    expiryIdx: index('discovery_optins_expiry_idx').on(t.expiresAt),
  }),
);

// ============================= discovery waves ===============================
// v0.6 (migration 0007, API.md §1.44, ADR-015). One row per (waver, target).
// DELIBERATELY no read model for the target: a single wave notifies NOBODY
// and is visible to NOBODY but the matcher transaction (no FoMO, no rejection
// surface). Mutuality is a PK lookup of the reciprocal row; on match both
// rows are deleted in the DM-create transaction. Honored only while both
// parties' opt-ins are live (route-joined); the sweep prunes stale rows.

export const discoveryWaves = pgTable(
  'discovery_waves',
  {
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fromUserId, t.toUserId] }),
    notSelfCheck: check('discovery_waves_not_self_check', sql`${t.fromUserId} <> ${t.toUserId}`),
    sweepIdx: index('discovery_waves_sweep_idx').on(t.createdAt),
  }),
);

// =========================== expectation feedback ============================
// v0.6 (migration 0007, API.md §1.45, ADR-015; PSYCHOLOGY finding #10). The
// PRIVATE better/worse-than-expected one-tap after a roulette/discovery DM
// ends or persists. conversation_id is a plain uuid dedupe key, NOT an FK —
// expired roulette DMs are hard-deleted and the tap often lands after the
// deletion. The ONLY read is the anonymous instance-wide aggregate
// (GET /api/discovery/encouragement, null under ENCOURAGEMENT_MIN_SAMPLES);
// per-person verdicts are never serialized to anyone, the subject included.

export const expectationFeedback = pgTable(
  'expectation_feedback',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    context: text('context').notNull(),
    verdict: text('verdict').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    contextCheck: check(
      'expectation_feedback_context_check',
      sql`${t.context} IN ('roulette','discovery')`,
    ),
    verdictCheck: check(
      'expectation_feedback_verdict_check',
      sql`${t.verdict} IN ('better','same','worse')`,
    ),
    onceIdx: uniqueIndex('expectation_feedback_once').on(t.userId, t.conversationId),
    aggregateIdx: index('expectation_feedback_aggregate_idx').on(t.context, t.verdict),
  }),
);

// ================================ activities =================================
// v0.8a (migration 0009, API.md §1.59, FEATURES #76). The profile activity
// strip's source rows, written by the OWNING module's transaction through the
// ONE helper (src/lib/activity.ts recordActivity): beacon create → beacon_lit,
// spark → beacon_sparked (creator only), POST /api/posts → post_created,
// POST /api/listings → listing_posted, a finished puzzle attempt →
// puzzle_played, a server-validated tic-tac-toe win → game_won. ref is the
// minimal pointer/facts jsonb (shape authority: shared ActivitySummary
// resolution, §1.59) — NEVER a denormalized audience: visibility is resolved
// per viewer at read time as (per-group users.activity_* setting) ∩ (the
// underlying object's own audience), so an item can never leak past what the
// viewer could already see. Rows older than ACTIVITY_RETENTION_DAYS (30) are
// hard-deleted by the nightly gc sweep. MOODS ARE NEVER RECORDED HERE — no
// mood kind exists in the CHECK, by contract (PSYCHOLOGY: no trace).

export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    ref: jsonb('ref').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check(
      'activities_kind_check',
      sql`${t.kind} IN ('beacon_lit','beacon_sparked','post_created','listing_posted','puzzle_played','game_won')`,
    ),
    refCheck: check('activities_ref_check', sql`jsonb_typeof(${t.ref}) = 'object'`),
    // The strip read: newest-first per user.
    byUserIdx: index('activities_by_user_idx').on(t.userId, sql`${t.createdAt} DESC`),
    // The 30-day retention sweep.
    sweepIdx: index('activities_sweep_idx').on(t.createdAt),
  }),
);

// ============================ anonymous threads ===============================
// v0.8b (migration 0010, API.md §1.62, FEATURES #77, ADR-019). The anonymous
// reveal game. sender_id is an ORDINARY FK — anonymity is a SERIALIZATION
// rule (the recipient's DTO strips the sender until revealed), never a
// storage rule: the server always knows, and reports attach the identity.
// ONE open thread per (sender, recipient) — the partial unique; a revealed
// thread keeps living (identity now serialized) and frees the slot.
// reveal_timer_s keeps the chosen preset (ANON_TIMER_PRESETS_S) so the
// progressive un-blur factor stays derivable: clamp((reveal_at - now()) /
// reveal_timer_s, 0, 1) — the SERVER renders the blurred avatar pixels
// (the §1.62 gated proxy, sigma = ANON_BLUR_SIGMA_MAX × factor); the real
// image never ships early. Timer reveals resolve LIVE at read
// (reveal_at <= now() ⇒ revealed, the §1.44 pattern); the `timers` sweep only
// stamps revealed_at + fans the anon.updated goodbye-blur.

export const anonThreads = pgTable(
  'anon_threads',
  {
    id: uuid('id').primaryKey(),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    revealMode: text('reveal_mode').notNull().default('none'),
    revealTimerS: integer('reveal_timer_s'),
    revealAt: timestamptz('reveal_at'),
    riddleQ: text('riddle_q'),
    revealRequestedAt: timestamptz('reveal_requested_at'),
    revealedAt: timestamptz('revealed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    notSelfCheck: check('anon_threads_not_self_check', sql`${t.senderId} <> ${t.recipientId}`),
    revealModeCheck: check(
      'anon_threads_reveal_mode_check',
      sql`${t.revealMode} IN ('none','timer','riddle')`,
    ),
    // ANON_TIMER_PRESETS_S — keep in sync with the shared tuple.
    timerPresetCheck: check(
      'anon_threads_timer_preset_check',
      sql`${t.revealTimerS} IN (3600, 21600, 86400)`,
    ),
    timerShapeCheck: check(
      'anon_threads_timer_shape_check',
      sql`((${t.revealMode} = 'timer') = (${t.revealAt} IS NOT NULL))
          AND ((${t.revealMode} = 'timer') = (${t.revealTimerS} IS NOT NULL))`,
    ),
    riddleCheck: check('anon_threads_riddle_check', sql`char_length(${t.riddleQ}) <= 200`),
    riddleShapeCheck: check(
      'anon_threads_riddle_shape_check',
      sql`(${t.revealMode} = 'riddle') = (${t.riddleQ} IS NOT NULL)`,
    ),
    // ONE open thread per direction (§1.62's "UNIQUE sender+recipient open").
    openUnique: uniqueIndex('anon_threads_open_unique')
      .on(t.senderId, t.recipientId)
      .where(sql`${t.revealedAt} IS NULL`),
    byRecipientIdx: index('anon_threads_by_recipient_idx').on(
      t.recipientId,
      sql`${t.createdAt} DESC`,
    ),
    bySenderIdx: index('anon_threads_by_sender_idx').on(t.senderId, sql`${t.createdAt} DESC`),
    // Timer-reveal sweep walk (partial: almost all threads have no timer).
    revealIdx: index('anon_threads_reveal_idx')
      .on(t.revealAt)
      .where(sql`${t.revealedAt} IS NULL AND ${t.revealAt} IS NOT NULL`),
  }),
);

// TEXT ONLY by design — no attachment column exists (ADR-019: the game is
// words first). Deliberately NOT on the conversations/seq log: no receipts,
// no typing, no reactions — smaller than a chat on purpose. is_riddle_answer
// marks the recipient's formal POST .../answer-riddle entries (the sender's
// "that's right ✓" confirm target).

export const anonMessages = pgTable(
  'anon_messages',
  {
    id: uuid('id').primaryKey(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => anonThreads.id, { onDelete: 'cascade' }),
    fromSender: boolean('from_sender').notNull(),
    body: text('body').notNull(),
    isRiddleAnswer: boolean('is_riddle_answer').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    bodyCheck: check(
      'anon_messages_body_check',
      sql`char_length(${t.body}) BETWEEN 1 AND 500`, // ANON_BODY_MAX_CHARS
    ),
    byThreadIdx: index('anon_messages_by_thread_idx').on(t.threadId, t.createdAt),
  }),
);

// ========================== suggestion dismissals =============================
// v0.8b (migration 0010, API.md §1.64, FEATURES #78, ADR-019). "Not
// interested" is permanent and SILENT: the dismissed user is never told and
// the row only ever FILTERS the suggestions read — nothing re-ranks or
// re-surfaces (PSYCHOLOGY rule 4). Presence IS the dismissal.

export const suggestionDismissals = pgTable(
  'suggestion_dismissals',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    suggestedUserId: uuid('suggested_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.suggestedUserId] }),
    notSelfCheck: check(
      'suggestion_dismissals_not_self_check',
      sql`${t.userId} <> ${t.suggestedUserId}`,
    ),
  }),
);

// ============================= story overlays =================================
// v0.8b (migration 0010, API.md §1.66, FEATURES #79a, ADR-020). One VECTOR
// layer per row, keyed to its contributor — never burned into the image, so
// removal is total and the username chip always knows its owner. payload
// shape authority is the shared StoryOverlayPayloadSchema (stroke/emoji/text;
// the DB pins only jsonb_typeof — the house metadata pattern). status
// 'pending' = awaiting the author's approve (canvas_mode 'approve');
// 'removed' is a tombstone kept ONLY so reports resolve — it serializes to
// nobody and frees the OVERLAYS_PER_USER cap (counted over live+pending,
// under the story row lock). Everything cascades away with the story (the
// §1.34 hard-delete sweep: overlays expire with the story, by construction).

export const storyOverlays = pgTable(
  'story_overlays',
  {
    id: uuid('id').primaryKey(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('live'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check('story_overlays_kind_check', sql`${t.kind} IN ('stroke','emoji','text')`),
    payloadCheck: check('story_overlays_payload_check', sql`jsonb_typeof(${t.payload}) = 'object'`),
    statusCheck: check(
      'story_overlays_status_check',
      sql`${t.status} IN ('live','pending','removed')`,
    ),
    byStoryIdx: index('story_overlays_by_story_idx').on(t.storyId, t.createdAt),
    // The per-(story, contributor) cap count walk (live+pending only).
    capIdx: index('story_overlays_cap_idx')
      .on(t.storyId, t.authorId)
      .where(sql`${t.status} IN ('live','pending')`),
  }),
);

// "Ban from my canvases" — owner-scoped, until lifted. Enforced INVISIBLY at
// overlay create: a banned contributor gets the same 403 canvas_closed a
// closed canvas answers (never confirmable, the §1.14 shape doctrine).

export const storyCanvasBans = pgTable(
  'story_canvas_bans',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bannedUserId: uuid('banned_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerId, t.bannedUserId] }),
    notSelfCheck: check(
      'story_canvas_bans_not_self_check',
      sql`${t.ownerId} <> ${t.bannedUserId}`,
    ),
  }),
);

// ============================== share tokens ==================================
// v0.8b (migration 0010, API.md §1.67, FEATURES #79c, ADR-020). The ADR-007
// invite-token doctrine re-applied: 32 random bytes base64url stored
// PLAINTEXT with a unique index — a revocable CAPABILITY, not a credential
// (mint must re-display it). ONE open token per object ("stable per object,
// revocable with it"); a revoke frees the slot (stories may re-mint). Tokens
// exist ONLY for PUBLIC things — route-enforced at mint AND re-checked LIVE
// on every public read (audience narrowed / story expired / group left
// 'public'/'invite_only' / author banned ⇒ 404 share_not_found even before
// any revoke lands). object_id is a plain uuid, NOT an FK: posts hard-delete
// and stories sweep — the read resolves or 404s; the gc sweep prunes dead
// tokens.

export const shareTokens = pgTable(
  'share_tokens',
  {
    id: uuid('id').primaryKey(),
    objectType: text('object_type').notNull(),
    objectId: uuid('object_id').notNull(),
    token: text('token').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    // Migration 0014 (decision 11): the sharer's Teaser/Full choice for a
    // NON-public object, chosen at mint time; the server decides what to
    // render from it. Public objects are always fully viewable, so every
    // pre-0014 token (public by construction) backfills 'full'.
    preview: text('preview').notNull().default('full'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => ({
    objectTypeCheck: check(
      'share_tokens_object_type_check',
      sql`${t.objectType} IN ('post','beacon','listing','story','group')`,
    ),
    previewCheck: check('share_tokens_preview_check', sql`${t.preview} IN ('teaser','full')`),
    tokenUnique: uniqueIndex('share_tokens_token_unique').on(t.token),
    objectUnique: uniqueIndex('share_tokens_object_unique')
      .on(t.objectType, t.objectId)
      .where(sql`${t.revokedAt} IS NULL`),
  }),
);

// =========================== group join requests ==============================
// v0.8b (migration 0010, API.md §1.68, FEATURES #79d). The invite_only queue.
// Presence = pending; approve inserts the participant (join_seq = last_seq,
// the §1.4 floor) and deletes the row in ONE transaction; deny just deletes
// it — SILENTLY (no event, no notice: the no-rejection-surface rule).

export const groupJoinRequests = pgTable(
  'group_join_requests',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId] }),
  }),
);

// ============================ conversation masks ==============================
// v0.8b (migration 0010, API.md §1.68, FEATURES #79d, ADR-020). 👻 ghost
// masks: chosen pseudonym + emoji avatar per (group, member) — auto-assigned
// from the GHOST_MASK_* pools at join / at the switch, re-pickable via
// PUT …/mask (unique name per group → 409 mask_taken). Anonymity is a
// SERIALIZATION rule: non-admin members get the masked UserLite (derived
// pseudo-id, mask name, emoji avatar); group ADMINS and reports see real
// identity — the server always knows who is who (the #77 precedent).

export const conversationMasks = pgTable(
  'conversation_masks',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    maskName: text('mask_name').notNull(),
    maskEmoji: text('mask_emoji').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId] }),
    maskNameCheck: check(
      'conversation_masks_mask_name_check',
      sql`char_length(${t.maskName}) BETWEEN 1 AND 32`, // MASK_NAME_MAX_CHARS
    ),
    maskEmojiCheck: check(
      'conversation_masks_mask_emoji_check',
      sql`char_length(${t.maskEmoji}) BETWEEN 1 AND 16`, // MASK_EMOJI_MAX_LEN
    ),
    nameUnique: uniqueIndex('conversation_masks_name_unique').on(t.conversationId, t.maskName),
  }),
);

// ============================= support tickets ================================
// v0.8b (migration 0010, API.md §1.69, FEATURES #81, ADR-020). The Settings →
// Help & feedback intake. The DIALOGUE lives in the per-user "Bored Chat
// Support" conversation (type 'group', metadata.support = true, the user as
// sole member, lazily created on first delivery; operator messages are
// sender_id NULL + metadata.support {ticket_id} — rendered as the Support
// brand, never a named admin); this table is the admin Inbox's index card.
// attachment_id follows the 0009 prefs pattern (the reference points
// ticket → attachment): the orphan GC sweep ANTI-JOINS
// support_tickets_attachment_idx exactly like the chat-background index, and
// SET NULL keeps the ticket when the attachment goes.

export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    body: text('body').notNull(),
    attachmentId: uuid('attachment_id').references(() => attachments.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('open'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    categoryCheck: check(
      'support_tickets_category_check',
      sql`${t.category} IN ('bug','question','idea','safety')`,
    ),
    bodyCheck: check(
      'support_tickets_body_check',
      sql`char_length(${t.body}) BETWEEN 1 AND 2000`, // SUPPORT_BODY_MAX_CHARS
    ),
    statusCheck: check(
      'support_tickets_status_check',
      sql`${t.status} IN ('open','answered','closed')`,
    ),
    queueIdx: index('support_tickets_queue_idx').on(t.status, sql`${t.createdAt} DESC`),
    byUserIdx: index('support_tickets_by_user_idx').on(t.userId, sql`${t.createdAt} DESC`),
    // GC anti-join shield for the optional screenshot (the 0009 rule).
    attachmentIdx: index('support_tickets_attachment_idx')
      .on(t.attachmentId)
      .where(sql`${t.attachmentId} IS NOT NULL`),
  }),
);

// ================================ auth pack ==================================
// v0.9 (migration 0011, API.md §1.70–§1.74, ADR-021, FEATURES #82–#86). New
// ways to MINT a session — the ADR-001 session layer itself (opaque sha256
// token, sid cookie, sliding expiry, 4401 revocation) is untouched.

// §1.70 passkeys (WebAuthn, #82). credential_id/public_key are the base64url
// strings @simplewebauthn/server emits (ADR-021 pins the library). counter is
// the authenticator signature counter — a verify that comes back LOWER than
// the stored value is a cloned-credential signal: refuse (401
// bad_credentials) + ring-log. Cap PASSKEYS_MAX per user is route-enforced
// under pg_advisory_xact_lock(hashtextextended(user_id::text, 82)) — the
// TROUBLESHOOTING counter-race rule, never check-then-insert.
export const passkeyCredentials = pgTable(
  'passkey_credentials',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(), // base64url COSE blob — verified against, not a secret
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
    deviceType: text('device_type').notNull().default('singleDevice'),
    backedUp: boolean('backed_up').notNull().default(false),
    nickname: text('nickname'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastUsedAt: timestamptz('last_used_at'),
  },
  (t) => ({
    counterCheck: check('passkey_credentials_counter_check', sql`${t.counter} >= 0`),
    deviceTypeCheck: check(
      'passkey_credentials_device_type_check',
      sql`${t.deviceType} IN ('singleDevice','multiDevice')`,
    ),
    nicknameCheck: check(
      'passkey_credentials_nickname_check',
      sql`char_length(${t.nickname}) BETWEEN 1 AND 32`, // PASSKEY_NICKNAME_MAX_CHARS
    ),
    credentialIdx: uniqueIndex('passkey_credentials_credential_idx').on(t.credentialId),
    userIdx: index('passkey_credentials_user_idx').on(t.userId, t.createdAt),
  }),
);

// §1.71 QR / cross-device login links (#83). TWO hashed codes per row:
// code_hash = sha256 of the 32-byte secret that rides the QR URL and is the
// laptop's poll/redeem capability; display_code_hash = sha256 of the
// normalized 6-char human code (approve-only — its small keyspace can never
// poll or redeem). No user_id at creation (the laptop is anonymous);
// approved_by is the phone. status is a ONE-WAY pending → approved →
// consumed walk, each step an atomic UPDATE ... WHERE status='<prev>'
// RETURNING. user_agent/ip are the LAPTOP's, captured so the phone's approve
// sheet shows what it is logging in. TTL LOGIN_LINK_TTL_S (120 s); gc deletes
// rows an hour past expiry.
export const loginLinks = pgTable(
  'login_links',
  {
    id: uuid('id').primaryKey(),
    codeHash: text('code_hash').notNull(),
    displayCodeHash: text('display_code_hash').notNull(),
    status: text('status').notNull().default('pending'),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    newSessionId: uuid('new_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => ({
    statusCheck: check(
      'login_links_status_check',
      sql`${t.status} IN ('pending','approved','consumed')`,
    ),
    codeIdx: uniqueIndex('login_links_code_idx').on(t.codeHash),
    displayCodeIdx: uniqueIndex('login_links_display_code_idx').on(t.displayCodeHash),
    expiresIdx: index('login_links_expires_idx').on(t.expiresAt),
  }),
);

// §1.72 recovery codes (#84). RECOVERY_CODES_COUNT (6) per generation, shown
// ONCE; rows store sha256 of the normalized code (the ADR-001 token
// doctrine). Regeneration deletes + reinserts in one tx; consumption is the
// atomic UPDATE ... WHERE used_at IS NULL RETURNING — a code can never be
// spent twice.
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    usedAt: timestamptz('used_at'),
  },
  (t) => ({
    codeIdx: uniqueIndex('recovery_codes_code_idx').on(t.codeHash),
    userIdx: index('recovery_codes_user_idx').on(t.userId),
  }),
);
