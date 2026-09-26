/**
 * itemDB - Service Worker
 * アプリケーションシェルのオフラインキャッシュ
 */

const CACHE_NAME = 'itemdb-cache-v50';
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
  './js/jev.js'
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
  // Notion APIや外部CDNのリクエストはネットワーク直通 (キャッシュしない)
  if (event.request.url.includes('api.notion.com') ||
      event.request.url.includes('/api/') ||
      event.request.url.includes('corsproxy.io') ||
      event.request.url.includes('typesafe.ai') ||
      event.request.url.includes('googleapis.com') ||
      event.request.url.includes('openfoodfacts.org') ||
      event.request.url.includes('openbd.jp') ||
      event.request.url.includes('ndlsearch.ndl.go.jp') ||
      event.request.url.includes('yahooapis.jp') ||
      event.request.method !== 'GET') {
    return;
  }

  // ナビゲーションリクエスト & JS/CSS (コード更新が確実に反映されるようネットワーク優先)
  const url = new URL(event.request.url);
  const isCodeAsset = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');

  if (event.request.mode === 'navigate' || isCodeAsset) {
    event.respondWith(
      fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = cleanResponse(networkResponse.clone());
          const cacheKey = event.request.mode === 'navigate' ? './' : event.request;
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(cacheKey, responseToCache);
          });
        }
        return cleanResponse(networkResponse);
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('./').then((cachedResponse) => {
            if (cachedResponse) return cleanResponse(cachedResponse);
            return caches.match('./index.html').then(cleanResponse);
          });
        }
        return caches.match(event.request).then(cleanResponse);
      })
    );
    return;
  }

  // その他の静的アセット (icons, manifest等): キャッシュ優先
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cleanResponse(cachedResponse);
      }

      // /index.html へのリクエスト時のフォールバック
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
