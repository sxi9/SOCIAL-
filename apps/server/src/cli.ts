// Entrypoint: ops commands (ARCHITECTURE §4). Password reset is CLI-only in
// the MVP: prints a one-time temporary password and revokes all sessions.
//   docker compose exec api node dist/cli.js reset-password <username>
// v0.5b (API.md §1.41, ADR-013): adminhood is CLI-ONLY — shell access to the
// box is the root of trust; there is no web path to promote anyone.
//   docker compose exec api node dist/cli.js grant-admin <username>
//   docker compose exec api node dist/cli.js revoke-admin <username>
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { db, pg, schema } from './db/index.js';
import { pushRingEntry } from './lib/logring.js';
import { ARGON2_OPTS, revokeAllSessions } from './modules/auth/service.js';
import { redis } from './redis.js';

async function resetPassword(username: string): Promise<void> {
  const [user] = await db
    .select({ id: schema.users.id, username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);
  if (!user) {
    console.error(`reset-password: user "${username}" not found`);
    process.exitCode = 1;
    return;
  }

  const tempPassword = randomBytes(12).toString('base64url');
  const passwordHash = await argon2.hash(tempPassword, ARGON2_OPTS);
  await db
    .update(schema.users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(schema.users.id, user.id));
  await revokeAllSessions(user.id);

  console.log(`One-time temporary password for ${user.username}:`);
  console.log(`  ${tempPassword}`);
  console.log('All sessions have been revoked. The user should log in and change it.');
}

/** v0.5b (§1.41): flip users.is_admin — CLI-only, ring-logged via stdout +
 * the admin log ring (actor is the operator's shell, so entries carry the
 * target only). */
async function setAdmin(username: string, isAdmin: boolean): Promise<void> {
  const [user] = await db
    .select({ id: schema.users.id, username: schema.users.username, isAdmin: schema.users.isAdmin })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);
  if (!user) {
    console.error(`${isAdmin ? 'grant' : 'revoke'}-admin: user "${username}" not found`);
    process.exitCode = 1;
    return;
  }
  if (user.isAdmin === isAdmin) {
    console.log(`${user.username} is ${isAdmin ? 'already' : 'not'} an admin — nothing to do.`);
    return;
  }
  await db
    .update(schema.users)
    .set({ isAdmin, updatedAt: new Date() })
    .where(eq(schema.users.id, user.id));
  pushRingEntry({
    ts: new Date().toISOString(),
    level: 'admin',
    msg: isAdmin ? 'cli.grant_admin' : 'cli.revoke_admin',
    actor: null, // the operator's shell, not an account
    data: { target_id: user.id, target_username: user.username },
  });
  console.log(`${user.username} is ${isAdmin ? 'now an admin' : 'no longer an admin'}.`);
}

const USAGE = 'usage: cli reset-password <username> | grant-admin <username> | revoke-admin <username>';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'reset-password': {
      const username = args[0];
      if (!username) {
        console.error('usage: cli reset-password <username>');
        process.exitCode = 1;
        break;
      }
      await resetPassword(username);
      break;
    }
    case 'grant-admin':
    case 'revoke-admin': {
      const username = args[0];
      if (!username) {
        console.error(`usage: cli ${command} <username>`);
        process.exitCode = 1;
        break;
      }
      await setAdmin(username, command === 'grant-admin');
      break;
    }
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('cli: failed', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pg.end({ timeout: 5 }).catch(() => {});
    redis.disconnect();
    // Allow the publish of session-close events to flush before exit.
    setTimeout(() => process.exit(), 250).unref();
  });
