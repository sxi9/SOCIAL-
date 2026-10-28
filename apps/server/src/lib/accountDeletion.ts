// Wave 1 (AUDIT-PLAN §1.2, migration 0018, 2026-10-28): account deletion.
// DELETE /api/users/me schedules (scheduled_deletion_at = now + grace) and
// signs every device out; a successful login inside the grace cancels it;
// the nightly GC calls purgeDueDeletions(), which TOMBSTONES the row rather
// than deleting it: messages the person sent in other people's chats keep
// their sender (shown as "Deleted account"), reports keep their trail, and
// nothing cascades by surprise (attachments.uploader_id cascades on a hard
// delete — a message's photo would vanish from a chat that survives).
//
// What goes: identity (username, email, display name, bio, avatar objects,
// interests, area, mood, password, TOTP, passkeys/recovery via FK on the
// row they reference — sessions and push subs explicitly), everything the
// person authored on their own (posts, listings, plans, stories, profile
// entries/media, discovery opt-in, scheduled messages), every share token
// they minted, their memberships (left_at), and the media objects that were
// theirs alone (refcount-guarded like every other delete).
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { deleteObject } from '../s3.js';
import { deleteAttachmentObjects } from '../jobs/gc.js';
import { hardDeletePost } from '../modules/feed/service.js';
import { hardDeleteStory } from '../modules/stories/service.js';
import { ARGON2_OPTS, revokeAllSessions } from '../modules/auth/service.js';

export const DELETED_DISPLAY_NAME = 'Deleted account';

/** Tombstone one account now. Idempotent (a second run finds nothing left). */
export async function tombstoneUser(userId: string): Promise<void> {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u || u.deletedAt !== null) return;

  // 0. The identity scrub goes FIRST and alone: if anything below fails
  //    (an S3 hiccup, a surprise FK) the account is already dead to the
  //    world — never half-deleted-but-signable-in. The username is the
  //    full 32-hex id (40 chars — unregistrable under USERNAME_REGEX's 24),
  //    the email a reserved domain ChangeEmail refuses, the password a real
  //    argon2 hash of 32 random bytes (argon2.verify never throws on it),
  //    banned_at so every §1.41 invisibility rule applies unchanged.
  const tag = userId.replace(/-/g, '');
  const deadHash = await argon2.hash(randomBytes(32).toString('base64url'), ARGON2_OPTS);
  await db.execute(sql`
    UPDATE users SET
      username = ${'deleted_' + tag},
      email = ${'deleted_' + tag + '@deleted.invalid'},
      email_verified_at = NULL,
      password_hash = ${deadHash},
      display_name = ${DELETED_DISPLAY_NAME},
      bio = '',
      avatar_status = 'none', avatar_static_key = NULL, avatar_animated_key = NULL,
      avatar_version = avatar_version + 1,
      area = NULL,
      interests = '{}'::text[],
      mood_emoji = NULL, mood_label = NULL, mood_kind = NULL, mood_swing_set = NULL,
      mood_expires_at = NULL, mood_swing_rotated_at = NULL,
      totp_secret = NULL, totp_enabled_at = NULL,
      registration_ip = NULL,
      is_admin = false,
      suspended_at = COALESCE(suspended_at, now()),
      banned_at = COALESCE(banned_at, now()),
      scheduled_deletion_at = NULL,
      deleted_at = now(),
      updated_at = now()
    WHERE id = ${userId}
  `);

  // 1. Doors shut first: sessions (sockets close 4401), push, the WebAuthn
  //    and recovery material.
  await revokeAllSessions(userId);
  await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId));
  await db.delete(schema.passkeyCredentials).where(eq(schema.passkeyCredentials.userId, userId));
  await db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId));

  // 2. Authored objects, through their own hard-delete paths (share tokens
  //    revoke, comment media release, story views/overlays cascade).
  const posts = await db.select().from(schema.posts).where(eq(schema.posts.authorId, userId));
  for (const p of posts) await hardDeletePost(p);
  const stories = await db.select().from(schema.stories).where(eq(schema.stories.authorId, userId));
  for (const s of stories) await hardDeleteStory(s);
  const listingAtts = await db
    .select()
    .from(schema.attachments)
    .where(sql`${schema.attachments.listingId} IN (SELECT id FROM listings WHERE author_id = ${userId})`);
  await db.execute(sql`
    UPDATE share_tokens SET revoked_at = now()
    WHERE revoked_at IS NULL AND (
      created_by = ${userId}
      OR (object_type = 'profile' AND object_id = ${userId})
      OR (object_type = 'listing' AND object_id IN (SELECT id FROM listings WHERE author_id = ${userId}))
      OR (object_type = 'beacon' AND object_id IN (SELECT id FROM beacons WHERE creator_id = ${userId}))
    )
  `);
  await db.execute(sql`DELETE FROM attachments WHERE listing_id IN (SELECT id FROM listings WHERE author_id = ${userId})`);
  await db.delete(schema.listings).where(eq(schema.listings.authorId, userId));
  await db.delete(schema.beacons).where(eq(schema.beacons.creatorId, userId));
  await db.delete(schema.scheduledMessages).where(eq(schema.scheduledMessages.authorId, userId));
  await db.delete(schema.profileEntries).where(eq(schema.profileEntries.userId, userId));
  await db.delete(schema.profileMedia).where(eq(schema.profileMedia.userId, userId));
  await db.delete(schema.discoveryOptins).where(eq(schema.discoveryOptins.userId, userId));
  await db.delete(schema.connections).where(
    sql`${schema.connections.requesterId} = ${userId} OR ${schema.connections.addresseeId} = ${userId}`,
  );
  for (const att of listingAtts) await deleteAttachmentObjects(att);

  // 3. Leave every conversation (the row stays for history; no system
  //    message — a tombstone is not a departure anyone needs pinged about).
  await db.execute(sql`
    UPDATE conversation_participants cp SET
      left_at = now(),
      left_seq = c.last_seq
    FROM conversations c
    WHERE c.id = cp.conversation_id AND cp.user_id = ${userId} AND cp.left_at IS NULL
  `);

  // 4. Media that was theirs alone: attachments they uploaded that nothing
  //    binds any more (their own posts/listings/stories are gone above; a
  //    photo inside someone else's chat stays bound to that message).
  const loose = await db
    .select()
    .from(schema.attachments)
    .where(
      sql`${schema.attachments.uploaderId} = ${userId}
        AND ${schema.attachments.messageId} IS NULL
        AND ${schema.attachments.postId} IS NULL
        AND ${schema.attachments.listingId} IS NULL
        AND ${schema.attachments.commentId} IS NULL
        AND ${schema.attachments.scheduledMessageId} IS NULL
        AND ${schema.attachments.shareImportId} IS NULL
        AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.attachment_id = ${schema.attachments.id})
        AND NOT EXISTS (SELECT 1 FROM profile_media pm WHERE pm.attachment_id = ${schema.attachments.id})`,
    );
  for (const att of loose) {
    await db.delete(schema.attachments).where(eq(schema.attachments.id, att.id));
    await deleteAttachmentObjects(att);
  }

  // 5. The avatar objects (not content-hashed through attachments).
  for (const key of [u.avatarStaticKey, u.avatarAnimatedKey]) {
    if (key) await deleteObject(key).catch(() => undefined);
  }

  // 6. (The identity scrub ran first — see step 0.)
}

/** The nightly sweep: every account whose grace has run out. */
export async function purgeDueDeletions(now = Date.now()): Promise<number> {
  const due = (await db.execute(sql`
    SELECT id FROM users
    WHERE scheduled_deletion_at IS NOT NULL AND scheduled_deletion_at <= ${new Date(now).toISOString()}::timestamptz
      AND deleted_at IS NULL
    LIMIT 200
  `)) as unknown as { id: string }[];
  let done = 0;
  for (const row of due) {
    // One poison row must never block the batch or the rest of the GC.
    try {
      await tombstoneUser(row.id);
      done += 1;
    } catch (err) {
      console.error('accountDeletion: tombstone failed', { userId: row.id, err });
    }
  }
  return done;
}
