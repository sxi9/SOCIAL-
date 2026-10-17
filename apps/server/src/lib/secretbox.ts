// AES-256-GCM seal/open for the two v0.9 secrets that must READ BACK
// (users.totp_secret — §1.73, and the stored SMTP password — §1.74). Key is
// HKDF-SHA256-derived from SESSION_SECRET with a per-domain info string
// ('totp:' / 'smtp:'), so the two never share a key. Stored shape:
// v1:<iv>:<ciphertext>:<tag>, base64url parts (the migration-0011 contract).
// ADR-021 names the tradeoff: rotating SESSION_SECRET orphans everything
// sealed under it — openSecret then returns null and callers fall back
// (recovery codes for TOTP; re-entering the SMTP password).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM nonce

const keyCache = new Map<string, Buffer>();

function keyFor(info: string): Buffer {
  let key = keyCache.get(info);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', config.sessionSecret, Buffer.alloc(0), info, KEY_LEN));
    keyCache.set(info, key);
  }
  return key;
}

export function sealSecret(info: string, plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', keyFor(info), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${ct.toString('base64url')}:${tag.toString('base64url')}`;
}

/** Null on any malformed/foreign-key blob — never throws (the rotated-secret
 *  failure mode is a recoverable lockout, not a 500). */
export function openSecret(info: string, sealed: string): string | null {
  try {
    const parts = sealed.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [, ivB, ctB, tagB] = parts;
    const decipher = createDecipheriv('aes-256-gcm', keyFor(info), Buffer.from(ivB!, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB!, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
