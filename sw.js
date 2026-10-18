/* Offline cache for ABR Unlock: serve instantly from cache, refresh in the background. */
var CACHE = 'abr-unlock-v3.0';
var ASSETS = ['./', './index.html', './app.js', './fsrs.js', './sqlite.js', './anki.js', './vendor/katex.min.js', './vendor/jszip.min.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  var key = url.origin + url.pathname; // ignore ?gate=1 etc.
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(key).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      });
      if (cached) { e.waitUntil(network.catch(function () {})); return cached; }
      return network.catch(function () { return cache.match(url.origin + url.pathname.replace(/[^/]*$/, '')); });
    });
  }));
});
