// Samvaad service worker: lets the app install on phones and open its shell
// offline. Pages and API calls always go to the network first, so customers
// never see stale loan numbers.
var CACHE = "samvaad-v1";
var SHELL = [
  "/static/css/fonts.css", "/static/css/samvaad.css", "/static/css/app.css",
  "/static/js/app.js", "/static/icons/icon-192.png",
  "/static/fonts/mukta-latin-400-normal.woff2", "/static/fonts/tiro-devanagari-hindi-latin-400-normal.woff2"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.indexOf("/static/") === 0) {
    // static files: cache first, refresh in the background
    e.respondWith(caches.open(CACHE).then(function (c) {
      return c.match(e.request).then(function (hit) {
        var net = fetch(e.request).then(function (res) { if (res.ok) c.put(e.request, res.clone()); return res; });
        return hit || net;
      });
    }));
  }
  // everything else (pages, /api, /auth) goes straight to the network
});
