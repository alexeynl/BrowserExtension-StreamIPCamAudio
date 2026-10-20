// offscreen.js — воспроизведение декодированного PCM (8 кГц, моно, Int16).
// Живёт в offscreen-документе, потому что в service worker MV3 нет Web Audio.
//
// Сообщения от background:
//   {target:'offscreen', type:'pcm', samples:[int16...], rate:8000} — пакет PCM
//   {target:'offscreen', type:'volume', value:0..1}
//   {target:'offscreen', type:'stop'}
//   {target:'offscreen', type:'hello'}   — пинг: отвечает pb-ready
// Сообщения в background:
//   {type:'pb-ready'}  — документ загрузился (или ответ на hello)
//   {type:'pb-stats', bufferedSec, underruns, dropped, packets, ctxState, gain}

const LEAD_SEC = 0.05;        // стартовый отступ планировщика
const RESYNC_SEC = 0.02;      // минимальный зазор после недогрузки
const MAX_QUEUE_SEC = 1.5;    // если плеер убежал вперёд — пакет отбрасывается

let ctx = null;
let master = null;
let nextStart = null;         // момент, на который запланирован следующий пакет
let volume = 1;
let stats = { bufferedSec: 0, underruns: 0, dropped: 0, packets: 0, resumeFails: 0 };

function report() {
  chrome.runtime.sendMessage({
    type: 'pb-stats',
    bufferedSec: stats.bufferedSec,
    underruns: stats.underruns,
    dropped: stats.dropped,
    packets: stats.packets,
    ctxState: ctx ? ctx.state : 'none',
    gain: master ? master.gain.value : volume
  }).catch(() => {});
}

function ensureAudio() {
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext();           // буферы 8 кГц ресемплируются автоматически
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    nextStart = null;
    // видимость состояния (running/suspended) в popup:
    ctx.onstatechange = () => report();
  }
  // Автоплей-политика: контекст может стартовать в suspended. Без resume()
  // currentTime замирает, буфер растёт до лимита и всё уходит в «отброшено».
  if (ctx.state === 'suspended') {
    ctx.resume().then(() => report()).catch(() => { stats.resumeFails++; report(); });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'hello') {
    // background может пинговать после создания документа/перезапуска SW —
    // подтверждаем готовность ещё раз (безопасно повторно).
    chrome.runtime.sendMessage({ type: 'pb-ready' }).catch(() => {});
    report();
  } else if (msg.type === 'pcm') {
    try {
      ensureAudio();
      playPacket(msg.samples);
    } catch (e) {
      console.warn('[player]', e.message);
    }
  } else if (msg.type === 'volume') {
    volume = Math.max(0, Math.min(1, Number(msg.value) || 0));
    if (master) master.gain.value = volume;
    report();
  } else if (msg.type === 'stop') {
    if (ctx) { ctx.close().catch(() => {}); ctx = null; master = null; nextStart = null; }
    stats = { bufferedSec: 0, underruns: 0, dropped: 0, packets: 0, resumeFails: 0 };
  }
});

function playPacket(samples) {
  const n = samples.length;
  if (!n) return;
  const now = ctx.currentTime;

  if (nextStart === null) nextStart = now + LEAD_SEC;

  // плеер отстал — пересинхронизация (пауза была = недогрузка)
  if (nextStart <= now) { nextStart = now + RESYNC_SEC; stats.underruns++; }

  // плеер убежал далеко вперёд (всплеск доставки) — пакет отбрасываем
  if (nextStart - now > MAX_QUEUE_SEC) { stats.dropped++; report(); return; }

  const buf = ctx.createBuffer(1, n, 8000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = samples[i] / 32768;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(master);
  src.start(nextStart);

  nextStart += n / 8000;
  stats.packets++;
  stats.bufferedSec = Math.max(0, nextStart - ctx.currentTime);
  if (stats.packets % 8 === 0) report();   // ~ раз в секунду
}

// Стартовая громкость: background шлёт её сразу после connectNative, когда этот
// документ ещё не загрузился (сообщение теряется) — поэтому читаем storage сами.
chrome.storage.local.get(['volume']).then(({ volume: v }) => {
  if (Number.isFinite(Number(v))) {
    volume = Math.max(0, Math.min(1, Number(v)));
    if (master) master.gain.value = volume;
  }
}).catch(() => {});

chrome.runtime.sendMessage({ type: 'pb-ready' }).catch(() => {});