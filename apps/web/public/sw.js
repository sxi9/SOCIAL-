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
const SHELL_CACHE = 'socialchat-shell-v1';
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
        }
        return res;
      })()
    );
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'SocialChat';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    // tag = conversation_id: stacked notifications for one conversation collapse.
    tag: typeof payload.tag === 'string' && payload.tag ? payload.tag : undefined,
    data: payload.data && typeof payload.data === 'object' ? payload.data : {},
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
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
