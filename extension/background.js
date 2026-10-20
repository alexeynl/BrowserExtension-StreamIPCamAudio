// background.js — service worker (MV3)
// Поток камеры -> native host -> ФРЕЙМЕР+ДЕКОДЕР (codec.js) -> offscreen-плеер.

importScripts('codec.js');

const HOST_NAME = 'com.camera.audio';
const OFFSCREEN_URL = 'offscreen.html';
const SEC_PER_PACKET = KaicongCodec.SAMPLES_PER_PACKET / KaicongCodec.RATE_HZ; // 0.128 c

let port = null;
let stream = null;                 // KaicongStream: буферизация + декодирование
let volume = 1;
let offscreenReady = false;
let pbQueue = [];                  // PCM до готовности offscreen-документа

let stats = {
  running: false, chunks: 0, bytes: 0,
  startedAt: 0, lastChunkAt: 0, error: null,
  packets: 0, pcmSec: 0,           // декодировано
  bufferedSec: 0, underruns: 0, dropped: 0,   // плеер (offscreen)
  audio: null                      // { state, gain } — состояние звука в offscreen
};

function broadcast() {
  // popup может быть закрыт — ошибку доставки просто игнорируем
  chrome.runtime.sendMessage({ type: 'stats', stats }).catch(() => {});
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function validateConfig(cfg) {
  if (!cfg.host || !/^[\w.-]+$/.test(cfg.host)) return 'Укажите корректный host (IP или имя)';
  const p = Number(cfg.port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Порт — целое число 1–65535';
  if (!cfg.path || !cfg.path.startsWith('/')) return 'Путь должен начинаться с "/"';
  return null;
}

// ==== offscreen-документ (там живёт AudioContext — в service worker его нет) ====

async function ensureOffscreen() {
  if (!chrome.offscreen) {
    stats.error = 'Ваш браузер старше 109 — нет chrome.offscreen, воспроизведение недоступно';
    broadcast();
    return false;
  }
  try {
    if (await chrome.offscreen.hasDocument()) {
      // Документ пережил перезапуск service worker: он жив, но его pb-ready
      // ушёл в прежний (мертвый) SW — пингуем, чтобы получить свежий.
      offscreenReady = true;
      toOffscreen({ target: 'offscreen', type: 'hello' });
      return true;
    }
  } catch (e) { /* Chrome < 116: hasDocument нет — пробуем создать */ }

  // ВАЖНО: сбросить флаг ДО createDocument. Если сделать это после await,
  // быстро загрузившийся документ успеет прислать pb-ready, и мы затрём
  // готовность обратно в false — пакеты навсегда застрянут в pbQueue.
  offscreenReady = false;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Проигрывание декодированного аудиопотока IP-камеры'
    });
  } catch (e) {
    if (/single offscreen document|already/i.test(String(e.message))) offscreenReady = true;
    else console.warn('[offscreen]', e.message);
  }
  // Рукопожатие: как бы ни разошлись тайминги загрузки документа,
  // он ответит pb-ready на 'hello' — и очередь PCM уйдёт в плеер.
  toOffscreen({ target: 'offscreen', type: 'hello' });
  return true;
}

function closeOffscreen() {
  offscreenReady = false;
  pbQueue = [];
  if (chrome.offscreen) chrome.offscreen.closeDocument().catch(() => {});
}

function toOffscreen(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function flushPbQueue() {
  const q = pbQueue; pbQueue = [];
  for (const m of q) toOffscreen(m);
}

function sendPcm(pcm) {
  const msg = { target: 'offscreen', type: 'pcm', rate: KaicongCodec.RATE_HZ, samples: Array.from(pcm) };
  if (offscreenReady) toOffscreen(msg);
  else { pbQueue.push(msg); if (pbQueue.length > 40) pbQueue.shift(); }
}

// ==== поток ====

async function start() {
  if (port) return null;
  const cfg = await chrome.storage.local.get(['host', 'port', 'path', 'auth', 'volume']);
  const err = validateConfig(cfg);
  if (err) return err;

  volume = Number.isFinite(Number(cfg.volume)) ? Number(cfg.volume) : 1;
  stream = null;
  pbQueue = [];
  stats = {
    running: true, chunks: 0, bytes: 0, startedAt: Date.now(), lastChunkAt: 0, error: null,
    packets: 0, pcmSec: 0, bufferedSec: 0, underruns: 0, dropped: 0, audio: null
  };

  await ensureOffscreen();          // плеер готовится, пока камера отвечает

  port = chrome.runtime.connectNative(HOST_NAME);

  port.onMessage.addListener((msg) => {
    if (msg.error) { stats.error = msg.error; broadcast(); return; }
    if (msg.meta) { console.log('[camera] заголовки ответа камеры:\n' + msg.meta); return; }
    if (msg.audio) handleAudioChunk(b64ToBytes(msg.audio));
    else if (msg.eof) { stats.running = false; broadcast(); }
  });

  port.onDisconnect.addListener(() => {
    stats.running = false;
    stats.error = chrome.runtime.lastError ? chrome.runtime.lastError.message : stats.error;
    port = null;
    closeOffscreen();
    broadcast();
  });

  port.postMessage({
    host: cfg.host,
    port: Number(cfg.port),
    path: cfg.path,
    auth: cfg.auth || null   // опционально "user:pass" (Basic)
  });

  toOffscreen({ target: 'offscreen', type: 'volume', value: volume });
  broadcast();
  return null;
}

function stop() {
  if (port) { port.disconnect(); port = null; }
  stats.running = false;
  if (offscreenReady || pbQueue.length) toOffscreen({ target: 'offscreen', type: 'stop' });
  closeOffscreen();
  broadcast();
}

// ==== ДЕКОДИРОВАНИЕ: чанки потока -> пакеты Kaicong -> PCM -> плеер ====

function handleAudioChunk(bytes) {
  stats.chunks += 1;
  stats.bytes += bytes.length;
  stats.lastChunkAt = Date.now();

  if (!stream) stream = new KaicongCodec.KaicongStream();
  const decoded = stream.push(bytes);
  for (const pcm of decoded) {
    stats.packets += 1;
    stats.pcmSec = +(stats.packets * SEC_PER_PACKET).toFixed(3);
    sendPcm(pcm);
  }
  if (stream.packets === 1) {
    console.log('[codec] заголовок 1-го пакета (32 б):', stream.firstHeaderHex);
  }
  if (stats.chunks % 25 === 1) {
    console.log(`[audio] чанк #${stats.chunks}: ${bytes.length} байт, декодировано пакетов: ${stats.packets}`);
    broadcast();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'pb-ready')  { offscreenReady = true; flushPbQueue(); return false; }
  if (msg.type === 'pb-stats')  {
    stats.bufferedSec = msg.bufferedSec; stats.underruns = msg.underruns;
    stats.dropped = msg.dropped;
    stats.audio = { state: msg.ctxState || 'none', gain: (msg.gain == null ? volume : msg.gain) };
    broadcast();
    return false;
  }
  if (msg.cmd === 'start') {
    start().then((err) => respond({ ok: !err, error: err, stats }));
    return true; // асинхронный ответ
  }
  if (msg.cmd === 'stop') { stop(); respond({ ok: true, stats }); return false; }
  if (msg.cmd === 'volume') {
    volume = Math.max(0, Math.min(1, Number(msg.value) || 0));
    chrome.storage.local.set({ volume });
    if (offscreenReady) toOffscreen({ target: 'offscreen', type: 'volume', value: volume });
    respond({ ok: true }); return false;
  }
  if (msg.cmd === 'status') { respond({ ok: true, stats }); return false; }
  return false;
});