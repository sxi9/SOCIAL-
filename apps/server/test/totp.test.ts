// Unit suite for the hand-rolled RFC 6238 TOTP (lib/totp.ts — ADR-021: no
// dependency, so the published test vectors are the correctness proof) and
// the AES-256-GCM secretbox (lib/secretbox.ts). No infra needed.
import { describe, expect, it } from 'vitest';
import { TOTP_DIGITS } from '@socialchat/shared';
import {
  base32Decode,
  base32Encode,
  groupedManualKey,
  hotp,
  totpCode,
  totpStep,
  verifyTotp,
} from '../src/lib/totp.js';
import { openSecret, sealSecret } from '../src/lib/secretbox.js';

// The RFC 4226/6238 shared secret: ASCII "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('HOTP (RFC 4226 appendix D vectors)', () => {
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  it('matches all ten published 6-digit vectors', () => {
    for (let counter = 0; counter < expected.length; counter++) {
      expect(hotp(RFC_SECRET, counter, 6)).toBe(expected[counter]);
    }
  });
});

describe('TOTP (RFC 6238 appendix B vectors, SHA1 / 8 digits / 30 s)', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  it('matches all six published vectors', () => {
    for (const [timeS, code] of vectors) {
      expect(totpCode(RFC_SECRET, totpStep(timeS * 1000), 8)).toBe(code);
    }
  });

  it('verifies the current step and ±1 drift, rejects ±2', () => {
    const nowMs = 1111111111 * 1000;
    const step = totpStep(nowMs);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step, 8), nowMs, 1, 8)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1, 8), nowMs, 1, 8)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1, 8), nowMs, 1, 8)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2, 8), nowMs, 1, 8)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2, 8), nowMs, 1, 8)).toBeNull();
  });

  it('rejects malformed codes without throwing', () => {
    expect(verifyTotp(RFC_SECRET, '', Date.now())).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', Date.now())).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', Date.now())).toBeNull(); // wrong length
    expect(verifyTotp(RFC_SECRET, '1234567', Date.now())).toBeNull();
  });

  it(`product knob: ${TOTP_DIGITS}-digit codes round-trip`, () => {
    const step = totpStep(Date.now());
    const code = totpCode(RFC_SECRET, step);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(RFC_SECRET, code)).toBe(step);
  });
});

describe('base32 (RFC 4648)', () => {
  it('encodes the RFC secret to the canonical authenticator key', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
  it('round-trips random-length buffers', () => {
    for (const len of [1, 2, 3, 4, 5, 19, 20, 32]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + len) & 0xff));
      expect(base32Decode(base32Encode(buf))!.equals(buf)).toBe(true);
    }
  });
  it('is lenient about case, spaces and padding; null on garbage', () => {
    expect(base32Decode('gezd gnbv gy3t qojq GEZDGNBVGY3TQOJQ==')!.equals(RFC_SECRET)).toBe(true);
    expect(base32Decode('not!base32')).toBeNull();
  });
  it('groups the manual key in fours', () => {
    expect(groupedManualKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});

describe('secretbox (AES-256-GCM, HKDF domain separation)', () => {
  it('round-trips and produces the v1:<iv>:<ct>:<tag> shape', () => {
    const sealed = sealSecret('totp:', 'GEZDGNBVGY3TQOJQ');
    expect(sealed).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(openSecret('totp:', sealed)).toBe('GEZDGNBVGY3TQOJQ');
  });
  it('different info strings never open each other (domain separation)', () => {
    const sealed = sealSecret('totp:', 'secret');
    expect(openSecret('smtp:', sealed)).toBeNull();
  });
  it('null (never a throw) on tampered or malformed blobs', () => {
    const sealed = sealSecret('smtp:', 'hunter2');
    const parts = sealed.split(':');
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]!.slice(0, -2)}AA:${parts[3]}`;
    expect(openSecret('smtp:', tampered)).toBeNull();
    expect(openSecret('smtp:', 'v1:bad')).toBeNull();
    expect(openSecret('smtp:', '')).toBeNull();
    expect(openSecret('smtp:', 'v2:a:b:c')).toBeNull();
  });
  it('fresh IV per seal — two seals of one plaintext differ', () => {
    expect(sealSecret('totp:', 'x')).not.toBe(sealSecret('totp:', 'x'));
  });
});
