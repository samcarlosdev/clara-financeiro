// Cache do aplicativo, NÃO dos dados financeiros: estes permanecem no IndexedDB.
const CACHE = 'clara-shell-v7';
const ASSETS = ['./', './index.html', './styles.css', './src/app.js', './src/core.js', './src/storage.js', './src/sync.js', './src/cloud.js', './src/cloud-config.js', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png', './manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))), self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  // Primeiro tenta a rede; se estiver offline, usa arquivos em cache.
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
    }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())));
});
