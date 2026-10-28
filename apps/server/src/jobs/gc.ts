// Nightly GC (ARCHITECTURE §5): orphan attachments, expired share imports,
// expired link previews (+ images), expired sessions, abandoned stash objects.
// v0.5b (§1.41): + the IP retention sweep (users.registration_ip, sessions.ip).
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  ACTIVITY_RETENTION_DAYS,
  IP_RETENTION_DAYS,
  ORPHAN_ATTACHMENT_TTL_H,
  SHARE_IMPORT_TTL_DAYS,
} from '@socialchat/shared';
import { db, schema } from '../db/index.js';
import { deleteObject, listKeys } from '../s3.js';
import { pruneDeadShareTokens } from '../modules/sharepages/service.js';
import { purgeDueDeletions } from '../lib/accountDeletion.js';
import type { AttRow } from '../lib/dto.js';

/** Content-hashed keys can be shared across rows — delete only unreferenced
 * objects. Also used by the v0.4 disappearing sweep (jobs/timers.ts). */
export async function deleteAttachmentObjects(att: AttRow): Promise<void> {
  for (const key of [att.originalKey, att.thumbKey]) {
    if (!key) continue;
    const [other] = await db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(
        and(
          ne(schema.attachments.id, att.id),
          or(eq(schema.attachments.originalKey, key), eq(schema.attachments.thumbKey, key)),
        ),
      )
      .limit(1);
    if (!other) await deleteObject(key);
  }
}

export async function deleteAttachmentsFully(rows: AttRow[]): Promise<void> {
  for (const att of rows) {
    await deleteAttachmentObjects(att);
    await db.delete(schema.attachments).where(eq(schema.attachments.id, att.id));
  }
}

/**
 * v0.5b IP retention (API.md §1.41, FEATURES #54): nulls users.registration_ip
 * and sessions.ip older than IP_RETENTION_DAYS, counted from the ROW's
 * created_at — young rows keep theirs (the admin UI shows whatever has not
 * aged out, never more). Exported separately so tests can run it without the
 * MinIO-dependent object sweeps below.
 */
export async function runIpRetention(now = Date.now()): Promise<void> {
  const cutoffIso = new Date(now - IP_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  await db.execute(sql`
    UPDATE users SET registration_ip = NULL
    WHERE registration_ip IS NOT NULL AND created_at < ${cutoffIso}::timestamptz
  `);
  await db.execute(sql`
    UPDATE sessions SET ip = NULL
    WHERE ip IS NOT NULL AND created_at < ${cutoffIso}::timestamptz
  `);
  // Wave 1 (§1.5): the non-user share-page report's IP ages out on the
  // same sweep (the schema comment promised it since 0010).
  await db.execute(sql`
    UPDATE reports SET reporter_ip = NULL
    WHERE reporter_ip IS NOT NULL AND created_at < ${cutoffIso}::timestamptz
  `);
}

/**
 * v0.8a activity retention (API.md §1.59): hard-DELETE strip rows older than
 * ACTIVITY_RETENTION_DAYS (via activities_sweep_idx) — the strip is recent
 * activity, not an archive someone can scroll a life out of (ADR-018). No
 * fan-out: pull-based, no WS event exists for activity. Exported separately
 * so tests can run it without the MinIO-dependent object sweeps.
 */
export async function runActivityRetention(now = Date.now()): Promise<void> {
  const cutoff = new Date(now - ACTIVITY_RETENTION_DAYS * 24 * 3600 * 1000);
  await db.delete(schema.activities).where(lt(schema.activities.createdAt, cutoff));
}

/**
 * v0.9 login-link GC (API.md §1.71): hard-DELETE rows an hour past
 * expires_at. Every live read already refuses an expired row (410 link_gone);
 * this is purely row hygiene — and it bounds how long the recorded laptop
 * user_agent/ip live. Exported separately so tests can run it without the
 * MinIO-dependent object sweeps.
 */
export async function runLoginLinkGc(now = Date.now()): Promise<void> {
  await db.delete(schema.loginLinks).where(lt(schema.loginLinks.expiresAt, new Date(now - 3600 * 1000)));
}

export async function runGc(): Promise<void> {
  const now = Date.now();

  // 0. IP retention (§1.41) — the privacy sweep runs first, unconditionally.
  await runIpRetention(now);

  // 0b. v0.8a (§1.59): the 30-day activity-strip retention.
  await runActivityRetention(now);

  // 0c. Wave 1 (§1.2): accounts whose deletion grace has run out — never
  //     lets a failure stop the sweeps below.
  await purgeDueDeletions(now).catch((err) => console.error('gc: purgeDueDeletions failed', err));

  // 1. Orphan attachments: unbound (no message / share import / scheduled row
  //    / post), older than 24 h. v0.5a (migration 0005): the partial orphan
  //    index is a CANDIDATE list only — stories and profile media bind through
  //    their own tables, so indexed NOT EXISTS guards over
  //    stories.attachment_id and profile_media.attachment_id are the verdict.
  //    Object deletion stays refcount-guarded (§1.31 re-referencing).
  const orphanCutoff = new Date(now - ORPHAN_ATTACHMENT_TTL_H * 3600 * 1000);
  const orphans = await db
    .select()
    .from(schema.attachments)
    .where(
      and(
        isNull(schema.attachments.messageId),
        isNull(schema.attachments.shareImportId),
        isNull(schema.attachments.scheduledMessageId),
        isNull(schema.attachments.postId),
        // v0.5b (§1.38): room-listing photos bind via listing_id.
        isNull(schema.attachments.listingId),
        // v0.7 (§1.51): feed-comment images bind via comment_id.
        isNull(schema.attachments.commentId),
        lt(schema.attachments.createdAt, orphanCutoff),
        sql`NOT EXISTS (SELECT 1 FROM stories s WHERE s.attachment_id = ${schema.attachments.id})`,
        sql`NOT EXISTS (SELECT 1 FROM profile_media pm WHERE pm.attachment_id = ${schema.attachments.id})`,
        // v0.8a (§1.60): chat backgrounds cannot ride the binding-column
        // pattern (the reference points prefs→attachment and one upload may
        // back several of the owner's chats) — the sweep ANTI-JOINS
        // conversation_prefs_background_idx instead; clearing the last
        // reference re-orphans the attachment for the normal 24 h GC. The
        // one documented exception to the binding-column rule (ADR-018).
        sql`NOT EXISTS (SELECT 1 FROM conversation_prefs p WHERE p.background_attachment_id = ${schema.attachments.id})`,
        // v1.0a (#95): the conversation-level shared background — same
        // anti-join pattern as prefs (partial index 0012).
        sql`NOT EXISTS (SELECT 1 FROM conversations cb WHERE cb.shared_background_attachment_id = ${schema.attachments.id})`,
        // v1.0a (#94): gallery saves keep an attachment alive owner-private;
        // deleting the save re-orphans it into this very sweep.
        sql`NOT EXISTS (SELECT 1 FROM gallery_saves gs WHERE gs.attachment_id = ${schema.attachments.id})`,
        // v0.8b (§1.69, the 0009 pattern): support-ticket screenshots also
        // reference ticket→attachment — the sweep ANTI-JOINS
        // support_tickets_attachment_idx; SET NULL keeps the ticket when the
        // attachment eventually ages away.
        sql`NOT EXISTS (SELECT 1 FROM support_tickets t WHERE t.attachment_id = ${schema.attachments.id})`,
      ),
    );
  await deleteAttachmentsFully(orphans);

  // 1b. v0.8b (§1.67): prune share tokens whose object is gone (dead uuid) or
  //     whose story expired — bookkeeping only; reads already 404 live.
  await pruneDeadShareTokens();

  // 2. Share imports older than 7 days: expire the open ones, drop their
  //    still-unbound attachments, then prune non-open rows.
  const importCutoff = new Date(now - SHARE_IMPORT_TTL_DAYS * 24 * 3600 * 1000);
  await db
    .update(schema.shareImports)
    .set({ status: 'expired' })
    .where(and(eq(schema.shareImports.status, 'open'), lt(schema.shareImports.createdAt, importCutoff)));

  const staleRows = await db
    .select()
    .from(schema.attachments)
    .where(
      sql`${schema.attachments.id} IN (SELECT a.id FROM attachments a JOIN share_imports si ON si.id = a.share_import_id WHERE si.status <> 'open' AND a.message_id IS NULL AND si.created_at < ${importCutoff})`,
    );
  await deleteAttachmentsFully(staleRows);
  await db
    .delete(schema.shareImports)
    .where(and(ne(schema.shareImports.status, 'open'), lt(schema.shareImports.createdAt, importCutoff)));

  // 3. Link previews past expiry + 7 days: rows + images.
  const previewCutoff = new Date(now - 7 * 24 * 3600 * 1000);
  const deadPreviews = await db
    .select()
    .from(schema.linkPreviews)
    .where(lt(schema.linkPreviews.expiresAt, previewCutoff));
  for (const p of deadPreviews) {
    if (p.imageKey) {
      const [other] = await db
        .select({ urlHash: schema.linkPreviews.urlHash })
        .from(schema.linkPreviews)
        .where(
          and(eq(schema.linkPreviews.imageKey, p.imageKey), ne(schema.linkPreviews.urlHash, p.urlHash)),
        )
        .limit(1);
      if (!other) await deleteObject(p.imageKey);
    }
    await db.delete(schema.linkPreviews).where(eq(schema.linkPreviews.urlHash, p.urlHash));
  }

  // 4. Sessions past expires_at.
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date(now)));

  // 4b. v0.9 (§1.71): login links an hour past expiry — reads already answer
  //     410 the second expires_at passes; this sweep just drops the rows (and
  //     with them the laptop UA/IP, which therefore never outlive the
  //     IP-retention posture). Exported below for tests.
  await runLoginLinkGc(now);

  // 5. Stash objects whose Redis TTL (30 min) is long gone.
  const stashCutoff = new Date(now - 24 * 3600 * 1000);
  const stashObjects = await listKeys('stash/');
  for (const obj of stashObjects) {
    if (obj.lastModified && obj.lastModified < stashCutoff) await deleteObject(obj.key);
  }

  // 6. tmp/ upload leftovers from crashed requests.
  const tmpObjects = await listKeys('tmp/');
  for (const obj of tmpObjects) {
    if (obj.lastModified && obj.lastModified < stashCutoff) await deleteObject(obj.key);
  }
}
