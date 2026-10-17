// RFC 6238 TOTP (and its RFC 4226 HOTP core), implemented by hand over
// node:crypto — v0.9 §1.73, ADR-021: no dependency. SHA1 / TOTP_DIGITS (6) /
// TOTP_PERIOD_S (30 s) / ±TOTP_DRIFT_STEPS (1) drift; 20-byte secrets carried
// as unpadded base32 (the otpauth:// alphabet). The unit suite pins the RFC
// 4226 appendix D and RFC 6238 appendix B test vectors against this file.
// Replay protection (burning the matched step in Redis) is the ROUTE's job —
// this module is pure math so it stays trivially testable.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TOTP_DIGITS, TOTP_DRIFT_STEPS, TOTP_PERIOD_S } from '@socialchat/shared';

// RFC 4648 base32 alphabet — what every authenticator app expects in the
// otpauth secret param and the manual-entry key.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out; // unpadded — otpauth convention
}

/** Lenient decode: case-insensitive, ignores '=' padding and spaces. Null on
 *  any character outside the alphabet (a mangled key fails verification,
 *  never crashes). */
export function base32Decode(s: string): Buffer | null {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP: HMAC-SHA1 over the 8-byte big-endian counter, dynamic
 *  truncation, modulo 10^digits, left-padded. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The RFC 6238 time step for a given wall-clock instant. */
export function totpStep(nowMs: number, periodS = TOTP_PERIOD_S): number {
  return Math.floor(nowMs / 1000 / periodS);
}

export function totpCode(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  return hotp(secret, step, digits);
}

/**
 * Verify a code within ±drift steps of now. Returns the MATCHED step (so the
 * caller can burn exactly it — one code never authenticates twice) or null.
 * Constant-time code comparison; every candidate step is computed regardless
 * of early match so timing doesn't leak which step hit.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs = Date.now(),
  drift = TOTP_DRIFT_STEPS,
  digits = TOTP_DIGITS,
  periodS = TOTP_PERIOD_S,
): number | null {
  if (!/^\d+$/.test(code) || code.length !== digits) return null;
  const now = totpStep(nowMs, periodS);
  const codeBuf = Buffer.from(code);
  let matched: number | null = null;
  for (let d = -drift; d <= drift; d++) {
    const step = now + d;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step, digits));
    if (expected.length === codeBuf.length && timingSafeEqual(expected, codeBuf)) {
      matched ??= step;
    }
  }
  return matched;
}

/** The copyable manual-entry form: the base32 key in groups of 4 (§1.73). */
export function groupedManualKey(b32: string): string {
  return b32.match(/.{1,4}/g)?.join(' ') ?? b32;
}
