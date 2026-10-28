// Opaque DB sessions (ARCHITECTURE §4): 32 random bytes base64url in an
// httpOnly cookie, sha256 stored, 30-day sliding expiry.
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, ne, sql } from 'drizzle-orm';
import { WS_CLOSE_CODES } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { publishSessionClose, publishUserSessionsClose } from '../../ws/events.js';

// argon2id m=64MiB, t=3, p=1 (ARCHITECTURE §4).
export const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
} as const;

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// last_seen_at / sliding expiry written at most hourly to avoid write churn.
const TOUCH_INTERVAL_MS = 3600 * 1000;

export type SessionRow = typeof schema.sessions.$inferSelect;
export type UserRow = typeof schema.users.$inferSelect;

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** v0.9 (§1.71/§1.72): the sha256-base64url form the login_links and
 *  recovery_codes rows store (the migration-0011 contract — hex stays the
 *  sessions encoding above; both are the same ADR-001 doctrine). */
export function hashCode(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Wave 1 (§1.2): a session being minted IS the way back from a scheduled
 * deletion — password, passkey, TOTP-finished, recovery-reset and QR-link
 * logins all pass through here, AFTER every factor. */
async function cancelScheduledDeletion(userId: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ scheduledDeletionAt: null, updatedAt: new Date() })
    .where(and(eq(schema.users.id, userId), sql`${schema.users.scheduledDeletionAt} IS NOT NULL`));
}

export async function createSession(
  userId: string,
  userAgent: string | null,
  ip: string | null,
): Promise<{ token: string; session: SessionRow }> {
  await cancelScheduledDeletion(userId);
  const token = newSessionToken();
  const [session] = await db
    .insert(schema.sessions)
    .values({
      id: newId(),
      userId,
      tokenHash: hashToken(token),
      userAgent,
      ip,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
    .returning();
  return { token, session: session! };
}

export interface AuthContext {
  session: SessionRow;
  user: UserRow;
}

export async function authenticateToken(rawToken: string): Promise<AuthContext | null> {
  const [row] = await db
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!row) return null;
  // Fixer r1: suspend/ban re-checked on EVERY authentication (REST and WS
  // upgrade), not just at login. revokeAllSessions is one-shot — a login racing
  // the admin action can insert a session row after its delete ran; this makes
  // that stray session dead on first use and destroys it.
  // Wave 1 (§1.2): a tombstoned account has no sessions by construction;
  // the check is belt-and-braces like the suspend one above it.
  if (row.user.suspendedAt !== null || row.user.bannedAt !== null || row.user.deletedAt !== null) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, row.session.id));
    return null;
  }
  const now = Date.now();
  if (row.session.expiresAt.getTime() <= now) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, row.session.id));
    return null;
  }
  if (now - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const lastSeenAt = new Date(now);
    const expiresAt = new Date(now + SESSION_TTL_MS);
    await db
      .update(schema.sessions)
      .set({ lastSeenAt, expiresAt })
      .where(eq(schema.sessions.id, row.session.id));
    row.session.lastSeenAt = lastSeenAt;
    row.session.expiresAt = expiresAt;
  }
  return { session: row.session, user: row.user };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
  await publishSessionClose(sessionId, WS_CLOSE_CODES.UNAUTHENTICATED);
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  await publishUserSessionsClose(userId, WS_CLOSE_CODES.UNAUTHENTICATED);
}

/** Every session but one (the device that just changed the password stays
 * signed in; the rest close with 4401 like any revocation). */
export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<void> {
  const rows = await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keepSessionId)))
    .returning({ id: schema.sessions.id });
  for (const r of rows) await publishSessionClose(r.id, WS_CLOSE_CODES.UNAUTHENTICATED);
}
