/* Музей Саши: работа без интернета. Свои файлы — из кэша с фоновым обновлением; база — только сеть. */
const CACHE = 'museum-v1';
const CORE = ['./', 'index.html', 'app.js', 'catalog.js', 'manifest.webmanifest', 'fonts/Lora-Variable.ttf', 'fonts/Lora-Italic-Variable.ttf',
  'img/oleg.jpg', 'img/cosette.jpg', 'icons/icon-192.png', 'parochki/', 'parochki/index.html', 'klassiki/', 'klassiki/index.html'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
