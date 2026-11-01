const CACHE = "djym-shell-v2";
const SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/domain.js",
  "/db.js",
  "/api.js",
  "/sync.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("djym-shell-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // An explicit public allowlist, not a navigation catch-all. Never intercept
  // auth/API/Swagger, non-GET, query strings, or user-data responses.
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.search ||
    !SHELL.includes(url.pathname)
  )
    return;
  event.respondWith(
    caches
      .open(CACHE)
      .then(
        async (cache) =>
          (await cache.match(url.pathname)) || fetch(event.request),
      ),
  );
});
