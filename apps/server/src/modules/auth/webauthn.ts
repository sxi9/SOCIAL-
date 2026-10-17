// WebAuthn plumbing (v0.9 — API.md §1.70, ADR-021). Verification is
// @simplewebauthn/server — the ONE sanctioned rule-10 dependency exception
// (ADR-021 pins 13.1.1 and records the security argument: CBOR/COSE/
// attestation parsing is hundreds of lines where one silent mistake is an
// authentication bypass). The import is LAZY and cached: the api boots (and
// every non-passkey test suite runs) even before the dependency is installed;
// only the passkey endpoints touch it.
//
// Challenges are Redis TTL state, never rows (WEBAUTHN_CHALLENGE_TTL_S),
// one-shot: GETDEL consumes them, hit or miss.
import { WEBAUTHN_CHALLENGE_TTL_S } from '@socialchat/shared';
import { config } from '../../config.js';
import { redis } from '../../redis.js';

export type SimpleWebAuthn = typeof import('@simplewebauthn/server');

let lib: Promise<SimpleWebAuthn> | null = null;

export function webauthnLib(): Promise<SimpleWebAuthn> {
  return (lib ??= import('@simplewebauthn/server'));
}

export const RP_NAME = 'Bored Chat';
export const rpId = (): string => config.webauthn.rpId;
export const expectedOrigins = (): string[] => [...config.webauthn.origins];

const regChallengeKey = (userId: string) => `webauthn:reg:${userId}`;
const authChallengeKey = (ref: string) => `webauthn:auth:${ref}`;

/** One pending registration per user; a new call replaces it (§1.70). */
export async function storeRegistrationChallenge(userId: string, challenge: string): Promise<void> {
  await redis.set(regChallengeKey(userId), challenge, 'EX', WEBAUTHN_CHALLENGE_TTL_S);
}

/** One-shot: consumed by the verify, hit or miss. */
export async function takeRegistrationChallenge(userId: string): Promise<string | null> {
  return redis.getdel(regChallengeKey(userId));
}

export async function storeAuthChallenge(ref: string, challenge: string): Promise<void> {
  await redis.set(authChallengeKey(ref), challenge, 'EX', WEBAUTHN_CHALLENGE_TTL_S);
}

export async function takeAuthChallenge(ref: string): Promise<string | null> {
  return redis.getdel(authChallengeKey(ref));
}
