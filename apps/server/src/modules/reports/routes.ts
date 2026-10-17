// Reports (v0.3 — API.md §1.14). An audit log for the future admin dashboard
// (FEATURES #54): targets are stored WITHOUT foreign keys so a report survives
// deletion of what it reports. No fan-out, no notification to anyone, ever.
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { CreateReportRequestSchema, REPORT_RATE_PER_HOUR } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { isFriendOf } from '../../lib/friends.js';
import { notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import { hasJoin, isBeaconVisibleTo, loadBeacon } from '../beacons/service.js';

export async function reportRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.14 POST /api/reports — target must be referenceable by the reporter
  // (message: §1.5 visibility floor; beacon: §1.15-visible or previously
  // joined; user: exists). Rate 10/hour/user.
  app.post(
    '/api/reports',
    { preHandler: requireAuth, schema: { body: CreateReportRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`report:${user.id}`, REPORT_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const body = req.body;

      const values: typeof schema.reports.$inferInsert = {
        id: newId(),
        reporterId: user.id,
        kind: body.kind,
        reason: body.reason,
      };

      if (body.kind === 'user') {
        const [target] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.id, body.user_id))
          .limit(1);
        if (!target) throw notFound();
        values.targetUserId = body.user_id;
      } else if (body.kind === 'message') {
        const part = await getParticipant(body.conversation_id, user.id);
        if (!part || part.leftAt !== null) throw notFound();
        const m = schema.messages;
        const [msg] = await db
          .select({ seq: m.seq })
          .from(m)
          .where(
            and(
              eq(m.conversationId, body.conversation_id),
              eq(m.seq, body.seq),
              gt(m.seq, part.joinSeq),
            ),
          )
          .limit(1);
        if (!msg) throw notFound();
        values.targetConversationId = body.conversation_id;
        values.targetSeq = body.seq;
        // v0.8b (§1.69): the reporter's EXPLICIT consent to disclose the
        // ± REPORT_CONTEXT_RADIUS slice to the admin context viewer. Default
        // false; the report sends fine without it.
        values.contextConsent = body.include_context;
      } else if (body.kind === 'anon_message') {
        // v0.8b (§1.62): reporter must be a PARTY of the thread, the message
        // the OTHER party's. The server STAMPS target_user_id = the reported
        // author (migration 0010's shape CHECK makes an identity-less anon
        // report unrepresentable). Anonymity never survives a report.
        const [thread] = await db
          .select()
          .from(schema.anonThreads)
          .where(eq(schema.anonThreads.id, body.thread_id))
          .limit(1);
        if (!thread || (thread.senderId !== user.id && thread.recipientId !== user.id)) {
          throw notFound();
        }
        const [msg] = await db
          .select()
          .from(schema.anonMessages)
          .where(
            and(
              eq(schema.anonMessages.id, body.message_id),
              eq(schema.anonMessages.threadId, thread.id),
            ),
          )
          .limit(1);
        if (!msg) throw notFound();
        const authorId = msg.fromSender ? thread.senderId : thread.recipientId;
        if (authorId === user.id) throw notFound(); // only the OTHER party's words
        values.targetAnonThreadId = thread.id;
        values.targetAnonMessageId = msg.id;
        values.targetUserId = authorId; // the SERVER-ATTACHED identity (#77)
      } else if (body.kind === 'story_overlay') {
        // v0.8b (§1.66): any viewer of the story; the overlay author is the
        // attached identity. Removed overlays stay reportable while the story
        // lives (the tombstone exists for exactly this).
        const [story] = await db
          .select()
          .from(schema.stories)
          .where(eq(schema.stories.id, body.story_id))
          .limit(1);
        if (!story) throw notFound();
        const visible =
          story.authorId === user.id ||
          (story.expiresAt.getTime() > Date.now() && (await isFriendOf(user.id, story.authorId)));
        if (!visible) throw notFound();
        const [overlay] = await db
          .select()
          .from(schema.storyOverlays)
          .where(
            and(
              eq(schema.storyOverlays.id, body.overlay_id),
              eq(schema.storyOverlays.storyId, story.id),
            ),
          )
          .limit(1);
        if (!overlay) throw notFound();
        values.targetObjectType = 'story';
        values.targetObjectId = story.id;
        values.targetOverlayId = overlay.id;
        values.targetUserId = overlay.authorId; // the SERVER-ATTACHED author
      } else {
        const beacon = await loadBeacon(body.beacon_id);
        if (!beacon) throw notFound();
        const referenceable =
          (await isBeaconVisibleTo(beacon, user)) || (await hasJoin(beacon.id, user.id));
        if (!referenceable) throw notFound();
        values.targetBeaconId = body.beacon_id;
      }

      const [row] = await db.insert(schema.reports).values(values).returning();
      return reply.status(201).send({ id: row!.id });
    },
  );
}
