import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DOMAIN: z.string().default('localhost'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3001),

  DATABASE_URL: z.string().optional(),
  POSTGRES_HOST: z.string().default('postgres'),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_USER: z.string().default('socialchat'),
  POSTGRES_PASSWORD: z.string().default('socialchat'),
  POSTGRES_DB: z.string().default('socialchat'),

  REDIS_URL: z.string().default('redis://redis:6379'),

  MINIO_ENDPOINT: z.string().default('http://minio:9000'),
  MINIO_ROOT_USER: z.string().default('minioadmin'),
  MINIO_ROOT_PASSWORD: z.string().default('minioadmin'),
  MINIO_BUCKET: z.string().default('media'),

  SESSION_SECRET: z.string().min(16).default('dev-secret-change-me-please'),

  // v0.4 (API.md §1.27): salts the daily-puzzle word selection —
  // PUZZLE_WORDLIST[sha256(`${yyyy-mm-dd}:${PUZZLE_SECRET}`) mod length].
  // Server-side only, so clients can never precompute the word. Optional:
  // when unset (or blank, as a commented-out .env line yields), the secret is
  // DERIVED from SESSION_SECRET below — never a committed public default,
  // which would make every day's word precomputable from the public repo.
  // '' (a blank `PUZZLE_SECRET=` .env line) counts as unset; a non-empty
  // value shorter than 8 chars fails loudly rather than being ignored.
  PUZZLE_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  // v0.8b (API.md §1.69, ADR-020): the running build's git commit, BAKED at
  // `docker build` via the GIT_COMMIT build arg (null in dev — the admin
  // banner then says "dev build"). Never computed at runtime: the container
  // has no .git and no docker.sock.
  GIT_COMMIT: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(7).optional()),
  // v0.8b (§1.69): the instance repo remote the update-check worker peeks at
  // via the git HTTPS smart protocol (info/refs — first-party git, no API, no
  // key, golden rule 7). Unset → the check is skipped and update_available
  // stays null (documented honesty, never a guess).
  UPDATE_CHECK_REMOTE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional(),
  ),

  // v0.9 (API.md §1.70, ADR-021): the instance's canonical public origin
  // (e.g. https://chat.example.com). Feeds WebAuthn's expected origin and the
  // rpID derivation below. Optional — DOMAIN remains the fallback.
  PUBLIC_ORIGIN: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  // v0.9 (§1.70): explicit WebAuthn rpID override. Unset → hostname of
  // PUBLIC_ORIGIN → DOMAIN. Passkeys BIND to this domain (ADR-021's quick-
  // tunnel caveat: a per-run tunnel domain orphans every credential).
  WEBAUTHN_RP_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  // v0.9 (§1.74): when set, takes precedence over the encrypted stored SMTP
  // password (the env-reference option in SPECS #86). Config-only in v0.9 —
  // no mailer ships (golden rule 10; ADR-021).
  SMTP_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),

  // v0.6 calls (API.md §1.42, ADR-014): the shared secret between the api
  // (mints time-limited HMAC credentials) and the coturn service (verifies
  // them, static-auth-secret mode). '' (a blank `TURN_SECRET=` .env line)
  // counts as unset: the api then answers turn:null on create/join and
  // 503 turn_unconfigured on GET /api/turn-credentials — local dev connects
  // on host candidates without any relay.
  TURN_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
});

const env = EnvSchema.parse(process.env);

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  domain: env.DOMAIN,
  host: env.HOST,
  port: env.PORT,
  databaseUrl:
    env.DATABASE_URL ??
    `postgres://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`,
  redisUrl: env.REDIS_URL,
  minio: {
    endpoint: env.MINIO_ENDPOINT,
    accessKeyId: env.MINIO_ROOT_USER,
    secretAccessKey: env.MINIO_ROOT_PASSWORD,
    bucket: env.MINIO_BUCKET,
  },
  sessionSecret: env.SESSION_SECRET,
  // Unset/blank → derive from SESSION_SECRET (domain-separated), so any
  // deployment that set its session secret gets an unguessable puzzle salt
  // for free; setting PUZZLE_SECRET explicitly pins the word schedule so a
  // session-secret rotation doesn't reshuffle it mid-stream.
  puzzleSecret: env.PUZZLE_SECRET ?? `puzzle:${env.SESSION_SECRET}`,
  // v0.8b (§1.69): build identity + update-check remote; both null-safe.
  gitCommit: env.GIT_COMMIT ?? null,
  updateCheckRemote: env.UPDATE_CHECK_REMOTE ?? null,
  // v0.9 (§1.70/§1.74, ADR-021): WebAuthn identity + the env SMTP password.
  // rpID = WEBAUTHN_RP_ID → hostname of PUBLIC_ORIGIN → DOMAIN; expected
  // origins = PUBLIC_ORIGIN → https://<DOMAIN>, plus localhost dev origins
  // outside production (the web dev server ports used across this repo).
  publicOrigin: env.PUBLIC_ORIGIN ?? null,
  smtpPasswordEnv: env.SMTP_PASSWORD ?? null,
  webauthn: {
    rpId:
      env.WEBAUTHN_RP_ID ??
      (env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).hostname : env.DOMAIN),
    origins: [
      ...(env.PUBLIC_ORIGIN
        ? [env.PUBLIC_ORIGIN.replace(/\/+$/, '')]
        : [`https://${env.DOMAIN}`]),
      ...(env.NODE_ENV === 'production'
        ? []
        : [
            `http://${env.DOMAIN}`,
            'http://localhost:3000',
            'http://localhost:3100',
            'http://localhost:3310',
          ]),
    ],
  },
  // null = no TURN relay configured (ADR-014): calls still work on host
  // candidates between same-network peers; the §1.42 responses carry turn:null.
  turnSecret: env.TURN_SECRET ?? null,
  vapid:
    env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? {
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
          subject: env.VAPID_SUBJECT ?? `mailto:admin@${env.DOMAIN}`,
        }
      : null,
} as const;
