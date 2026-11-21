const CACHE = 'my-pace-static-v28';
// One URL per file and no ?v= query strings, here or in any import. Two different URLs for the
// same module are loaded as two separate module instances with separate state.
// tests/modules.test.mjs fails when a source file is missing from this list.
const FILES = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './src/app.js', './src/account-ui.js', './src/bus-pilot.js', './src/core.js',
  './src/firebase-config.js', './src/firebase-session.js', './src/login-gate.js', './src/map-adapter.js', './src/map-config.js',
  './src/meeting.js', './src/meetup-ui.js', './src/navigation-client.js', './src/navigation.js',
  './src/services.js', './src/sharing.js',
  './assets/vendor/leaflet.js', './assets/vendor/leaflet.css', './assets/icon.svg',
];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('my-pace-static-') && key !== CACHE).map(key => caches.delete(key))))); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache location-bearing routing, geocoding, bus queries or map tiles.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const allowed = FILES.map(path => new URL(path,self.registration.scope).href);
  if (!allowed.includes(url.href)) return;
  // Network first, and always revalidate with the server: a new release must never run as a
  // mix of old (browser-cached) and new modules. The cache is only the offline fallback.
  event.respondWith(fetch(event.request,{cache:'no-cache'}).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request,copy)); }
    return response;
  }).catch(() => caches.match(event.request)));
});
