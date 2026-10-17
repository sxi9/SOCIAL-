// Connections (v0.5a — API.md §1.28, ADR-011). One row per UNORDERED pair,
// 'pending' until the addressee accepts. Declines DELETE the row and are
// SILENT to the requester (no rejection ping — PSYCHOLOGY §9 liking gap);
// removals are silent to the other party the same way. Blocked pairs are
// 404-shaped everywhere (§1.14); a block deletes pending rows (blocks module)
// and makes accepted rows DORMANT (filtered at read time — friends-of and
// this list both exclude them; the row survives, unblocking restores it).
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CONNECTION_REQUEST_RATE_PER_HOUR,
  type Connection,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { blockedSetOf, isBlockedPair } from '../../lib/blocks.js';
import { userLiteDto, type UserRow } from '../../lib/dto.js';
import { badRequest, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { enqueueSocialPush } from '../../queues.js';
import { publishToUsers } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';

const IdParams = z.object({ id: z.string().uuid() });
const cx = schema.connections;

export type ConnectionRow = typeof schema.connections.$inferSelect;

/** Viewer-specific DTO: `user` is the OTHER party; direction says who asked. */
export function connectionDto(row: ConnectionRow, viewerId: string, other: UserRow): Connection {
  return {
    id: row.id,
    user: userLiteDto(other),
    direction: row.requesterId === viewerId ? 'outgoing' : 'incoming',
    status: row.status as Connection['status'],
    created_at: row.createdAt.toISOString(),
    responded_at: row.respondedAt ? row.respondedAt.toISOString() : null,
  };
}

async function loadUser(id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return row ?? null;
}

async function pairRow(a: string, b: string): Promise<ConnectionRow | null> {
  const [row] = (await db.execute(sql`
    SELECT * FROM connections
    WHERE LEAST(requester_id, addressee_id) = LEAST(${a}::uuid, ${b}::uuid)
      AND GREATEST(requester_id, addressee_id) = GREATEST(${a}::uuid, ${b}::uuid)
    LIMIT 1
  `)) as unknown as Record<string, unknown>[];
  return row ? rawToConnectionRow(row) : null;
}

function rawToConnectionRow(r: Record<string, unknown>): ConnectionRow {
  return {
    id: r.id as string,
    requesterId: r.requester_id as string,
    addresseeId: r.addressee_id as string,
    status: r.status as string,
    createdAt: new Date(r.created_at as string | Date),
    respondedAt: r.responded_at ? new Date(r.responded_at as string | Date) : null,
  };
}

/**
 * §2.3 connection.updated — per-viewer stamped (the beacon.* pattern), to the
 * EXACT per-transition sets only: request → addressee + requester's own
 * sockets; accept → both; decline → addressee's own sockets only; remove →
 * the actor's own sockets only.
 */
async function fanConnection(
  row: ConnectionRow,
  recipients: string[],
  removed: boolean,
): Promise<void> {
  const [requester, addressee] = await Promise.all([
    loadUser(row.requesterId),
    loadUser(row.addresseeId),
  ]);
  if (!requester || !addressee) return;
  for (const userId of [...new Set(recipients)]) {
    const other = userId === row.requesterId ? addressee : requester;
    await publishToUsers([userId], {
      t: 'connection.updated',
      d: { connection: connectionDto(row, userId, other), removed },
    });
  }
}

export async function connectionRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.28 POST /api/users/:id/connect — request (or accept a counter-request).
  app.post(
    '/api/users/:id/connect',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const targetId = req.params.id;
      if (targetId === user.id) throw badRequest('connect_self');
      const rate = await fixedWindow(
        `connreq:${user.id}`,
        CONNECTION_REQUEST_RATE_PER_HOUR,
        3600,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const target = await loadUser(targetId);
      // §1.14: unknown id and blocked pair are byte-identical 404s.
      if (!target) throw notFound('not_found');
      if (await isBlockedPair(user.id, targetId)) throw notFound('not_found');

      const existing = await pairRow(user.id, targetId);
      if (existing) {
        if (existing.status === 'pending' && existing.addresseeId === user.id) {
          // The target already asked ME — this ACCEPTS it (§1.28).
          return reply.status(200).send(await acceptRow(existing, user.id));
        }
        // Idempotent re-request of a pending/accepted pair → the current row.
        return reply.status(200).send({
          connection: connectionDto(existing, user.id, target),
        });
      }

      const row: ConnectionRow = {
        id: newId(),
        requesterId: user.id,
        addresseeId: targetId,
        status: 'pending',
        createdAt: new Date(),
        respondedAt: null,
      };
      try {
        await db.insert(cx).values({
          id: row.id,
          requesterId: row.requesterId,
          addresseeId: row.addresseeId,
          status: 'pending',
          createdAt: row.createdAt,
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          // Concurrent cross-requests: the pair index is the arbiter — the
          // loser gets the winner's row back (200).
          const raced = await pairRow(user.id, targetId);
          if (raced) {
            return reply.status(200).send({
              connection: connectionDto(raced, user.id, target),
            });
          }
        }
        throw err;
      }

      // request → addressee + requester's own sockets; push the invitation
      // (presence + debounce guards re-check in the worker, §2.9).
      await fanConnection(row, [row.requesterId, row.addresseeId], false);
      await enqueueSocialPush({
        kind: 'social',
        user_id: targetId,
        dedupe_key: `connreq:${row.id}`,
        title: user.username,
        body: 'wants to connect',
        url: '/connections',
      });
      return reply.status(201).send({ connection: connectionDto(row, user.id, target) });
    },
  );

  async function acceptRow(
    row: ConnectionRow,
    accepterId: string,
  ): Promise<{ connection: Connection }> {
    const [updated] = (await db.execute(sql`
      UPDATE connections SET status = 'accepted', responded_at = now()
      WHERE id = ${row.id} AND status = 'pending'
      RETURNING *
    `)) as unknown as Record<string, unknown>[];
    const fresh = updated ? rawToConnectionRow(updated) : row;
    const other = await loadUser(
      fresh.requesterId === accepterId ? fresh.addresseeId : fresh.requesterId,
    );
    if (!other) throw notFound('not_found');
    // accept → both parties' sockets; push the answer to the requester.
    await fanConnection(fresh, [fresh.requesterId, fresh.addresseeId], false);
    const [accepter] = await db
      .select({ username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, accepterId))
      .limit(1);
    await enqueueSocialPush({
      kind: 'social',
      user_id: fresh.requesterId === accepterId ? fresh.addresseeId : fresh.requesterId,
      dedupe_key: `connacc:${fresh.id}`,
      title: accepter?.username ?? 'Connection',
      body: 'accepted your request',
      url: '/connections',
    });
    return { connection: connectionDto(fresh, accepterId, other) };
  }

  // §1.28 POST /api/connections/:id/accept — addressee only.
  app.post(
    '/api/connections/:id/accept',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const [row] = await db.select().from(cx).where(eq(cx.id, req.params.id)).limit(1);
      // Not mine / not pending / requester blocked meanwhile — one 404 shape.
      if (!row || row.addresseeId !== user.id || row.status !== 'pending') throw notFound('not_found');
      if (await isBlockedPair(user.id, row.requesterId)) throw notFound('not_found');
      return reply.status(200).send(await acceptRow(row, user.id));
    },
  );

  // §1.28 POST /api/connections/:id/decline — DELETES the row; SILENT to the
  // requester (own-sockets frame to the addressee only — no rejection ping).
  app.post(
    '/api/connections/:id/decline',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const [row] = await db.select().from(cx).where(eq(cx.id, req.params.id)).limit(1);
      if (!row || row.addresseeId !== user.id || row.status !== 'pending') throw notFound('not_found');
      await db.delete(cx).where(eq(cx.id, row.id));
      await fanConnection(row, [user.id], true);
      return reply.status(204).send();
    },
  );

  // §1.28 DELETE /api/connections/:id — remove an accepted connection, or
  // cancel my own pending request. Idempotent; silent to the other party
  // (actor's own sockets only).
  app.delete(
    '/api/connections/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const [row] = await db.select().from(cx).where(eq(cx.id, req.params.id)).limit(1);
      if (!row) return reply.status(204).send(); // idempotent re-remove
      const mine = row.requesterId === user.id || row.addresseeId === user.id;
      if (!mine) throw notFound('not_found');
      // A pending request is cancellable by its REQUESTER only (the addressee
      // declines instead — same deletion, different silence set).
      if (row.status === 'pending' && row.requesterId !== user.id) throw notFound('not_found');
      await db.delete(cx).where(eq(cx.id, row.id));
      await fanConnection(row, [user.id], true);
      return reply.status(204).send();
    },
  );

  // §1.28 GET /api/connections — accepted (by username), pending-to-me and
  // my-pending (created_at ASC). Rows involving blocked users are OMITTED
  // (dormant, §1.14 — the row survives for unblocking).
  app.get('/api/connections', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = (await db.execute(sql`
      SELECT c.*, row_to_json(u.*) AS other
      FROM connections c
      JOIN users u ON u.id = CASE WHEN c.requester_id = ${user.id} THEN c.addressee_id ELSE c.requester_id END
      WHERE c.requester_id = ${user.id} OR c.addressee_id = ${user.id}
      ORDER BY c.created_at ASC
    `)) as unknown as (Record<string, unknown> & { other: Record<string, unknown> })[];
    const blocked = await blockedSetOf(user.id);

    const connections: { username: string; dto: Connection }[] = [];
    const incoming: Connection[] = [];
    const outgoing: Connection[] = [];
    for (const r of rows) {
      const row = rawToConnectionRow(r);
      const o = r.other;
      const other: UserRow = {
        id: o.id as string,
        username: o.username as string,
        displayName: o.display_name as string,
        avatarStatus: o.avatar_status as string,
        avatarVersion: Number(o.avatar_version),
        avatarStaticKey: (o.avatar_static_key as string | null) ?? null,
        avatarAnimatedKey: (o.avatar_animated_key as string | null) ?? null,
      } as UserRow;
      if (blocked.has(other.id)) continue;
      const dto = connectionDto(row, user.id, other);
      if (row.status === 'accepted') connections.push({ username: other.username, dto });
      else if (row.addresseeId === user.id) incoming.push(dto);
      else outgoing.push(dto);
    }
    connections.sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
    return {
      connections: connections.map((c) => c.dto),
      incoming,
      outgoing,
    };
  });
}
