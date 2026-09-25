/**
 * itemDB - Service Worker
 * アプリケーションシェルのオフラインキャッシュ
 */

const CACHE_NAME = 'itemdb-cache-v40';
const ASSETS_TO_CACHE = [
  './',
  './style.css',
  './manifest.json',
  './icons/icon.svg',
  './js/app.js',
  './js/state.js',
  './js/notion.js',
  './js/scanner.js',
  './js/audio.js',
  './js/ui.js',
  './js/barcode.js',
  './js/jev.js',
  './js/gemini.js'
];

/**
 * Safari (WebKit) の "Response served by service worker has redirections" エラー対策
 * redirected === true のレスポンスをそのまま返すとWebKitがセキュリティ例外を発生させるため、
 * 新しい Response オブジェクトとして再構築してクリーンなレスポンスを返却する。
 */
function cleanResponse(response) {
  if (!response || !response.redirected) {
    return response;
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  // Notion APIや外部CDNのリクエストはネットワーク優先
  if (event.request.url.includes('api.notion.com') ||
      event.request.url.includes('/api/') ||
      event.request.url.includes('corsproxy.io') ||
      event.request.method !== 'GET') {
    return;
  }

  // ナビゲーションリクエスト（HTMLページのトップレベル表示）: Network-First（オンライン時は最新取得、オフライン時はキャッシュ）
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = cleanResponse(networkResponse.clone());
          caches.open(CACHE_NAME).then((cache) => {
            cache.put('./', responseToCache);
          });
        }
        return cleanResponse(networkResponse);
      }).catch(() => {
        return caches.match('./').then((cachedResponse) => {
          if (cachedResponse) return cleanResponse(cachedResponse);
          return caches.match('./index.html').then(cleanResponse);
        });
      })
    );
    return;
  }

  // 通常のアセットリクエスト
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cleanResponse(cachedResponse);
      }

      // /index.html へのリクエスト時のフォールバック
      const url = new URL(event.request.url);
      if (url.pathname.endsWith('/index.html')) {
        return caches.match('./').then((rootResponse) => {
          if (rootResponse) return cleanResponse(rootResponse);
          return fetch(event.request).then(cleanResponse);
        });
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || (networkResponse.type !== 'basic' && networkResponse.type !== 'cors')) {
          return cleanResponse(networkResponse);
        }
        const responseToCache = cleanResponse(networkResponse.clone());
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return cleanResponse(networkResponse);
      });
    })
  );
});
