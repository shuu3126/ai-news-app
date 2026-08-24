// キャッシュ名を変えると古いキャッシュが activate 時に破棄される。
// アプリを更新したらここのバージョンを上げること。
const CACHE_NAME = 'ainews-v1';
const APP_SHELL_URLS = [
    './',
    './index.html',
    './css/style.css',
    './js/app.js',
    './js/storage.js',
    './js/gemini.js',
    './js/speech.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL_URLS))
            .then(() => self.skipWaiting()) // 新しいService Workerがすぐにアクティブになるようにする
            .catch((error) => {
                console.error('[Service Worker] App Shellのキャッシュに失敗しました:', error);
            })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => Promise.all(
            cacheNames.map((cacheName) => {
                if (cacheName !== CACHE_NAME) {
                    return caches.delete(cacheName);
                }
            })
        )).then(() => self.clients.claim()) // すぐに制御を開始する
    );
});

self.addEventListener('fetch', (event) => {
    // GETかつ同一オリジンのリクエストだけを処理する。
    // Gemini APIへのPOST（クロスオリジン）はService Workerを素通りさせる。
    if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
        return;
    }

    // respondWith には Promise を渡す必要がある（関数を渡すと必ず失敗する）ので、
    // async即時実行関数の「戻り値」を渡すこと。
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);

        try {
            // network-first: まずネットワークから取りに行く
            const networkResponse = await fetch(event.request);
            if (networkResponse.ok) {
                // clone() しないと本文が二重に消費されて壊れる
                cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
        } catch (error) {
            // オフライン時はキャッシュへフォールバック
            const cachedResponse = await cache.match(event.request);
            if (cachedResponse) {
                return cachedResponse;
            }
            if (event.request.mode === 'navigate') {
                const shell = await cache.match('./index.html');
                if (shell) return shell;
            }
            // それ以外は必ずResponseを返す。undefinedを返すと例外になる。
            return new Response('', { status: 504, statusText: 'Offline and not cached' });
        }
    })());
});
