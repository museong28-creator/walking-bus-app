const CACHE = 'my-pace-static-v6-stitch';
const FILES = ['./','./index.html','./styles.css','./styles.css?v=stitch-6','./src/app.js','./src/app.js?v=stitch-6','./src/map-adapter.js','./src/map-config.js','./src/core.js','./src/services.js','./src/meeting.js','./src/sharing.js','./src/meetup-ui.js','./assets/vendor/leaflet.js','./assets/vendor/leaflet.css','./assets/icon.svg','./manifest.webmanifest'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('my-pace-static-') && key !== CACHE).map(key => caches.delete(key))))); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache location-bearing routing, geocoding, bus queries or map tiles.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const allowed = FILES.map(path => new URL(path,self.registration.scope).href);
  if (!allowed.includes(url.href)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request,copy)); }
    return response;
  }).catch(() => caches.match(event.request)));
});
