// v0.6 TURN credential minting (API.md §1.42, ADR-014). coturn runs in
// static-auth-secret mode (the TURN REST API memo): the api and the relay
// share ONLY the TURN_SECRET env var — no database wiring, revocation by
// expiry. username = "<unix expiry>:<user_id>" (abuse traces to a user id
// baked into the TURN username), credential = base64(HMAC-SHA1(TURN_SECRET,
// username)), TTL TURN_CRED_TTL_S (1 h) — long calls refresh via
// GET /api/turn-credentials before expiry.
import { createHmac } from 'node:crypto';
import {
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
  if (!config.turnSecret) return null;
  const expiryUnix = Math.floor(Date.now() / 1000) + TURN_CRED_TTL_S;
  const username = `${expiryUnix}:${userId}`;
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
