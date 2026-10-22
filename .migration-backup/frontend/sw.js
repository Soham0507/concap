/**
 * Service Worker for the booth PWA.
 *
 * Responsibilities:
 *   1. Cache the app shell (HTML + JS + CSS + manifest) so the booth UI
 *      loads even when the venue Wi-Fi is dead.
 *   2. Use a network-first strategy for /api/* so live data wins when
 *      online, but the page still boots offline.
 *   3. On 'sync' events (Background Sync API), poke the open page to drain
 *      its IndexedDB queue. The actual upload work runs in the page, not
 *      here — the SW has no access to the IDB Blob entries' page-scoped
 *      object URLs, and keeping all queue logic in one place is simpler.
 */

const SHELL_CACHE = "booth-shell-v13";
const SHELL_URLS = [
  "/",
  "/booth",
  "/login",
  "/static/booth.html",
  "/static/login.html",
  "/static/signup.html",
  "/static/change-password.html",
  "/static/members.html",
  "/static/admin.html",
  "/static/transcribe.html",
  "/static/dashboard.html",
  "/all-meetings",
  "/static/all-meetings.html",
  "/static/all-meetings.js",
  "/static/styles.css",
  "/static/auth.js",
  "/static/booth.js",
  "/static/dashboard.js",
  "/static/members.js",
  "/static/admin.js",
  "/static/transcribe.js",
  "/static/queue.js",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept the capture upload endpoint — the page handles retries
  // via the IDB queue, and stale cached responses would be actively harmful.
  if (url.pathname.startsWith("/api/captures")) return;

  // API: network-first, fall back to cache only as a last resort.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Page navigations (HTML documents): NETWORK-FIRST. Always serve fresh
  // HTML when online so a deploy / auth change can't be masked by a stale
  // cached page. Fall back to cache only when genuinely offline.
  const isNavigation =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");
  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("/login"))),
    );
    return;
  }

  // Same-origin static assets (our CSS/JS/manifest): NETWORK-FIRST when
  // online so a code change is never masked by a stale cached script.
  // Fall back to cache only when the network actually fails (offline).
  // Cross-origin assets (e.g. Google Fonts) stay cache-first for speed.
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Cross-origin: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => cached);
      return cached || networkFetch;
    }),
  );
});

self.addEventListener("sync", (event) => {
  if (event.tag === "booth-capture-drain") {
    event.waitUntil(notifyClientsToDrain());
  }
});

async function notifyClientsToDrain() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  if (clients.length === 0) {
    // No open page — there's nothing we can do from the SW alone, since the
    // queue lives in page-accessible IDB. The next page load will drain.
    return;
  }
  for (const client of clients) {
    client.postMessage({ type: "drain" });
  }
}
