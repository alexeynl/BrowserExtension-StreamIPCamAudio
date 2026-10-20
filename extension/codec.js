/* codec.js — фреймер потока Kaicong + декодер IMA ADPCM -> PCM16.
 *
 * Формат потока камеры (см. Python-класс KaicongAudio):
 *   тело HTTP-ответа = последовательность пакетов по 544 байта:
 *     [32 байта служебного заголовка][512 байт IMA ADPCM]
 *   512 байт ADPCM = 1024 сэмпла PCM16LE, моно, 8000 Гц (128 мс на пакет).
 *
 * Состояние ADPCM (предиктор + индекс шага) СБРАСЫВАЕТСЯ на каждом пакете —
 * ровно как в Python-коде, где state=None создаётся заново в handle().
 *
 * Декодер побитово эквивалентен audioop.adpcm2lin(data, 2, None) из CPython
 * (сверено с Modules/audioop.c: каноническая IMA-таблица шагов, первый код —
 * в СТАРШЕМ ниббле байта). Если на вашей камере звук искажён — попробуйте
 * swapNibbles=true (стандартный IMA WAV кладёт первым младший ниббл).
 *
 * Работает в service worker (self.KaicongCodec), на странице и в node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KaicongCodec = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PACKET_SZ = 544;          // байт в пакете потока
  const HEADER_SZ = 32;           // служебный заголовок пакета (пропускаем)
  const PAYLOAD_SZ = PACKET_SZ - HEADER_SZ;   // 512 байт ADPCM
  const RATE_HZ = 8000;           // частота декодированного PCM
  const NCHANNELS = 1;
  const SAMPLES_PER_PACKET = PAYLOAD_SZ * 2;  // 1024 сэмпла (по 2 ниббла на байт)

  // Каноническая IMA-таблица шагов — 1-в-1 из CPython Modules/audioop.c
  const STEP_TABLE = new Int32Array([
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
    5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
  ]);
  const INDEX_TABLE = new Int32Array([-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]);

  /* IMA ADPCM -> Int16Array PCM. Эквивалент audioop.adpcm2lin(adpcm, 2, None).
   * Первый код берётся из СТАРШЕГО ниббла (как в audioop);
   * swapNibbles=true — из младшего (стандартный IMA WAV). */
  function adpcmToPcm16(adpcm, swapNibbles) {
    const out = new Int16Array(adpcm.length * 2);
    let predictor = 0, index = 0, o = 0;
    for (let i = 0; i < adpcm.length; i++) {
      const b = adpcm[i];
      for (let half = 0; half < 2; half++) {
        const first = half === 0;                       // audioop: первый код — старший ниббл
        const hi = swapNibbles ? !first : first;
        const nibble = hi ? (b >> 4) : (b & 0x0f);
        const step = STEP_TABLE[index];
        let diff = step >> 3;
        if (nibble & 1) diff += step >> 2;
        if (nibble & 2) diff += step >> 1;
        if (nibble & 4) diff += step;
        if (nibble & 8) diff = -diff;
        predictor += diff;
        if (predictor > 32767) predictor = 32767;
        else if (predictor < -32768) predictor = -32768;
        index += INDEX_TABLE[nibble];
        if (index < 0) index = 0; else if (index > 88) index = 88;
        out[o++] = predictor;
      }
    }
    return out;
  }

  function toHex(bytes, n) {
    let s = '';
    const m = Math.min(bytes.length, n === undefined ? bytes.length : n);
    for (let i = 0; i < m; i++) s += bytes[i].toString(16).padStart(2, '0') + ' ';
    return s.trim();
  }

  /* Накапливает байты потока и нарезает их на целые пакеты Kaicong.
   * push(Uint8Array) -> массив Int16Array (декодированные пакеты). */
  class KaicongStream {
    constructor(options) {
      options = options || {};
      this.swapNibbles = !!options.swapNibbles;
      this.buf = new Uint8Array(0);
      this.packets = 0;          // всего декодировано пакетов
      this.firstHeaderHex = null; // первые байты заголовка 1-го пакета (диагностика)
      this.firstHeader = null;
    }

    push(bytes) {
      if (!bytes || !bytes.length) return [];
      if (this.buf.length) {
        const merged = new Uint8Array(this.buf.length + bytes.length);
        merged.set(this.buf, 0);
        merged.set(bytes, this.buf.length);
        this.buf = merged;
      } else {
        this.buf = new Uint8Array(bytes);
      }
      const out = [];
      let pos = 0;
      while (this.buf.length - pos >= PACKET_SZ) {
        const packet = this.buf.subarray(pos, pos + PACKET_SZ);
        if (!this.firstHeader) {
          this.firstHeader = packet.subarray(0, HEADER_SZ);
          this.firstHeaderHex = toHex(this.firstHeader);
        }
        out.push(adpcmToPcm16(packet.subarray(HEADER_SZ), this.swapNibbles));
        this.packets++;
        pos += PACKET_SZ;
      }
      if (pos) this.buf = this.buf.subarray(pos);
      return out;
    }
  }

  return {
    PACKET_SZ, HEADER_SZ, PAYLOAD_SZ, RATE_HZ, NCHANNELS, SAMPLES_PER_PACKET,
    STEP_TABLE, INDEX_TABLE,
    adpcmToPcm16, KaicongStream, toHex
  };
});
