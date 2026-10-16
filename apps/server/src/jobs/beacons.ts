// v0.3 worker queue `beacons` (ARCHITECTURE §10, API.md §1.15):
//   beacon-expire    — repeatable 1-min sweep over beacons_open_expiry_idx;
//                      unsparked beacons die silently (no push, no copy).
//   beacon-ritual    — repeatable hourly; re-creates due weekly runs as NEW
//                      rows chained via ritual_parent_id (one child max —
//                      the partial unique index makes the worker idempotent).
//                      Chains auto-pause at 2 consecutive unsparked runs with
//                      ZERO guilt copy: no notification, nothing (PSYCHOLOGY
//                      never-build list).
//   beacon-afterglow — delayed per spark to expires_at + 2 h (plus this same
//                      handler run as a safety sweep): posts the recap system
//                      message with metadata.afterglow in the plan
//                      conversation — never outside it.
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  BEACON_AFTERGLOW_DELAY_S,
  BEACON_AFTERGLOW_PHOTOS_MAX,
  RITUAL_AUTO_PAUSE_SKIPS,
  RITUAL_INTERVAL_S,
  type AfterglowMetadata,
} from '@socialchat/shared';
import { db } from '../db/index.js';
import { newId } from '../ids.js';
import { activeParticipantUserIds } from '../lib/dto.js';
import {
  audienceUserIds,
  fanBeacon,
  pushBeacon,
  rawToBeaconRow,
  type BeaconRow,
} from '../modules/beacons/service.js';
import { fanOutNewMessage, insertMessage } from '../modules/messages/service.js';
import type { BeaconsJob } from '../queues.js';

// ---------------------------------------------------------------------------
// beacon-expire
// ---------------------------------------------------------------------------

export async function runBeaconExpireSweep(): Promise<void> {
  const rows = (await db.execute(sql`
    UPDATE beacons SET status = 'expired'
    WHERE status = 'open' AND expires_at <= now()
    RETURNING *
  `)) as unknown as Record<string, unknown>[];
  for (const raw of rows) {
    // Cards silently retire — beacon.updated only, no push (§1.15 expiry).
    await fanBeacon(rawToBeaconRow(raw), 'beacon.updated');
  }
}

// ---------------------------------------------------------------------------
// beacon-ritual
// ---------------------------------------------------------------------------

export async function runRitualSweep(): Promise<void> {
  // Terminal ritual runs: past expiry, carrying a rrule, no child yet.
  const rows = (await db.execute(sql`
    SELECT * FROM beacons parent
    WHERE parent.ritual_rrule IS NOT NULL
      AND parent.expires_at <= now()
      AND NOT EXISTS (SELECT 1 FROM beacons child WHERE child.ritual_parent_id = parent.id)
  `)) as unknown as Record<string, unknown>[];

  for (const raw of rows) {
    const parent = rawToBeaconRow(raw);
    const sparked = parent.status === 'sparked';
    // skips = consecutive unsparked runs; the next run carries sparked ? 0 :
    // skips + 1, and at RITUAL_AUTO_PAUSE_SKIPS the worker silently creates
    // NOTHING — the resume path is POST ritualize on this latest run.
    const childSkips = sparked ? 0 : parent.ritualSkips + 1;
    if (childSkips >= RITUAL_AUTO_PAUSE_SKIPS) continue;

    // starts_at advanced in 7-day steps past now; same duration.
    const durationMs = parent.expiresAt.getTime() - parent.startsAt.getTime();
    let startsAt = parent.startsAt.getTime();
    const now = Date.now();
    while (startsAt <= now) startsAt += RITUAL_INTERVAL_S * 1000;

    const childId = newId();
    // ON CONFLICT on the partial unique index (one child per parent) keeps
    // concurrent/replayed sweeps idempotent.
    const inserted = (await db.execute(sql`
      INSERT INTO beacons
        (id, creator_id, vibe, note, audience, area, starts_at, expires_at,
         spark_threshold, status, ritual_rrule, ritual_count, ritual_skips, ritual_parent_id)
      VALUES
        (${childId}, ${parent.creatorId}, ${parent.vibe}, ${parent.note}, ${parent.audience},
         ${parent.area}, ${new Date(startsAt).toISOString()}::timestamptz,
         ${new Date(startsAt + durationMs).toISOString()}::timestamptz,
         ${parent.sparkThreshold}, 'open', ${parent.ritualRrule},
         ${parent.ritualCount}, ${childSkips}, ${parent.id})
      ON CONFLICT (ritual_parent_id) WHERE ritual_parent_id IS NOT NULL DO NOTHING
      RETURNING *
    `)) as unknown as Record<string, unknown>[];
    if (inserted.length === 0) continue;

    const child = rawToBeaconRow(inserted[0]!);
    // Worker-made runs do NOT bump beacons_created (§1.15 rituals); they fan
    // beacon.new to the audience like any open beacon.
    await fanBeacon(child, 'beacon.new');
    const audience = await audienceUserIds(child);
    await pushBeacon(audience, {
      beacon_id: child.id,
      title: `Ritual time: ${child.vibe}`,
      body: child.note || 'The weekly plan is back up',
      url: '/beacons',
    });
  }
}

// ---------------------------------------------------------------------------
// beacon-afterglow
// ---------------------------------------------------------------------------

/**
 * The recap message id is DETERMINISTIC (sha256 of the beacon id folded into
 * a UUID shape): a delayed-job + safety-sweep race, or a replayed job, hits
 * the messages.id unique constraint and the whole seq transaction rolls back
 * — exactly one recap per beacon, no seq gap.
 */
function afterglowMessageId(beaconId: string): string {
  const h = createHash('sha256').update(`afterglow:${beaconId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function postAfterglow(beacon: BeaconRow): Promise<void> {
  if (beacon.status !== 'sparked' || !beacon.conversationId) return;
  const convId = beacon.conversationId;

  // Cheap pre-check; the deterministic message id is the atomic backstop.
  const existing = (await db.execute(sql`
    SELECT 1 AS one FROM messages
    WHERE conversation_id = ${convId}
      AND metadata -> 'afterglow' ->> 'beacon_id' = ${beacon.id}
    LIMIT 1
  `)) as unknown as { one: number }[];
  if (existing.length > 0) return;

  const participantIds = await activeParticipantUserIds(convId);

  // Photos: image attachments posted in the plan conversation between spark
  // (≈ conversation creation) and expires_at + 2 h, newest-first, ≤ 6.
  const windowEnd = new Date(beacon.expiresAt.getTime() + BEACON_AFTERGLOW_DELAY_S * 1000);
  const photoRows = (await db.execute(sql`
    SELECT a.id FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE m.conversation_id = ${convId}
      AND a.kind = 'image' AND a.status = 'ready'
      AND m.created_at <= ${windowEnd.toISOString()}::timestamptz
    ORDER BY m.created_at DESC
    LIMIT ${BEACON_AFTERGLOW_PHOTOS_MAX}
  `)) as unknown as { id: string }[];

  const nameRows = (await db.execute(sql`
    SELECT display_name FROM users
    WHERE id IN (${sql.join(participantIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY display_name ASC
    LIMIT 4
  `)) as unknown as { display_name: string }[];
  const names = nameRows.map((r) => r.display_name);
  const crew =
    participantIds.length > names.length
      ? `${names.join(', ')} + ${participantIds.length - names.length} more`
      : names.join(', ');

  const afterglow: AfterglowMetadata = {
    beacon_id: beacon.id,
    vibe: beacon.vibe as AfterglowMetadata['vibe'],
    participant_ids: participantIds,
    photo_attachment_ids: photoRows.map((r) => r.id),
    // run_it_back IS the beacon id: POST /api/beacons/:id/run-it-back,
    // authorized by spark-group membership (API.md §1.15).
    run_it_back: beacon.id,
  };

  // A normal system message on the seq log — offline members catch it via
  // GET /sync; senderId null means no push (recaps are calm, PSYCHOLOGY §6).
  let msg;
  try {
    msg = await insertMessage({
      conversationId: convId,
      id: afterglowMessageId(beacon.id),
      senderId: null,
      type: 'system',
      body: `That ${beacon.vibe} happened — ${crew}. Run it back?`,
      metadata: { system: { event: 'afterglow' }, afterglow },
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return; // already posted
    throw err;
  }
  await fanOutNewMessage(msg);
}

export async function runAfterglow(job: BeaconsJob): Promise<void> {
  const beaconId = (job as { beacon_id?: string }).beacon_id;
  if (beaconId) {
    const rows = (await db.execute(sql`
      SELECT * FROM beacons WHERE id = ${beaconId}
    `)) as unknown as Record<string, unknown>[];
    if (rows[0]) await postAfterglow(rawToBeaconRow(rows[0]));
    return;
  }
  // Safety sweep over beacons_afterglow_idx: sparked beacons whose recap is
  // due (expires_at + 2 h in the past), bounded to a 7-day lookback.
  const rows = (await db.execute(sql`
    SELECT * FROM beacons
    WHERE status = 'sparked'
      AND expires_at <= now() - interval '2 hours'
      AND expires_at > now() - interval '7 days'
      AND conversation_id IS NOT NULL
  `)) as unknown as Record<string, unknown>[];
  for (const raw of rows) await postAfterglow(rawToBeaconRow(raw));
}

export async function processBeaconsJob(name: string, job: BeaconsJob): Promise<void> {
  switch (name) {
    case 'beacon-expire':
      return runBeaconExpireSweep();
    case 'beacon-ritual':
      return runRitualSweep();
    case 'beacon-afterglow':
    case 'beacon-afterglow-sweep':
      return runAfterglow(job);
    default:
      throw new Error(`beacons: unknown job ${name}`);
  }
}
