// Update check (v0.8b — API.md §1.69d, ADR-020). One GET of
// <UPDATE_CHECK_REMOTE>/info/refs?service=git-upload-pack — the git HTTPS
// smart protocol's ref advertisement: first-party git, no API, no key, no
// SaaS (golden rule 7). Parses HEAD's sha and caches {latest_commit,
// checked_at} in Redis; the admin banner reads the cache. SSRF posture as
// §1.7: ONE fixed host from env, no redirect following. Unreachable remote →
// the cache keeps its last value and update_available stays honest (null
// when nothing was ever fetched). The update itself always runs on the HOST
// (./bored update) — the container never gets docker.sock.
import { UPDATE_CHECK_TIMEOUT_MS } from '@socialchat/shared';
import { config } from '../config.js';
import { redis } from '../redis.js';
import { UPDATE_CHECK_REDIS_KEY } from '../modules/admin/content.js';

export async function runUpdateCheck(): Promise<void> {
  const remote = config.updateCheckRemote;
  if (!remote) return; // unconfigured instance — the banner says null, honestly

  const url = `${remote.replace(/\/+$/, '')}/info/refs?service=git-upload-pack`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  let text: string;
  try {
    const res = await fetch(url, {
      redirect: 'manual', // fixed host; redirects are refused (§1.7 posture)
      signal: controller.signal,
      headers: { 'user-agent': 'bored-chat-update-check' },
    });
    if (res.status !== 200) return;
    text = await res.text();
  } catch {
    return; // unreachable — keep the last cached answer
  } finally {
    clearTimeout(timer);
  }

  // The advertisement's first ref line: "<pkt-len><sha> HEAD\0capabilities…"
  // (symrefs name the default branch; the sha before " HEAD" is what runs).
  const m = /([0-9a-f]{40}) HEAD/.exec(text);
  if (!m) return;
  await redis.set(
    UPDATE_CHECK_REDIS_KEY,
    JSON.stringify({ latest_commit: m[1], checked_at: new Date().toISOString() }),
  );
}
