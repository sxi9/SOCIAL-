import type { PreviewStatus, ShareImport } from '@socialchat/shared';
import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { attachmentDto } from '../../lib/dto.js';
import { enqueueMedia } from '../../queues.js';
import {
  addPreviewWaiter,
  lookupPreview,
  previewDto,
  requestUnfurl,
  type LinkPreviewRow,
  type PreviewLookup,
} from '../previews/service.js';
import type { ProcessedFile } from '../uploads/pipeline.js';

export type ShareImportRow = typeof schema.shareImports.$inferSelect;

function previewState(row: LinkPreviewRow): { status: PreviewStatus; ok: boolean } {
  if (row.status === 'pending') return { status: 'pending', ok: false };
  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
  if (expired) return { status: 'pending', ok: false };
  return { status: row.status as PreviewStatus, ok: row.status === 'ok' };
}

export async function shareImportDto(row: ShareImportRow): Promise<ShareImport> {
  const atts = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.shareImportId, row.id))
    .orderBy(asc(schema.attachments.createdAt));

  let preview: ShareImport['preview'] = null;
  if (row.previewUrlHash) {
    const [previewRow] = await db
      .select()
      .from(schema.linkPreviews)
      .where(eq(schema.linkPreviews.urlHash, row.previewUrlHash))
      .limit(1);
    if (previewRow) {
      const state = previewState(previewRow);
      preview = {
        status: state.status,
        ...(state.ok ? { preview: previewDto(previewRow) } : {}),
      };
    }
  }

  return {
    id: row.id,
    title: row.title,
    text_body: row.textBody,
    url: row.url,
    status: row.status as ShareImport['status'],
    attachments: atts.map(attachmentDto),
    preview,
    created_at: row.createdAt.toISOString(),
  };
}

export interface ShareFields {
  title?: string;
  text?: string;
  url?: string;
}

/**
 * Persist a share_imports row + its attachments, enqueue the unfurl eagerly
 * when a URL is present (ARCHITECTURE §6).
 */
export async function createShareImport(
  userId: string,
  fields: ShareFields,
  files: ProcessedFile[],
): Promise<ShareImportRow> {
  let previewUrlHash: string | null = null;
  let unfurlLookup: PreviewLookup | null = null;
  let storedUrl: string | null = fields.url?.trim() ? fields.url.trim() : null;

  if (storedUrl) {
    try {
      const lookup = await lookupPreview(storedUrl);
      storedUrl = lookup.normalized;
      previewUrlHash = lookup.hash;
      if (lookup.state === 'miss') unfurlLookup = lookup;
      if (lookup.state === 'miss' || lookup.state === 'pending') {
        // Another requester may own the in-flight fetch; this user still gets
        // preview.ready when it lands.
        await addPreviewWaiter(lookup.hash, userId);
      }
    } catch {
      previewUrlHash = null; // unparseable URL: keep the text, no card
    }
  }

  const importId = newId();
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.shareImports)
      .values({
        id: importId,
        userId,
        title: fields.title?.trim() ? fields.title.trim() : null,
        textBody: fields.text?.trim() ? fields.text.trim() : null,
        url: storedUrl,
        previewUrlHash,
      })
      .returning();
    if (files.length > 0) {
      await tx.insert(schema.attachments).values(
        files.map((f) => ({
          id: newId(),
          uploaderId: userId,
          shareImportId: importId,
          kind: f.kind,
          originalKey: f.originalKey,
          thumbKey: f.thumbKey,
          blurhash: f.blurhash,
          mime: f.mime,
          fileName: f.fileName,
          sizeBytes: f.sizeBytes,
          width: f.width,
          height: f.height,
          status: f.status,
        })),
      );
    }
    return inserted!;
  });

  const videoAtts = await db
    .select({ id: schema.attachments.id })
    .from(schema.attachments)
    .where(
      and(eq(schema.attachments.shareImportId, importId), eq(schema.attachments.kind, 'video')),
    );
  for (const v of videoAtts) await enqueueMedia({ attachment_id: v.id });

  if (unfurlLookup) {
    // Shared chokepoint: charges the 30/hour/user unfurl budget (creation AND
    // claim both land here). Over budget the import still persists — there is
    // simply no eager fetch; the card can be requested again later.
    await requestUnfurl({ userId, lookup: unfurlLookup });
  }
  return row;
}
