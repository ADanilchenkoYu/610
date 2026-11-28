/* Музей Саши: работа без интернета. Свои файлы — сначала из сети (чтобы обновления приходили сразу), без связи — из кэша. */
const CACHE = 'museum-v6';
const CORE = ['./', 'index.html', 'app.js', 'catalog.js', 'manifest.webmanifest', 'fonts/Lora-Variable.ttf', 'fonts/Lora-Italic-Variable.ttf',
  'img/oleg.jpg', 'img/cosette.jpg', 'icons/icon-192.png', 'parochki/', 'klassiki/', 'lenta/', 'mify/'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const cl = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cl)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
