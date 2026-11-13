const CACHE = 'my-pace-static-v13-pace';
const FILES = ['./','./index.html','./styles.css','./styles.css?v=stitch-7','./styles.css?v=pace-13','./src/app.js','./src/app.js?v=stitch-7','./src/app.js?v=pace-13','./src/map-adapter.js','./src/map-adapter.js?v=stitch-7','./src/map-config.js','./src/account-ui.js','./src/account-ui.js?v=auth-11','./src/firebase-session.js','./src/firebase-config.js','./src/navigation-client.js','./src/navigation-client.js?v=auth-11','./src/core.js','./src/services.js','./src/meeting.js','./src/sharing.js','./src/meetup-ui.js','./assets/vendor/leaflet.js','./assets/vendor/leaflet.css','./assets/icon.svg','./manifest.webmanifest'];
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
