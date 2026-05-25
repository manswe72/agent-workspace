// agent-workspace dashboard — tier-1 PWA shell offline.
//
// Precaches the static shell on install so the PWA window can open
// even when the server is down — dashboard.js then shows the
// "Server unreachable" banner because the /api/status heartbeat
// fails. Dynamic data is *not* cached (no stale-state mode here).
//
// Cache versioning: the Python /sw.js handler substitutes
// __SW_VERSION__ with a hash of every precached asset's mtime, so
// any static-file change rewrites the SW body → Chromium installs a
// fresh worker → activate() drops the old cache.

const CACHE_NAME = 'agent-workspace-shell-__SW_VERSION__';

// Paths to precache. These are the unversioned URLs; the dashboard
// loads versioned variants (e.g. /static/dashboard.js?v=NNN), so the
// fetch handler matches with `ignoreSearch: true`.
const PRECACHE = [
  '/',
  '/static/dashboard.css',
  '/static/dashboard.js',
  '/static/favicon.svg',
  '/static/manifest.json',
  '/static/xterm/xterm.css',
  '/static/xterm/xterm.js',
  '/static/xterm/xterm-addon-fit.js',
  '/static/xterm/xterm-addon-web-links.js',
  '/static/xterm/xterm-addon-search.js',
  '/static/xterm/xterm-addon-unicode11.js',
  '/static/xterm/xterm-addon-image.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll is atomic — if any URL 404s the whole install fails,
    // which is the right behaviour: we don't want a half-cached
    // shell that boots a broken page when the server is down.
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('agent-workspace-shell-') && n !== CACHE_NAME)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API + dynamic endpoints: network-only. We don't want the page to
  // render stale state without the user knowing — the banner is the
  // signal that the server is unreachable.
  if (url.pathname.startsWith('/api/')
      || url.pathname === '/healthz'
      || url.pathname === '/sw.js') {
    return;  // let the browser handle it (no caching)
  }

  // Navigations (`/`): network-first, cache fallback. Keeps the
  // dashboard fresh when online; lets the PWA window open offline.
  if (req.mode === 'navigate' || url.pathname === '/') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put('/', fresh.clone()).catch(() => {});
        return fresh;
      } catch (_) {
        const cached = await caches.match('/', { ignoreSearch: true });
        if (cached) return cached;
        return new Response(
          '<!doctype html><meta charset=utf-8><title>Offline</title>'
          + '<p style="font-family:sans-serif;padding:2rem">'
          + 'Dashboard is offline and no cached copy is available yet.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  // Static assets: cache-first. Precache contains the canonical copy;
  // ignoreSearch lets versioned URLs (?v=NNN) hit the same entry.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith((async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (e) {
        return Response.error();
      }
    })());
  }
});
