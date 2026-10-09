const CACHE_NAME = 'nakhodka-v1';
const ASSETS = [
  '/',
  '/index.html'
];

// Установка — кэшируем базовые файлы
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Активация — чистим старые кэши
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Перехват запросов — сеть в приоритете, кэш как fallback
self.addEventListener('fetch', event => {
  // API-запросы не кэшируем
  if (event.request.url.includes('/api/')) return;
  // socket.io не кэшируем
  if (event.request.url.includes('socket.io')) return;
  // Только GET-запросы
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});