self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("testsetu-v1").then((cache) => cache.addAll(["/", "/manifest.webmanifest", "/icon.svg"])));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
