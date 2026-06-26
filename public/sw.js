// ponytail: minimal SW just to make the app installable; no offline caching
// (the app is useless without the live server anyway). Add caching only if needed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // pass-through
