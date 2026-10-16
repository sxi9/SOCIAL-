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
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    typeCheck: check('conversations_type_check', sql`${t.type} IN ('dm','group')`),
    avatarStatusCheck: check(
      'conversations_avatar_status_check',
      sql`${t.avatarStatus} IN ('none','processing','ready','failed')`,
    ),
    dmKeyCheck: check('conversations_dm_key_check', sql`(${t.type} = 'dm') = (${t.dmKey} IS NOT NULL)`),
    disappearTtlCheck: check(
      'conversations_disappear_ttl_s_check',
      sql`${t.disappearTtlS} IN (3600, 86400, 604800, 2592000)`,
    ),
    activityIdx: index('conversations_activity_idx').on(sql`${t.lastMessageAt} DESC NULLS LAST`),
    disappearingIdx: index('conversations_disappearing_idx')
      .on(t.id)
      .where(sql`${t.disappearTtlS} IS NOT NULL`),
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
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId] }),
    roleCheck: check('participants_role_check', sql`${t.role} IN ('member','admin')`),
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
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
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
    typeCheck: check(
      'messages_type_check',
      sql`${t.type} IN ('text','image','video','file','system','poll','audio','vibe_check','game_ttt','puzzle_result')`,
    ),
    // v0.4 (§1.22): metadata.effect pinned to the MESSAGE_EFFECTS set.
    metadataEffectCheck: check(
      'messages_metadata_effect_check',
      sql`NOT (${t.metadata} ? 'effect') OR ${t.metadata}->>'effect' IN ('confetti','hearts','fireworks','snow')`,
    ),
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
    orphanIdx: index('attachments_orphan_idx')
      .on(t.createdAt)
      .where(
        sql`${t.messageId} IS NULL AND ${t.shareImportId} IS NULL AND ${t.scheduledMessageId} IS NULL`,
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
    note: text('note').notNull().default(''),
    audience: text('audience').notNull(),
    // Creator-area snapshot; required iff audience = 'area'.
    area: citext('area'),
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
    vibeCheck: check(
      'beacons_vibe_check',
      sql`${t.vibe} IN ('food','chai','walk','game','movie','study','sport','chill')`,
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
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    targetUserId: uuid('target_user_id'),
    targetConversationId: uuid('target_conversation_id'),
    targetSeq: bigint('target_seq', { mode: 'number' }),
    targetBeaconId: uuid('target_beacon_id'),
    reason: text('reason').notNull().default(''),
    status: text('status').notNull().default('open'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check('reports_kind_check', sql`${t.kind} IN ('user','message','beacon')`),
    reasonCheck: check('reports_reason_check', sql`char_length(${t.reason}) <= 500`),
    statusCheck: check('reports_status_check', sql`${t.status} IN ('open','closed')`),
    targetCheck: check(
      'reports_target_check',
      sql`(${t.kind} = 'user' AND ${t.targetUserId} IS NOT NULL AND ${t.targetConversationId} IS NULL AND ${t.targetSeq} IS NULL AND ${t.targetBeaconId} IS NULL) OR (${t.kind} = 'message' AND ${t.targetConversationId} IS NOT NULL AND ${t.targetSeq} IS NOT NULL AND ${t.targetUserId} IS NULL AND ${t.targetBeaconId} IS NULL) OR (${t.kind} = 'beacon' AND ${t.targetBeaconId} IS NOT NULL AND ${t.targetUserId} IS NULL AND ${t.targetConversationId} IS NULL AND ${t.targetSeq} IS NULL)`,
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
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId] }),
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
