/* Offline cache: after the first visit the box runs with no network. */
var CACHE = "trade-box-v6";
var FILES = ["./", "index.html", "css/app.css", "js/symbols.js", "js/rng.js", "js/news.js", "js/market.js", "js/bots.js", "js/breeding.js",
  "js/sim.js", "js/report.js", "js/charts.js", "js/final.js", "js/app.js", "js/final-ui.js", "js/docs-push.js", "js/docs-ui.js", "js/updates.js", "vendor/xlsx.full.min.js", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png", "manifest.webmanifest"];
self.addEventListener("install", function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); })); self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }));
  self.clients.claim();
});
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then(function (r) {
    if (r.ok && new URL(e.request.url).origin === location.origin) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return r;
  }).catch(function () { return caches.match(e.request); }));
});
