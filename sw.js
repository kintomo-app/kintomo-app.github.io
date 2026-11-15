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

// ---------- 自然な声の 音声（voice/<声>/<名前>.mp3） ----------
// 保存分は「? の 後ろも ふくめた 場所」で 探す。アプリは「<名前>.mp3?r=<印>」で たのむ（ui/voice.js）。
// 印（目録の rev）は 音声を 作りなおすと 変わる（読み方の 辞書を 直したとき など）。印が 同じ 間は 保存分を ずっと 使い、
// 印が 変わったら 別の 場所 として 取りなおす。そのとき 同じ 名前の 古い 印の 保存分は 消す（場所を むだに しない）
// 注意：音声も 同じ 保存の 名前（CACHE_NAME）に 入れる。CACHE_VERSION を 上げると、保存した 音声も すべて 消え、
// 鳴らしたときに 取りなおしに なる（電波が 無い 所では、取りなおすまで スマホの声）。音声のために 上げる 必要は ない
// 音声の 再生は「ファイルの 一部（Range）」を たのむことが あり、一部の 返事（206）は 保存できない。
// そこで、保存するときは いつも ファイル全部を 取り、一部を たのまれたら 保存分から 切り出して 返す

function isVoiceClip(url) {
  return url.origin === self.location.origin && url.pathname.includes('voice/') && url.pathname.endsWith('.mp3');
}

// 「bytes=始め-終わり」を 読んで、切り出す 場所を 返す（読めない 形なら null）
function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') return { start: Math.max(0, size - Number(match[2])), end: size - 1 }; // 終わりから N バイト
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return { start, end };
}

// 一部を たのまれたら、その部分だけを 206 で 返す
async function rangeOrWhole(request, response) {
  const header = request.headers.get('range');
  if (!header) return response;
  const buffer = await response.arrayBuffer();
  const range = byteRange(header, buffer.byteLength);
  if (!range) return new Response(buffer, { status: 200, headers: response.headers });
  if (range.start > range.end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buffer.byteLength}` } });
  }
  return new Response(buffer.slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${range.start}-${range.end}/${buffer.byteLength}`,
      'Content-Length': String(range.end - range.start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

// 保存分を 探し（? の 後ろも ふくめて 同じ 場所だけ）、無ければ ファイル全部を 取って 保存する（取れなければ 失敗のまま 返す）
async function savedVoiceClip(cache, url) {
  const saved = await cache.match(url);
  if (saved) return saved;
  const response = await fetch(url); // Range を つけずに 全部 取る
  if (response.ok) {
    await cache.delete(url, { ignoreSearch: true }); // 同じ 名前の 古い 印の 音声を 消す
    await cache.put(url, response.clone());
  }
  return response;
}

async function voiceClip(request) {
  const cache = await caches.open(CACHE_NAME);
  const response = await savedVoiceClip(cache, request.url);
  if (!response.ok) return response;
  return rangeOrWhole(request, response);
}

// アプリから「数・合図の 音声を 先に 保存して」と たのまれたとき（ui/voice.js の precacheCommonVoices）。
// 一度に 3つずつ 取る（いっぺんに 取ると、電波の 弱い 所で 画面の 読みこみが おそく なるため）。
// 取れなかった 音声は とばす（あとで 鳴らしたときに 保存される）
const PRECACHE_AT_ONCE = 3;

async function precacheVoices(urls) {
  const cache = await caches.open(CACHE_NAME);
  for (let i = 0; i < urls.length; i += PRECACHE_AT_ONCE) {
    const batch = urls.slice(i, i + PRECACHE_AT_ONCE);
    await Promise.all(batch.map((url) => precacheOne(cache, url)));
  }
}

// index.json（目録）は 毎回 新しく 取りなおし、音声は 保存分が あれば 取らない
async function precacheOne(cache, url) {
  try {
    const href = new URL(url, self.location.href);
    // 「?r=」が 付いていても 音声と わかるように、? より 前（pathname）で 見る
    if (href.pathname.endsWith('.mp3')) await savedVoiceClip(cache, href.href);
    else await cache.add(url);
  } catch {
    // 取れなくても、ほかの 音声は 続けて 取る
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.type !== 'precache-voice' || !Array.isArray(data.urls)) return;
  const urls = data.urls.filter((url) => typeof url === 'string' && url.startsWith('voice/'));
  event.waitUntil(precacheVoices(urls));
});

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
  } else if (isVoiceClip(url)) {
    event.respondWith(voiceClip(request)); // 音声は 保存分優先（目録 index.json は 下の ネット優先）
  } else if (request.mode === 'navigate' || url.origin === self.location.origin) {
    event.respondWith(networkFirst(request)); // manifest やアイコンは名前が変わらないので、いつも最新を見に行く
  }
  // それ以外の別サイトへの通信は、そのままネットに任せる
});
