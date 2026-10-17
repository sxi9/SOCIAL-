// v0.9 auth-pack tests (API.md §1.70–§1.74, ADR-021, FEATURES #82–#86).
// The binding rules, pinned:
//   - every new method mints the SAME ADR-001 session (sid cookie; revocation
//     closes it) — nothing else about the session layer moves;
//   - QR login: single-use one-way pending→approved→consumed walk, 410
//     link_gone byte-identical for every failure, the session minted on the
//     LAPTOP's own poll for the APPROVER's account;
//   - recovery: atomic one-time consume, revokes ALL sessions, Support-
//     conversation notify, forced password reset, byte-identical 401;
//   - TOTP: gates password login ({totp_required, totp_token}, no cookie),
//     a verified step burns (no replay), recovery bypasses it;
//   - passkeys: fixture-credential register/login roundtrip, rpID/origin
//     verification, counter clone-detection → 401, anti-enumeration options;
//   - admin Authentication settings persist; the SMTP password is write-only;
//     test-send answers 503 mailer_unavailable.
// Infra-gated like the other suites (Postgres+Redis; skips cleanly without).
// The passkey block additionally needs @simplewebauthn/server installed (the
// ADR-021 dependency exception) and skips cleanly until the integrate stage
// installs it.
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LOGIN_LINK_DISPLAY_CODE_LEN,
  PASSKEYS_MAX,
  RECOVERY_CODES_COUNT,
  SUPPORT_CONVERSATION_TITLE,
  TOTP_VERIFY_RATE_PER_MIN,
  type UserPrivate,
} from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const hasSwa = await import('@simplewebauthn/server').then(
  () => true,
  () => false,
);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 29) & 0xffffff;
  return `23.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
  recoveryCodes: string[];
}

// ---------------------------------------------------------------------------
// Fixture WebAuthn authenticator: a minimal CBOR encoder + a P-256 key that
// emits 'none'-attestation registration responses and signs assertions — a
// real client-side credential, so the server-side verify path (challenge,
// rpID, origin, signature, counter) is exercised end to end.
// ---------------------------------------------------------------------------

function cborUint(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  throw new Error('cbor: too large for this fixture');
}

type CborValue = number | string | Buffer | Map<number | string, CborValue> | CborValue[];

function cborEncode(v: CborValue): Buffer {
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 0) return cborUint(0, v);
    if (Number.isInteger(v) && v < 0) return cborUint(1, -1 - v);
    throw new Error('cbor: floats unsupported');
  }
  if (typeof v === 'string') return Buffer.concat([cborUint(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborUint(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([cborUint(4, v.length), ...v.map(cborEncode)]);
  const entries = [...v.entries()];
  return Buffer.concat([
    cborUint(5, entries.length),
    ...entries.map(([k, val]) =>
      Buffer.concat([cborEncode(k as CborValue), cborEncode(val)]),
    ),
  ]);
}

const RP_ID = 'localhost'; // DOMAIN default in the test env
const ORIGIN = 'http://localhost:3000'; // in config.webauthn.origins outside prod

function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

interface FixtureCredential {
  credId: Buffer;
  privateKey: KeyObject;
  publicKeyJwk: { x: string; y: string };
}

function newFixtureCredential(): FixtureCredential {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { credId: randomBytes(32), privateKey, publicKeyJwk: jwk };
}

function coseKey(jwk: { x: string; y: string }): Buffer {
  const m = new Map<number, CborValue>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  return cborEncode(m);
}

function clientDataJson(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
}

function registrationResponse(cred: FixtureCredential, challenge: string) {
  const flags = 0x01 | 0x04 | 0x40; // UP | UV | AT
  const counter = Buffer.alloc(4); // 0
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(cred.credId.length);
  const authData = Buffer.concat([
    sha256(RP_ID),
    Buffer.from([flags]),
    counter,
    Buffer.alloc(16), // AAGUID
    credIdLen,
    cred.credId,
    coseKey(cred.publicKeyJwk),
  ]);
  const attObj = cborEncode(
    new Map<string, CborValue>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  );
  const id = cred.credId.toString('base64url');
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientDataJson('webauthn.create', challenge).toString('base64url'),
      attestationObject: attObj.toString('base64url'),
      transports: ['internal'],
    },
  };
}

function authenticationResponse(cred: FixtureCredential, challenge: string, counter: number) {
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(counter);
  const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x01 | 0x04]), counterBuf]);
  const cdj = clientDataJson('webauthn.get', challenge);
  const signature = createSign('SHA256')
    .update(Buffer.concat([authData, sha256(cdj)]))
    .sign(cred.privateKey);
  const id = cred.credId.toString('base64url');
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: cdj.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
  };
}

// ---------------------------------------------------------------------------

describe.runIf(infra)('v0.9 auth pack', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/db/index.js').db;
  let schema: typeof import('../src/db/index.js').schema;
  let sqlTag: typeof import('drizzle-orm').sql;
  let totpLib: typeof import('../src/lib/totp.js');
  let gcJob: typeof import('../src/jobs/gc.js');

  async function register(username: string): Promise<Session> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { ...CSRF, 'x-forwarded-for': nextIp() },
      payload: {
        username,
        email: `${username}@example.com`,
        password: 'password123',
        display_name: `Real ${username}`,
      },
    });
    expect(res.statusCode).toBe(201);
    const sid = res.cookies.find((c) => c.name === 'sid')?.value;
    const body = res.json() as { user: UserPrivate; recovery_codes: string[] };
    return {
      sid: sid!,
      userId: body.user.id,
      username,
      recoveryCodes: body.recovery_codes,
    };
  }

  function get(me: Session | null, url: string) {
    return app.inject({
      method: 'GET',
      url,
      ...(me ? { cookies: { sid: me.sid } } : {}),
    });
  }
  function post(me: Session | null, url: string, payload: unknown = {}, ip?: string) {
    return app.inject({
      method: 'POST',
      url,
      headers: { ...CSRF, 'x-forwarded-for': ip ?? nextIp() },
      ...(me ? { cookies: { sid: me.sid } } : {}),
      payload: payload as object,
    });
  }
  function mutate(method: 'PATCH' | 'DELETE', me: Session, url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: CSRF,
      cookies: { sid: me.sid },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    ({ db, schema } = await import('../src/db/index.js'));
    ({ sql: sqlTag } = await import('drizzle-orm'));
    totpLib = await import('../src/lib/totp.js');
    gcJob = await import('../src/jobs/gc.js');
  });

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // §1.72 recovery codes
  // -------------------------------------------------------------------------

  describe('recovery codes (§1.72)', () => {
    let me: Session;

    beforeAll(async () => {
      me = await register(`rec_${run}`);
    });

    it('register returns 6 one-time codes (xxxxx-xxxxx) + totp_enabled:false', async () => {
      expect(me.recoveryCodes).toHaveLength(RECOVERY_CODES_COUNT);
      for (const code of me.recoveryCodes) {
        expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      }
      const meRes = await get(me, '/api/users/me');
      expect((meRes.json() as { user: UserPrivate }).user.totp_enabled).toBe(false);
    });

    it('status endpoint counts, never reveals', async () => {
      const res = await get(me, '/api/auth/recovery-codes');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { total: number; remaining: number; generated_at: string | null };
      expect(body.total).toBe(RECOVERY_CODES_COUNT);
      expect(body.remaining).toBe(RECOVERY_CODES_COUNT);
      expect(body.generated_at).not.toBeNull();
      for (const code of me.recoveryCodes) expect(res.body).not.toContain(code.replace('-', ''));
    });

    it('regenerate re-proves the password and invalidates the old set', async () => {
      const bad = await post(me, '/api/auth/recovery-codes', { password: 'wrong-password' });
      expect(bad.statusCode).toBe(401);
      expect((bad.json() as { error: string }).error).toBe('bad_credentials');

      const oldCode = me.recoveryCodes[0]!;
      const ok = await post(me, '/api/auth/recovery-codes', { password: 'password123' });
      expect(ok.statusCode).toBe(200);
      const fresh = (ok.json() as { recovery_codes: string[] }).recovery_codes;
      expect(fresh).toHaveLength(RECOVERY_CODES_COUNT);
      me.recoveryCodes = fresh;

      // The pre-regeneration code is dead — same 401 as any bad code.
      const dead = await post(null, '/api/auth/recover', {
        username_or_email: me.username,
        code: oldCode,
      });
      expect(dead.statusCode).toBe(401);
      expect((dead.json() as { error: string }).error).toBe('bad_recovery');
    });

    it('recover consumes one code, revokes ALL sessions, notifies, forces reset', async () => {
      // A second session to prove revoke-all covers every device.
      const login2 = await post(null, '/api/auth/login', {
        username_or_email: me.username,
        password: 'password123',
      });
      expect(login2.statusCode).toBe(200);
      const sid2 = login2.cookies.find((c) => c.name === 'sid')!.value;

      // Normalization: uppercase + stripped separator still verifies.
      const typed = me.recoveryCodes[1]!.toUpperCase().replace('-', ' ');
      const rec = await post(null, '/api/auth/recover', {
        username_or_email: me.username,
        code: typed,
      });
      expect(rec.statusCode).toBe(200);
      const { reset_token } = rec.json() as { reset_token: string };
      expect(reset_token.length).toBeGreaterThan(20);
      expect(rec.cookies.find((c) => c.name === 'sid')).toBeUndefined(); // NO session yet

      // Both sessions are gone (rows deleted → 401 everywhere).
      expect((await get(me, '/api/users/me')).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/api/users/me', cookies: { sid: sid2 } }))
          .statusCode,
      ).toBe(401);

      // Status: one spent.
      // The code is marked used in the row (status endpoint needs auth —
      // check the table directly).
      const rows = (await db.execute(sqlTag`
        SELECT count(*) FILTER (WHERE used_at IS NOT NULL)::int AS used
        FROM recovery_codes rc JOIN users u ON u.id = rc.user_id
        WHERE u.username = ${me.username}
      `)) as unknown as { used: number }[];
      expect(rows[0]!.used).toBe(1);

      // The same code can never be spent twice — byte-identical 401.
      const again = await post(null, '/api/auth/recover', {
        username_or_email: me.username,
        code: me.recoveryCodes[1]!,
      });
      expect(again.statusCode).toBe(401);
      expect((again.json() as { error: string }).error).toBe('bad_recovery');

      // Support-conversation notify landed (sender NULL, Support brand).
      const notify = (await db.execute(sqlTag`
        SELECT m.body FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        JOIN conversation_participants p ON p.conversation_id = c.id
        JOIN users u ON u.id = p.user_id
        WHERE u.username = ${me.username} AND c.metadata @> '{"support": true}'::jsonb
          AND m.sender_id IS NULL AND c.title = ${SUPPORT_CONVERSATION_TITLE}
        ORDER BY m.seq DESC LIMIT 1
      `)) as unknown as { body: string }[];
      expect(notify[0]?.body).toContain('recovery code was just used');

      // Bogus token → 401; the real one mints the session with the NEW
      // password set.
      const badReset = await post(null, '/api/auth/reset-password', {
        reset_token: 'bogus',
        new_password: 'newpassword456',
      });
      expect(badReset.statusCode).toBe(401);
      expect((badReset.json() as { error: string }).error).toBe('bad_reset_token');

      const reset = await post(null, '/api/auth/reset-password', {
        reset_token,
        new_password: 'newpassword456',
      });
      expect(reset.statusCode).toBe(200);
      const newSid = reset.cookies.find((c) => c.name === 'sid');
      expect(newSid).toBeDefined();
      me.sid = newSid!.value;

      // One-shot token: a replay is dead.
      const replay = await post(null, '/api/auth/reset-password', {
        reset_token,
        new_password: 'anotherpass789',
      });
      expect(replay.statusCode).toBe(401);

      // Old password dead, new one works.
      const oldLogin = await post(null, '/api/auth/login', {
        username_or_email: me.username,
        password: 'password123',
      });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await post(null, '/api/auth/login', {
        username_or_email: me.username,
        password: 'newpassword456',
      });
      expect(newLogin.statusCode).toBe(200);
    });

    it('unknown user answers the same 401 bad_recovery (no enumeration)', async () => {
      const res = await post(null, '/api/auth/recover', {
        username_or_email: `ghost_${run}`,
        code: 'aaaaa-aaaaa',
      });
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe(JSON.stringify({ error: 'bad_recovery' }));
    });
  });

  // -------------------------------------------------------------------------
  // §1.71 QR cross-device login
  // -------------------------------------------------------------------------

  describe('QR login links (§1.71)', () => {
    let phone: Session;

    beforeAll(async () => {
      phone = await register(`phone_${run}`);
    });

    async function mintLink(): Promise<{ code: string; display_code: string; url: string }> {
      const res = await post(null, '/api/auth/link');
      expect(res.statusCode).toBe(201);
      return res.json() as { code: string; display_code: string; url: string };
    }

    it('create → poll pending → approve (display code) → poll mints the session', async () => {
      const link = await mintLink();
      expect(link.display_code).toHaveLength(LOGIN_LINK_DISPLAY_CODE_LEN);
      expect(link.url).toBe(`/link/${link.code}`);

      const pending = await post(null, '/api/auth/link/poll', { code: link.code });
      expect(pending.statusCode).toBe(200);
      expect((pending.json() as { status: string }).status).toBe('pending');

      // The approve surface is authed: the laptop itself can neither look up
      // nor approve.
      expect((await post(null, '/api/auth/link/lookup', { code: link.code })).statusCode).toBe(401);
      expect((await post(null, '/api/auth/link/approve', { code: link.code })).statusCode).toBe(401);

      // The phone sees the laptop's UA before approving (typed display code,
      // lower-case with a stray space — normalization is route-side).
      const lookup = await post(phone, '/api/auth/link/lookup', {
        code: ` ${link.display_code.toLowerCase()} `,
      });
      expect(lookup.statusCode).toBe(200);
      const info = (lookup.json() as { link: { user_agent: string | null; ip_hint: string | null } }).link;
      expect(info.user_agent).toContain('lightMyRequest');

      const approve = await post(phone, '/api/auth/link/approve', {
        code: link.display_code.toLowerCase(),
      });
      expect(approve.statusCode).toBe(204);

      // Double-approve raced out: the walk is one-way.
      const reApprove = await post(phone, '/api/auth/link/approve', { code: link.display_code });
      expect(reApprove.statusCode).toBe(410);

      // The laptop's next poll mints the session FOR THE APPROVER.
      const consumed = await post(null, '/api/auth/link/poll', { code: link.code });
      expect(consumed.statusCode).toBe(200);
      const body = consumed.json() as { status: string; user: UserPrivate };
      expect(body.status).toBe('consumed');
      expect(body.user.id).toBe(phone.userId);
      const laptopSid = consumed.cookies.find((c) => c.name === 'sid');
      expect(laptopSid).toBeDefined();

      // It is a standard §1.1 session: visible in the device list and
      // revocable from the phone.
      const sessions = await get(phone, '/api/auth/sessions');
      const list = (sessions.json() as { sessions: { id: string; current: boolean }[] }).sessions;
      expect(list.length).toBeGreaterThanOrEqual(2);

      // Single-use: every later poll is 410, byte-identical.
      const again = await post(null, '/api/auth/link/poll', { code: link.code });
      expect(again.statusCode).toBe(410);
      expect(again.body).toBe(JSON.stringify({ error: 'link_gone' }));
    });

    it('the display code can NEVER poll or redeem', async () => {
      const link = await mintLink();
      const res = await post(null, '/api/auth/link/poll', { code: link.display_code });
      expect(res.statusCode).toBe(410);
      await post(phone, '/api/auth/link/approve', { code: link.display_code });
      const after = await post(null, '/api/auth/link/poll', { code: link.display_code });
      expect(after.statusCode).toBe(410); // still only the full code polls
      const real = await post(null, '/api/auth/link/poll', { code: link.code });
      expect(real.statusCode).toBe(200); // ... and it consumes fine
    });

    it('unknown and expired codes answer one byte-identical 410', async () => {
      const bogus = await post(null, '/api/auth/link/poll', { code: 'A'.repeat(43) });
      expect(bogus.statusCode).toBe(410);
      expect(bogus.body).toBe(JSON.stringify({ error: 'link_gone' }));

      const link = await mintLink();
      await db.execute(sqlTag`
        UPDATE login_links SET expires_at = now() - interval '1 second'
        WHERE expires_at > now()
      `);
      const expiredPoll = await post(null, '/api/auth/link/poll', { code: link.code });
      expect(expiredPoll.statusCode).toBe(410);
      expect(expiredPoll.body).toBe(bogus.body);
      const expiredLookup = await post(phone, '/api/auth/link/lookup', { code: link.display_code });
      expect(expiredLookup.statusCode).toBe(410);
      const expiredApprove = await post(phone, '/api/auth/link/approve', { code: link.code });
      expect(expiredApprove.statusCode).toBe(410);
    });

    it('an approved-but-expired link does not consume', async () => {
      const link = await mintLink();
      const ok = await post(phone, '/api/auth/link/approve', { code: link.display_code });
      expect(ok.statusCode).toBe(204);
      await db.execute(sqlTag`
        UPDATE login_links SET expires_at = now() - interval '1 second'
        WHERE status = 'approved'
      `);
      const poll = await post(null, '/api/auth/link/poll', { code: link.code });
      expect(poll.statusCode).toBe(410);
    });

    it('gc sweeps rows an hour past expiry', async () => {
      await mintLink();
      await db.execute(sqlTag`UPDATE login_links SET expires_at = now() - interval '2 hours'`);
      await gcJob.runLoginLinkGc();
      const left = (await db.execute(
        sqlTag`SELECT count(*)::int AS n FROM login_links`,
      )) as unknown as { n: number }[];
      expect(left[0]!.n).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // §1.73 TOTP 2FA
  // -------------------------------------------------------------------------

  describe('TOTP 2FA (§1.73)', () => {
    let me: Session;
    let secret: Buffer;
    const burned = new Set<number>();

    beforeAll(async () => {
      me = await register(`totp_${run}`);
    });

    /** A code for an unburned step within the ±1 drift window. */
    function freshCode(): { code: string; step: number } {
      const now = totpLib.totpStep(Date.now());
      for (const step of [now, now + 1, now - 1]) {
        if (!burned.has(step)) {
          burned.add(step);
          return { code: totpLib.totpCode(secret, step), step };
        }
      }
      throw new Error('fixture: drift window exhausted');
    }

    it('setup mints a pending secret; enable requires a valid code', async () => {
      const setup = await post(me, '/api/auth/totp/setup');
      expect(setup.statusCode).toBe(200);
      const body = setup.json() as { otpauth_uri: string; manual_key: string };
      const b32 = body.manual_key.replace(/\s/g, '');
      expect(body.otpauth_uri).toContain(`secret=${b32}`);
      expect(body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/Bored%20Chat:totp_/);
      expect(body.otpauth_uri).toContain('digits=6');
      secret = totpLib.base32Decode(b32)!;

      const wrong = await post(me, '/api/auth/totp/enable', { code: '000000' });
      expect(wrong.statusCode).toBe(400);
      expect((wrong.json() as { error: string }).error).toBe('bad_totp_code');
      // Pending survived a wrong code — the right one still enables.
      const { code } = freshCode();
      const ok = await post(me, '/api/auth/totp/enable', { code });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { user: UserPrivate }).user.totp_enabled).toBe(true);

      const second = await post(me, '/api/auth/totp/setup');
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: string }).error).toBe('totp_enabled');
    });

    it('password login is gated: half-login token, burn-once codes', async () => {
      const login = await post(null, '/api/auth/login', {
        username_or_email: me.username,
        password: 'password123',
      });
      expect(login.statusCode).toBe(200);
      const outcome = login.json() as { totp_required?: boolean; totp_token?: string };
      expect(outcome.totp_required).toBe(true);
      expect(login.cookies.find((c) => c.name === 'sid')).toBeUndefined(); // NO cookie yet

      const token = outcome.totp_token!;
      const wrong = await post(null, '/api/auth/totp', { totp_token: token, code: '123456' });
      expect(wrong.statusCode).toBe(401);
      expect((wrong.json() as { error: string }).error).toBe('bad_totp_code');

      // A burned step (the enable's code step) never authenticates twice:
      // re-deriving the oldest burned step's code answers bad_totp_code.
      const replayStep = [...burned][0]!;
      const replay = await post(null, '/api/auth/totp', {
        totp_token: token,
        code: totpLib.totpCode(secret, replayStep),
      });
      // Within the drift window it's a burn-rejection; outside it, just a
      // wrong code — either way the same refusal.
      expect(replay.statusCode).toBe(401);
      expect((replay.json() as { error: string }).error).toBe('bad_totp_code');

      const { code } = freshCode();
      const ok = await post(null, '/api/auth/totp', { totp_token: token, code });
      expect(ok.statusCode).toBe(200);
      expect(ok.cookies.find((c) => c.name === 'sid')).toBeDefined();
      expect((ok.json() as { user: UserPrivate }).user.totp_enabled).toBe(true);

      // The token is one-shot.
      const reuse = await post(null, '/api/auth/totp', {
        totp_token: token,
        code: totpLib.totpCode(secret, totpLib.totpStep(Date.now())),
      });
      expect(reuse.statusCode).toBe(401);
      expect((reuse.json() as { error: string }).error).toBe('bad_totp_token');

      const bogus = await post(null, '/api/auth/totp', { totp_token: 'nope', code: '123456' });
      expect(bogus.statusCode).toBe(401);
      expect((bogus.json() as { error: string }).error).toBe('bad_totp_token');
    });

    it('recovery bypasses TOTP by design; TOTP stays armed', async () => {
      const rec = await post(null, '/api/auth/recover', {
        username_or_email: me.username,
        code: me.recoveryCodes[0]!,
      });
      expect(rec.statusCode).toBe(200);
      const reset = await post(null, '/api/auth/reset-password', {
        reset_token: (rec.json() as { reset_token: string }).reset_token,
        new_password: 'password123', // keep it for later steps
      });
      expect(reset.statusCode).toBe(200);
      const user = (reset.json() as { user: UserPrivate }).user;
      expect(user.totp_enabled).toBe(true); // armed through the recovery
      me.sid = reset.cookies.find((c) => c.name === 'sid')!.value;
    });

    it('disable takes the current code OR a consumed recovery code', async () => {
      const both = await post(me, '/api/auth/totp/disable', {
        code: '123456',
        recovery_code: me.recoveryCodes[2]!,
      });
      expect(both.statusCode).toBe(400); // XOR at the schema

      const badRecovery = await post(me, '/api/auth/totp/disable', {
        recovery_code: 'aaaaa-aaaaa',
      });
      expect(badRecovery.statusCode).toBe(401);
      expect((badRecovery.json() as { error: string }).error).toBe('bad_recovery');

      const ok = await post(me, '/api/auth/totp/disable', {
        recovery_code: me.recoveryCodes[2]!,
      });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { user: UserPrivate }).user.totp_enabled).toBe(false);

      // That recovery code was CONSUMED by the disable.
      const spent = await post(null, '/api/auth/recover', {
        username_or_email: me.username,
        code: me.recoveryCodes[2]!,
      });
      expect(spent.statusCode).toBe(401);

      // Login is a plain session again.
      const login = await post(null, '/api/auth/login', {
        username_or_email: me.username,
        password: 'password123',
      });
      expect(login.statusCode).toBe(200);
      expect(login.cookies.find((c) => c.name === 'sid')).toBeDefined();
    });

    it('enable and disable are throttled per user (no free online guessing)', async () => {
      // The audit fix: an authed session gets TOTP_VERIFY_RATE_PER_MIN swings
      // per minute at each surface, then a 429 — failed guesses are NOT free
      // (verifyAndBurn only burns matches). TOTP is off for `me` here, so every
      // in-budget guess answers 400; the window turns the oracle off after it.
      let sawDisable429 = false;
      for (let i = 0; i < TOTP_VERIFY_RATE_PER_MIN + 1 && !sawDisable429; i++) {
        const res = await post(me, '/api/auth/totp/disable', { code: '000000' });
        expect([400, 429]).toContain(res.statusCode);
        sawDisable429 = res.statusCode === 429;
      }
      expect(sawDisable429).toBe(true);

      let sawEnable429 = false;
      for (let i = 0; i < TOTP_VERIFY_RATE_PER_MIN + 1 && !sawEnable429; i++) {
        const res = await post(me, '/api/auth/totp/enable', { code: '000000' });
        expect([400, 429]).toContain(res.statusCode);
        sawEnable429 = res.statusCode === 429;
      }
      expect(sawEnable429).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // §1.74 admin Authentication settings
  // -------------------------------------------------------------------------

  describe('admin Authentication settings (§1.74)', () => {
    let admin: Session;
    let pleb: Session;

    beforeAll(async () => {
      admin = await register(`authadmin_${run}`);
      pleb = await register(`authpleb_${run}`);
      await db.execute(sqlTag`UPDATE users SET is_admin = true WHERE id = ${admin.userId}`);
      // instance_settings persist across suite runs against a shared dev DB —
      // restore the 0011-seeded defaults so this block is deterministic.
      await db.execute(sqlTag`
        UPDATE instance_settings SET value = '{
          "smtp": {"host": null, "port": 587, "secure": true, "username": null, "from": null},
          "features": {
            "email_verification": false, "email_otp": false,
            "magic_links": false, "password_reset": false
          }
        }'::jsonb, updated_at = now() WHERE key = 'auth'
      `);
      await db.execute(sqlTag`
        UPDATE instance_settings SET value = 'null'::jsonb, updated_at = now()
        WHERE key = 'auth_smtp_password'
      `);
    });

    it('serializes auth settings to admins only; mailer honestly unavailable', async () => {
      expect((await get(pleb, '/api/admin/settings')).statusCode).toBe(404);
      const res = await get(admin, '/api/admin/settings');
      expect(res.statusCode).toBe(200);
      const auth = (res.json() as { settings: { auth: Record<string, unknown> } }).settings.auth;
      expect(auth.mailer_available).toBe(false);
      expect((auth.smtp as { password_set: boolean }).password_set).toBe(false);
      expect((auth.features as { email_otp: boolean }).email_otp).toBe(false);
    });

    it('PATCH persists config + inert toggles; the password is write-only', async () => {
      const patch = await mutate('PATCH', admin, '/api/admin/settings', {
        auth: {
          smtp: {
            host: 'smtp.example.com',
            port: 2525,
            secure: false,
            username: 'bored',
            from: 'noreply@example.com',
            password: 'hunter2-super-secret',
          },
          features: { email_otp: true, password_reset: true },
        },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.body).not.toContain('hunter2-super-secret'); // never reads back

      const reread = await get(admin, '/api/admin/settings');
      const auth = (reread.json() as {
        settings: {
          auth: {
            smtp: Record<string, unknown>;
            features: Record<string, boolean>;
            mailer_available: boolean;
          };
        };
      }).settings.auth;
      expect(auth.smtp.host).toBe('smtp.example.com');
      expect(auth.smtp.port).toBe(2525);
      expect(auth.smtp.secure).toBe(false);
      expect(auth.smtp.username).toBe('bored');
      expect(auth.smtp.from).toBe('noreply@example.com');
      expect(auth.smtp.password_set).toBe(true);
      expect(auth.smtp.password).toBeUndefined();
      expect(auth.features.email_otp).toBe(true); // persisted even while inert
      expect(auth.features.password_reset).toBe(true);
      expect(auth.features.email_verification).toBe(false); // deep-partial
      expect(auth.mailer_available).toBe(false);
      expect(reread.body).not.toContain('hunter2-super-secret');

      // The stored value is encrypted, not the plaintext.
      const stored = (await db.execute(sqlTag`
        SELECT value FROM instance_settings WHERE key = 'auth_smtp_password'
      `)) as unknown as { value: unknown }[];
      expect(String(stored[0]!.value)).toMatch(/^v1:/);
      expect(String(stored[0]!.value)).not.toContain('hunter2');

      // null clears it.
      const clear = await mutate('PATCH', admin, '/api/admin/settings', {
        auth: { smtp: { password: null } },
      });
      expect(clear.statusCode).toBe(200);
      const cleared = await get(admin, '/api/admin/settings');
      expect(
        (cleared.json() as { settings: { auth: { smtp: { password_set: boolean } } } }).settings
          .auth.smtp.password_set,
      ).toBe(false);
      // ... and the deep-merge kept the rest of the block.
      expect(
        (cleared.json() as { settings: { auth: { smtp: { host: string } } } }).settings.auth.smtp
          .host,
      ).toBe('smtp.example.com');
    });

    it('test-send answers 503 mailer_unavailable, always (v0.9 honesty)', async () => {
      const res = await post(admin, '/api/admin/settings/auth/test-send', {
        to: 'op@example.com',
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: string }).error).toBe('mailer_unavailable');
      expect((await post(pleb, '/api/admin/settings/auth/test-send', { to: 'x@example.com' })).statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // §1.70 passkey MANAGEMENT (rows only — no verification, so it runs even
  // before the @simplewebauthn dependency is installed).
  // -------------------------------------------------------------------------

  describe('passkey management (§1.70, library-free)', () => {
    let owner: Session;
    let stranger: Session;
    let rowId: string;

    beforeAll(async () => {
      owner = await register(`pkmgmt_${run}`);
      stranger = await register(`pkmgmts_${run}`);
      rowId = crypto.randomUUID();
      await db.insert(schema.passkeyCredentials).values({
        id: rowId,
        userId: owner.userId,
        credentialId: `mgmt-${run}`,
        publicKey: 'AA',
        counter: 7,
        transports: ['internal'],
        deviceType: 'multiDevice',
        backedUp: true,
        nickname: 'Seeded',
      });
    });

    it('lists settings-UI material only — never key or counter', async () => {
      const res = await get(owner, '/api/auth/passkeys');
      expect(res.statusCode).toBe(200);
      const [p] = (res.json() as { passkeys: Record<string, unknown>[] }).passkeys;
      expect(p).toMatchObject({
        id: rowId,
        nickname: 'Seeded',
        device_type: 'multiDevice',
        backed_up: true,
        transports: ['internal'],
        last_used_at: null,
      });
      expect(p!.public_key).toBeUndefined();
      expect(p!.counter).toBeUndefined();
    });

    it('rename/delete are mine-only (the §1.14 404 shape)', async () => {
      expect(
        (await mutate('PATCH', stranger, `/api/auth/passkeys/${rowId}`, { nickname: 'nope' }))
          .statusCode,
      ).toBe(404);
      expect((await mutate('DELETE', stranger, `/api/auth/passkeys/${rowId}`)).statusCode).toBe(404);

      const renamed = await mutate('PATCH', owner, `/api/auth/passkeys/${rowId}`, {
        nickname: 'My phone',
      });
      expect(renamed.statusCode).toBe(200);
      expect((renamed.json() as { passkey: { nickname: string } }).passkey.nickname).toBe('My phone');

      expect((await mutate('DELETE', owner, `/api/auth/passkeys/${rowId}`)).statusCode).toBe(204);
      expect((await mutate('DELETE', owner, `/api/auth/passkeys/${rowId}`)).statusCode).toBe(404);
      const after = await get(owner, '/api/auth/passkeys');
      expect((after.json() as { passkeys: unknown[] }).passkeys).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // §1.70 passkeys — needs @simplewebauthn/server (skips until installed).
  // -------------------------------------------------------------------------

  describe.runIf(hasSwa)('passkeys (§1.70)', () => {
    let me: Session;
    let other: Session;
    let cred: FixtureCredential;
    let passkeyId: string;

    beforeAll(async () => {
      me = await register(`pk_${run}`);
      other = await register(`pkother_${run}`);
      cred = newFixtureCredential();
    });

    async function registerOptions(as: Session): Promise<{ challenge: string }> {
      const res = await post(as, '/api/auth/passkeys/options');
      expect(res.statusCode).toBe(200);
      return (res.json() as { options: { challenge: string } }).options;
    }

    async function loginOptions(username?: string) {
      const res = await post(null, '/api/auth/passkey-login/options', username ? { username } : {});
      expect(res.statusCode).toBe(200);
      return res.json() as {
        challenge_ref: string;
        options: { challenge: string; allowCredentials?: { id: string }[] };
      };
    }

    it('registers a fixture credential against the stored challenge', async () => {
      const options = await registerOptions(me);
      const res = await post(me, '/api/auth/passkeys', {
        response: registrationResponse(cred, options.challenge),
        nickname: 'Test laptop',
      });
      expect(res.statusCode).toBe(201);
      const passkey = (res.json() as { passkey: { id: string; nickname: string; device_type: string } }).passkey;
      passkeyId = passkey.id;
      expect(passkey.nickname).toBe('Test laptop');
      expect(res.body).not.toContain(cred.publicKeyJwk.x); // no key material out

      // The challenge was one-shot: replaying the registration → bad_passkey.
      const replay = await post(me, '/api/auth/passkeys', {
        response: registrationResponse(cred, options.challenge),
      });
      expect(replay.statusCode).toBe(400);
      expect((replay.json() as { error: string }).error).toBe('bad_passkey');

      // Same credential id under a fresh challenge → 409 passkey_exists.
      const options2 = await registerOptions(me);
      const dupe = await post(me, '/api/auth/passkeys', {
        response: registrationResponse(cred, options2.challenge),
      });
      expect(dupe.statusCode).toBe(409);
      expect((dupe.json() as { error: string }).error).toBe('passkey_exists');
    });

    it('a wrong-origin/wrong-challenge response never verifies', async () => {
      const options = await registerOptions(me);
      const forged = registrationResponse(newFixtureCredential(), 'bm90LXRoZS1jaGFsbGVuZ2U');
      const res = await post(me, '/api/auth/passkeys', { response: forged });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('bad_passkey');
      void options;
    });

    it('lists, renames, deletes — mine only (404 shape)', async () => {
      const list = await get(me, '/api/auth/passkeys');
      const passkeys = (list.json() as { passkeys: { id: string }[] }).passkeys;
      expect(passkeys.map((p) => p.id)).toContain(passkeyId);

      const rename = await mutate('PATCH', me, `/api/auth/passkeys/${passkeyId}`, {
        nickname: 'Renamed',
      });
      expect(rename.statusCode).toBe(200);

      expect(
        (await mutate('PATCH', other, `/api/auth/passkeys/${passkeyId}`, { nickname: 'steal' }))
          .statusCode,
      ).toBe(404);
      expect((await mutate('DELETE', other, `/api/auth/passkeys/${passkeyId}`)).statusCode).toBe(404);
    });

    it('login options never leak whether a username exists', async () => {
      const known = await loginOptions(me.username);
      expect((known.options.allowCredentials ?? []).map((c) => c.id)).toContain(
        cred.credId.toString('base64url'),
      );
      const unknown = await loginOptions(`ghostpk_${run}`);
      const empty = await loginOptions(other.username); // real user, no passkeys
      expect(unknown.options.allowCredentials ?? []).toEqual([]);
      expect(empty.options.allowCredentials ?? []).toEqual([]);
    });

    it('a verified assertion mints the standard session; counters advance', async () => {
      const { challenge_ref, options } = await loginOptions(me.username);
      const res = await post(null, '/api/auth/passkey-login', {
        challenge_ref,
        response: authenticationResponse(cred, options.challenge, 10),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { user: UserPrivate };
      expect(body.user.id).toBe(me.userId);
      const sid = res.cookies.find((c) => c.name === 'sid');
      expect(sid).toBeDefined();
      // Standard ADR-001 session: it authenticates REST like any other.
      const who = await app.inject({
        method: 'GET',
        url: '/api/users/me',
        cookies: { sid: sid!.value },
      });
      expect(who.statusCode).toBe(200);

      // challenge_ref is one-shot.
      const replay = await post(null, '/api/auth/passkey-login', {
        challenge_ref,
        response: authenticationResponse(cred, options.challenge, 11),
      });
      expect(replay.statusCode).toBe(401);
      expect((replay.json() as { error: string }).error).toBe('bad_credentials');
    });

    it('a LOWER signature counter (cloned credential) is refused', async () => {
      const { challenge_ref, options } = await loginOptions(me.username);
      const res = await post(null, '/api/auth/passkey-login', {
        challenge_ref,
        response: authenticationResponse(cred, options.challenge, 3), // < 10
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe('bad_credentials');
      // The stored counter did not move backwards.
      const rows = (await db.execute(sqlTag`
        SELECT counter FROM passkey_credentials WHERE credential_id = ${cred.credId.toString('base64url')}
      `)) as unknown as { counter: string | number }[];
      expect(Number(rows[0]!.counter)).toBe(10);
    });

    it('an unknown credential / bogus ref answers the same 401', async () => {
      const { challenge_ref, options } = await loginOptions();
      const stranger = newFixtureCredential();
      const res = await post(null, '/api/auth/passkey-login', {
        challenge_ref,
        response: authenticationResponse(stranger, options.challenge, 1),
      });
      expect(res.statusCode).toBe(401);
      const bogus = await post(null, '/api/auth/passkey-login', {
        challenge_ref: 'bogus-ref',
        response: authenticationResponse(cred, options.challenge, 12),
      });
      expect(bogus.statusCode).toBe(401);
      expect(bogus.body).toBe(res.body); // byte-identical
    });

    it('TOTP-armed accounts gate passkey logins too (LoginOutcome)', async () => {
      // Arm TOTP for the passkey user.
      const setup = await post(me, '/api/auth/totp/setup');
      const b32 = (setup.json() as { manual_key: string }).manual_key.replace(/\s/g, '');
      const secret = totpLib.base32Decode(b32)!;
      const step = totpLib.totpStep(Date.now());
      const enable = await post(me, '/api/auth/totp/enable', {
        code: totpLib.totpCode(secret, step),
      });
      expect(enable.statusCode).toBe(200);

      const { challenge_ref, options } = await loginOptions(me.username);
      const res = await post(null, '/api/auth/passkey-login', {
        challenge_ref,
        response: authenticationResponse(cred, options.challenge, 20),
      });
      expect(res.statusCode).toBe(200);
      const outcome = res.json() as { totp_required?: boolean; totp_token?: string };
      expect(outcome.totp_required).toBe(true);
      expect(res.cookies.find((c) => c.name === 'sid')).toBeUndefined();

      // Finish the half-login with a drift-adjacent (unburned) step.
      const finish = await post(null, '/api/auth/totp', {
        totp_token: outcome.totp_token!,
        code: totpLib.totpCode(secret, step + 1),
      });
      expect(finish.statusCode).toBe(200);
      expect(finish.cookies.find((c) => c.name === 'sid')).toBeDefined();
    });

    it(`the PASSKEYS_MAX cap answers 409 passkeys_cap`, async () => {
      const capped = await register(`pkcap_${run}`);
      const values = Array.from({ length: PASSKEYS_MAX }, (_, i) =>
        `('${crypto.randomUUID()}', '${capped.userId}', 'cap-${run}-${i}', 'AA', 0)`,
      ).join(',');
      await db.execute(sqlTag.raw(`
        INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter)
        VALUES ${values}
      `));
      const options = await registerOptions(capped);
      const res = await post(capped, '/api/auth/passkeys', {
        response: registrationResponse(newFixtureCredential(), options.challenge),
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe('passkeys_cap');
    });
  });
});
