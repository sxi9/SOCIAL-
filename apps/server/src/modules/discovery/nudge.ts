// Wave nudges (v0.8b — API.md §1.63, FEATURES #78a, ADR-019). The §1.44
// single-wave rule stands: a wave parks silently and names NOBODY, ever. The
// nudge adds exactly one anonymous fact — "someone in the pool waved at you"
// — and only when anonymity is arithmetically safe. The ORDER is binding:
// (1) re-check the opt-in live + un-nudged, (2) require the visible pool ≥
// NUDGE_MIN_POOL (below it the job drops SILENTLY and the claim stays open —
// a later wave in the same hour retries), (3) claim wave_nudged_at
// atomically, (4) deliver: the in-app frame to live sockets, else one §2.9
// push with no identity, no count, no per-card deep link.
import { eq, sql } from 'drizzle-orm';
import { NUDGE_MIN_POOL, NUDGE_PUSH_BODY } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { enqueueSocialPush } from '../../queues.js';
import { presenceKey, redis } from '../../redis.js';
import { publishToUsers } from '../../ws/events.js';
import { visibleCards } from './routes.js';
import { liveOptinOf } from './service.js';

export async function runWaveNudge(userId: string): Promise<void> {
  // (1) setting on + opt-in live + claim still open.
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user || !user.waveNudges || user.suspendedAt !== null || user.bannedAt !== null) return;
  const optin = await liveOptinOf(userId);
  if (!optin || optin.waveNudgedAt !== null) return;

  // (2) the TARGET's visible pool — the §1.44 mutual-reachability card set,
  // minus blocks/friends-of/banned. BEFORE the claim, by contract.
  const pool = await visibleCards(userId, optin, user.area);
  if (pool.length < NUDGE_MIN_POOL) return; // drop silently; claim stays open

  // (3) the atomic claim — zero rows means another job won (batching IS the
  // claim: N waves in one opt-in hour → at most ONE nudge).
  const claimed = (await db.execute(sql`
    UPDATE discovery_optins SET wave_nudged_at = now()
    WHERE user_id = ${userId} AND expires_at > now() AND wave_nudged_at IS NULL
    RETURNING user_id
  `)) as unknown as { user_id: string }[];
  if (claimed.length === 0) return;

  // (4) deliver — live sockets get the frame; offline gets ONE identity-free
  // push (tap opens the discovery pool, never a card).
  if ((await redis.exists(presenceKey(userId))) === 1) {
    await publishToUsers([userId], { t: 'discovery.nudge', d: {} });
  } else {
    await enqueueSocialPush({
      kind: 'social',
      user_id: userId,
      dedupe_key: `nudge:${optin.createdAt.getTime()}`,
      title: NUDGE_PUSH_BODY,
      body: '',
      url: '/local',
    });
  }
}
