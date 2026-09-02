const CACHE = "rwang-shell-v7-security";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/perception.js",
  "/remote-client.js",
  "/icon.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("rwang-") && key !== CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Never persist bearer credentials, scoped invitations, or any query-bearing
  // navigation as a Cache Storage key.
  if (url.search || ["token", "shareToken", "viewerToken", "remoteSession", "ticket"]
    .some((key) => url.searchParams.has(key))) {
    event.respondWith(fetch(event.request));
    return;
  }

  const networkResponse = fetch(event.request);
  const cacheWrite = networkResponse
    .then((response) => {
      if (!response.ok) return undefined;
      return caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    })
    .catch(() => undefined);

  event.waitUntil(cacheWrite);
  event.respondWith(networkResponse.catch(async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    if (event.request.mode === "navigate") {
      const shell = await cache.match("/index.html");
      if (shell) return shell;
    }
    return new Response("Offline", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }));
});
