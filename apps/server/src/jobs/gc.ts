// Nightly GC (ARCHITECTURE §5): orphan attachments, expired share imports,
// expired link previews (+ images), expired sessions, abandoned stash objects.
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  ORPHAN_ATTACHMENT_TTL_H,
  SHARE_IMPORT_TTL_DAYS,
} from '@socialchat/shared';
import { db, schema } from '../db/index.js';
import { deleteObject, listKeys } from '../s3.js';
import type { AttRow } from '../lib/dto.js';

/** Content-hashed keys can be shared across rows — delete only unreferenced objects. */
async function deleteAttachmentObjects(att: AttRow): Promise<void> {
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

async function deleteAttachmentsFully(rows: AttRow[]): Promise<void> {
  for (const att of rows) {
    await deleteAttachmentObjects(att);
    await db.delete(schema.attachments).where(eq(schema.attachments.id, att.id));
  }
}

export async function runGc(): Promise<void> {
  const now = Date.now();

  // 1. Orphan attachments: unbound, un-shared, older than 24 h (+ objects).
  const orphanCutoff = new Date(now - ORPHAN_ATTACHMENT_TTL_H * 3600 * 1000);
  const orphans = await db
    .select()
    .from(schema.attachments)
    .where(
      and(
        isNull(schema.attachments.messageId),
        isNull(schema.attachments.shareImportId),
        lt(schema.attachments.createdAt, orphanCutoff),
      ),
    );
  await deleteAttachmentsFully(orphans);

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
