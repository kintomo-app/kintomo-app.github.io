// オフラインで動かすための Service Worker。
// 置き場所のフォルダ名に左右されないよう、パスはすべて相対で書く。
const CACHE_VERSION = 'v1';
const CACHE_PREFIX = 'takutore-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

self.addEventListener('install', (event) => {
  // 最低限の3つを先に保存しておく（残りは使ったときに保存される）
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest']))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 古い版の保存分は消す。ブログと同じ場所にあるので、このアプリの名前のものだけを消す
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// ネット優先。つながらないときだけ保存分を使う（画面の読み込みと、名前が変わらないファイル用）
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const saved = (await cache.match(request)) || (await cache.match('./index.html'));
    if (saved) return saved;
    throw error;
  }
}

// 保存分優先。なければネットから取って保存する
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
  return response;
}

// assets/ の中はファイル名に目印（ハッシュ）が付くので、保存分をずっと使ってよい
function isHashedAsset(url) {
  return url.origin === self.location.origin && url.pathname.includes('assets/');
}

// 注意: 1回めの訪問では、画面の部品（JS・CSS）が Service Worker の登録より先に読み込まれるため保存されない。
// オフラインで動くのは「ネットにつながった状態で2回めに開いたあと」から。これは仕様なので直さないこと。
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // GET 以外は触らない
  const url = new URL(request.url);
  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(request));
  } else if (request.mode === 'navigate' || url.origin === self.location.origin) {
    event.respondWith(networkFirst(request)); // manifest やアイコンは名前が変わらないので、いつも最新を見に行く
  }
  // それ以外の別サイトへの通信は、そのままネットに任せる
});
