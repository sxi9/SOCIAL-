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
  vapid:
    env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? {
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
          subject: env.VAPID_SUBJECT ?? `mailto:admin@${env.DOMAIN}`,
        }
      : null,
} as const;
