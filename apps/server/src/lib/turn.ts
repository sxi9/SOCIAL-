// v0.6 TURN credential minting (API.md §1.42, ADR-014). coturn runs in
// static-auth-secret mode (the TURN REST API memo): the api and the relay
// share ONLY the TURN_SECRET env var — no database wiring, revocation by
// expiry. username = "<unix expiry>:<user_id>" (abuse traces to a user id
// baked into the TURN username), credential = base64(HMAC-SHA1(TURN_SECRET,
// username)), TTL TURN_CRED_TTL_S (1 h) — long calls refresh via
// GET /api/turn-credentials before expiry.
import { createHmac } from 'node:crypto';
import {
  CALL_SELFTEST_CRED_TTL_S,
  TURN_CRED_TTL_S,
  TURN_PORT,
  type TurnCredentials,
} from '@socialchat/shared';
import { config } from '../config.js';

/**
 * Mint time-limited coturn credentials for `userId`, or null when the
 * instance has no TURN_SECRET (local dev — host candidates still connect
 * same-network peers; §1.42 create/join serialize `turn: null`).
 */
export function mintTurnCredentials(userId: string): TurnCredentials | null {
  return mint(userId, TURN_CRED_TTL_S, '');
}

/**
 * v0.7.1 (API.md §1.55, ADR-017): SHORT-lived probe credentials for the call
 * self-test's relay-reachability gather. Same coturn static-auth-secret HMAC
 * — coturn reads the leading expiry and verifies identically; the `selftest:`
 * infix exists ONLY so relay logs distinguish probes from calls. TTL
 * CALL_SELFTEST_CRED_TTL_S (5 min), so farmed probe creds die fast.
 */
export function mintSelftestTurnCredentials(userId: string): TurnCredentials | null {
  return mint(userId, CALL_SELFTEST_CRED_TTL_S, 'selftest:');
}

function mint(userId: string, ttlS: number, infix: '' | 'selftest:'): TurnCredentials | null {
  if (!config.turnSecret) return null;
  const expiryUnix = Math.floor(Date.now() / 1000) + ttlS;
  const username = `${expiryUnix}:${infix}${userId}`;
  const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
  const host = config.domain;
  return {
    username,
    credential,
    uris: [
      `stun:${host}:${TURN_PORT}`,
      `turn:${host}:${TURN_PORT}?transport=udp`,
      `turn:${host}:${TURN_PORT}?transport=tcp`,
    ],
    expires_at: new Date(expiryUnix * 1000).toISOString(),
  };
}
