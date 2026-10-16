// Run-once `migrate` compose service entrypoint (ARCHITECTURE §1/§3):
// applies hand-written SQL migrations idempotently (journal table) and
// creates the MinIO bucket. api and worker depend_on this completing.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import postgres from 'postgres';
import { config } from '../config.js';
import { BUCKET, s3 } from '../s3.js';

async function applyMigrations(): Promise<void> {
  const sql = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const [applied] = await sql`SELECT 1 FROM _migrations WHERE name = ${file}`;
      if (applied) {
        console.log(`migrate: ${file} already applied`);
        continue;
      }
      const ddl = readFileSync(join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      console.log(`migrate: applied ${file}`);
    }
  } finally {
    await sql.end();
  }
}

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`migrate: bucket "${BUCKET}" exists`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log(`migrate: created bucket "${BUCKET}"`);
  }
}

async function main(): Promise<void> {
  await applyMigrations();
  await ensureBucket();
  console.log('migrate: done');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('migrate: failed', err);
    process.exit(1);
  });
