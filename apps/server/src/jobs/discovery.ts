// v0.6 worker queue `discovery` (API.md §1.44/§1.45, ADR-015):
//   discovery-sweep — repeatable bookkeeping: lapsed opt-ins + the waves that
//                     died with them (reads filter live either way).
//   roulette-pair   — every ROULETTE_PAIR_INTERVAL_S: pops queued users whose
//                     opt-ins are still live and pairs them oldest-first,
//                     skipping blocked / friends-of / existing-dm_key pairs.
//   roulette-sweep  — every ROULETTE_SWEEP_INTERVAL_S: HARD-DELETES lapsed
//                     provisional DMs (writes the 24 h feedback tombstone,
//                     fans roulette.expired, removes attachment objects).
import {
  runDiscoverySweep,
  runRoulettePair,
  runRouletteSweep,
} from '../modules/discovery/service.js';
import { runWaveNudge } from '../modules/discovery/nudge.js';
import type { DiscoveryJob } from '../queues.js';

export async function processDiscoveryJob(name: string, job: DiscoveryJob): Promise<void> {
  switch (name) {
    case 'discovery-sweep':
      return runDiscoverySweep();
    case 'roulette-pair':
      return runRoulettePair();
    case 'roulette-sweep':
      return runRouletteSweep();
    // v0.8b (§1.63): the anonymous wave nudge — ordered checks, claim, one
    // identity-free delivery.
    case 'wave-nudge': {
      const userId = (job as { user_id?: string }).user_id;
      if (userId) await runWaveNudge(userId);
      return;
    }
    default:
      throw new Error(`discovery: unknown job ${name}`);
  }
}
