/* SocialChat service worker.
 *
 * Receipt honesty rule (ARCHITECTURE §7 / API.md §2.4): this worker ONLY shows
 * notifications. It NEVER sends a `delivered` receipt — only a running client
 * that has durably stored the message (IndexedDB write committed) does.
 */

/* Offline app shell (ROADMAP M6): precache the shell + static assets at
 * install, serve navigations network-first with the cached shell as the
 * offline fallback, and cache immutable static assets on first use.
 * /api and /ws are never cached (REST is the durable path; sync is seq-based).
 */
const SHELL_CACHE = 'socialchat-shell-v2'; // bump = every cached page/asset is dropped on activate
const SHELL_URLS = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_URLS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never intercept the API or the WS upgrade.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  if (req.mode === 'navigate') {
    // Network-first; offline falls back to the cached page, then the shell.
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(req, res.clone());
          }
          return res;
        } catch {
          const cached = await caches.match(req);
          if (cached) return cached;
          const shell = await caches.match('/');
          if (shell) return shell;
          return Response.error();
        }
      })()
    );
    return;
  }

  const isStatic =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json';
  if (isStatic) {
    // Cache-first: hashed/immutable assets.
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put(req, res.clone());
        } else if (res.status === 404 && url.pathname.startsWith('/_next/static/')) {
          // Self-heal after a deploy (2026-10-18): a navigation that fell back
          // to a CACHED page (the server was restarting) references chunk
          // hashes that no longer exist — the page sits on an unstyled
          // "Loading…" forever. Drop every cached page so the next load is
          // fresh, and reload the windows we control, once.
          await healStaleShell();
        }
        return res;
      })()
    );
  }
});

let healing = false;
async function healStaleShell() {
  if (healing) return;
  healing = true;
  try {
    const cache = await caches.open(SHELL_CACHE);
    for (const key of await cache.keys()) {
      if (!new URL(key.url).pathname.startsWith('/_next/static/')) await cache.delete(key);
    }
    const wins = await self.clients.matchAll({ type: 'window' });
    await Promise.all(wins.map((w) => w.navigate(w.url).catch(() => undefined)));
  } finally {
    setTimeout(() => {
      healing = false;
    }, 10000);
  }
}

/* v0.7.1 ring push (API.md §1.55 + §2.9, FEATURES #88). Payloads carry a
 * `kind` discriminator from this release on; kind-less payloads stay plain
 * notifications exactly as before. Values mirror packages/shared/constants.ts
 * (the worker cannot import modules): PUSH_KIND_CALL_RING / _STOP,
 * PUSH_ACTION_ANSWER / _DECLINE, CALL_RING_PUSH_TAG_PREFIX 'call:'. */
const PUSH_KIND_CALL_RING = 'call.ring';
const PUSH_KIND_CALL_RING_STOP = 'call.ring.stop';
const PUSH_ACTION_ANSWER = 'answer';
const PUSH_ACTION_DECLINE = 'decline';

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  // Silent retraction: the call was handled somewhere (answered on another
  // device, rejected, cancelled, timed out, ended) — close the ring by tag
  // and show NOTHING (§1.55 "stops ringing the instant it is handled").
  if (payload.kind === PUSH_KIND_CALL_RING_STOP) {
    event.waitUntil(
      (async () => {
        const tag = typeof payload.tag === 'string' ? payload.tag : '';
        if (!tag) return;
        const shown = await self.registration.getNotifications({ tag });
        for (const n of shown) n.close();
      })()
    );
    return;
  }

  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Bored Chat';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    // tag = conversation_id (messages) or `call:<call_id>` (rings): stacked
    // notifications for one tag collapse; the ring stop closes by its tag.
    tag: typeof payload.tag === 'string' && payload.tag ? payload.tag : undefined,
    data: payload.data && typeof payload.data === 'object' ? payload.data : {},
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };
  if (payload.kind === PUSH_KIND_CALL_RING) {
    // Answer/Decline where the platform supports actions (iOS Safari does
    // not — a plain tap behaves as Answer, §2.9).
    options.actions = [
      { action: PUSH_ACTION_ANSWER, title: 'Answer' },
      { action: PUSH_ACTION_DECLINE, title: 'Decline' },
    ];
    options.data = Object.assign({ kind: PUSH_KIND_CALL_RING }, options.data);
  }
  // Wave 1 §1.4: a device with no session shows nothing — and drops its
  // subscription so the server stops addressing it. The probe is the same
  // same-origin fetch the call-decline path already makes.
  event.waitUntil(
    fetch('/api/users/me', { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
      .then((res) => {
        if (res.status === 401) {
          return self.registration.pushManager.getSubscription().then((s) => (s ? s.unsubscribe() : null)).then(() => undefined);
        }
        return self.registration.showNotification(title, options);
      })
      .catch(() => self.registration.showNotification(title, options)),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  // v0.7.1 (§2.9) Decline on a ring: DM → the worker POSTs the durable reject
  // itself (the sid cookie rides this same-origin fetch; X-Requested-With is
  // the CSRF header, API.md §0). Group → a decline is personal and ephemeral
  // (§1.42): there is nothing durable to write, closing is all it is.
  if (event.action === PUSH_ACTION_DECLINE && data.kind === PUSH_KIND_CALL_RING) {
    if (!data.is_group && typeof data.call_id === 'string') {
      event.waitUntil(
        fetch('/api/calls/' + encodeURIComponent(data.call_id) + '/reject', {
          method: 'POST',
          headers: { 'X-Requested-With': 'fetch' },
          credentials: 'same-origin',
        }).catch(() => undefined)
      );
    }
    return;
  }

  // Answer (and a plain tap) deep-links to data.url — the call screen, which
  // runs the normal §1.42 join (auto-accept rides the ?call= param).
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const win of wins) {
        let origin = null;
        try {
          origin = new URL(win.url).origin;
        } catch {
          origin = null;
        }
        if (origin === self.location.origin) {
          await win.focus();
          if ('navigate' in win) {
            try {
              await win.navigate(url);
            } catch {
              /* navigation refused; focus is enough */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
