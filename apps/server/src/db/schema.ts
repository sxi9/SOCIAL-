// Drizzle schema — mirrors docs/SCHEMA.sql table-for-table, column-for-column.
// Migrations are hand-written SQL (src/db/migrations); this file is the typed
// query surface.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
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
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    typeCheck: check('conversations_type_check', sql`${t.type} IN ('dm','group')`),
    avatarStatusCheck: check(
      'conversations_avatar_status_check',
      sql`${t.avatarStatus} IN ('none','processing','ready','failed')`,
    ),
    dmKeyCheck: check('conversations_dm_key_check', sql`(${t.type} = 'dm') = (${t.dmKey} IS NOT NULL)`),
    activityIdx: index('conversations_activity_idx').on(sql`${t.lastMessageAt} DESC NULLS LAST`),
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
    typeCheck: check(
      'messages_type_check',
      sql`${t.type} IN ('text','image','video','file','system')`,
    ),
    idempotencyIdx: uniqueIndex('messages_idempotency_idx')
      .on(t.conversationId, t.senderId, t.clientMsgId)
      .where(sql`${t.clientMsgId} IS NOT NULL`),
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
    status: text('status').notNull().default('pending'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check('attachments_kind_check', sql`${t.kind} IN ('image','video','file')`),
    statusCheck: check('attachments_status_check', sql`${t.status} IN ('pending','ready','failed')`),
    messageIdx: index('attachments_message_idx').on(t.messageId),
    orphanIdx: index('attachments_orphan_idx')
      .on(t.createdAt)
      .where(sql`${t.messageId} IS NULL AND ${t.shareImportId} IS NULL`),
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
