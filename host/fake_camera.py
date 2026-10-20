#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Фейковая камера для отладки расширения.

Режимы:
  1) Сырой поток БЕЗ HTTP-заголовков (имитация HTTP/0.9):
       python3 fake_camera.py [port]

  2) Режим Kaicong: HTTP-заголовки + пакеты 544 байта
     ([32 байта заголовка пакета][512 байт IMA ADPCM], 8 кГц):
       python3 fake_camera.py [port] --kaicong [--packets N] [--freq 440]

     Энкодер IMA ADPCM — чистый Python, без audioop (работает на Python 3.13+).
     Энкодер и декодер побитово совпадают с audioop.lin2adpcm/adpcm2lin (width=2).

После запуска: python3 test_host.py 127.0.0.1 <port> /audiostream.cgi
"""
import argparse
import socket
import struct
import sys
import threading
import time

STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
    5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]
INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]

Kaicong_PACKET_SZ = 544
Kaicong_HEADER_SZ = 32
Kaicong_PAYLOAD_SZ = Kaicong_PACKET_SZ - Kaicong_HEADER_SZ  # 512 байт ADPCM
Kaicong_RATE = 8000
Kaicong_SAMPLES_PER_PACKET = Kaicong_PAYLOAD_SZ * 2          # 1024 сэмпла PCM16


def pcm16le_to_adpcm(samples):
    """bytes PCM16LE -> bytes IMA ADPCM.
    Первый код кладётся в СТАРШИЙ ниббл — побитовый аналог audioop.lin2adpcm(data, 2, None)."""
    pred, idx = 0, 0
    out = bytearray()
    lo = None  # ждём пары: первый код -> старший ниббл
    for (s,) in struct.iter_unpack("<h", samples):
        step = STEP_TABLE[idx]
        diff = s - pred
        # Жадный квантователь с вычитанием — 1-в-1 с adpcm_coder из audioop.c
        code = 0
        if diff < 0:
            code, diff = 8, -diff
        if diff >= step:
            code |= 4
            diff -= step
        if diff >= (step >> 1):
            code |= 2
            diff -= step >> 1
        if diff >= (step >> 2):
            code |= 1
        # реконструкция предиктора — формула декодера (как в audioop.c)
        vpdiff = step >> 3
        if code & 4:
            vpdiff += step
        if code & 2:
            vpdiff += step >> 1
        if code & 1:
            vpdiff += step >> 2
        pred += -vpdiff if code & 8 else vpdiff
        pred = max(-32768, min(32767, pred))
        idx = max(0, min(88, idx + INDEX_TABLE[code]))
        if lo is None:
            lo = code
        else:
            out.append(((lo & 0x0F) << 4) | (code & 0x0F))  # audioop: первый код — старший
            lo = None
    if lo is not None:  # нечётное число сэмплов — дополняем нулевым кодом
        out.append((lo & 0x0F) << 4)
    return bytes(out)


def adpcm_to_pcm16le(adpcm):
    """bytes IMA ADPCM -> bytes PCM16LE.
    Первый код — из старшего ниббла: побитовый аналог audioop.adpcm2lin(data, 2, None)."""
    pred, idx = 0, 0
    out = bytearray()
    for b in adpcm:
        for nibble in (b >> 4, b & 0x0F):  # audioop: старший ниббл первым
            step = STEP_TABLE[idx]
            diff = step >> 3
            if nibble & 1:
                diff += step >> 2
            if nibble & 2:
                diff += step >> 1
            if nibble & 4:
                diff += step
            if nibble & 8:
                diff = -diff
            pred += diff
            pred = max(-32768, min(32767, pred))
            idx = max(0, min(88, idx + INDEX_TABLE[nibble]))
            out += struct.pack("<h", pred)
    return bytes(out)


def sine_pcm(freq, n_samples, rate=Kaicong_RATE, amp=12000):
    import math
    pcm = bytearray()
    for i in range(n_samples):
        v = int(amp * math.sin(2 * math.pi * freq * i / rate))
        pcm += struct.pack("<h", v)
    return bytes(pcm)


def make_kaicong_packet(payload_adpcm, seq):
    """544-байтный пакет: 32-байтовый заголовок + 512 байт ADPCM."""
    header = struct.pack("<4sIIIII8s",
                         b"KCFG", seq, len(payload_adpcm), 0x0100,
                         Kaicong_RATE, Kaicong_SAMPLES_PER_PACKET,
                         b"\x00" * 8)
    assert len(header) == Kaicong_HEADER_SZ, len(header)
    return header + payload_adpcm


def build_kaicong_body(freq=440, packets=0):
    """Тело потока: HTTP-заголовки + N пакетов Kaicong (0 = бесконечный генератор)."""
    http_headers = (b"HTTP/1.0 200 OK\r\n"
                    b"Content-Type: audio/basic\r\n"
                    b"Cache-Control: no-store\r\n"
                    b"\r\n")
    def gen():
        seq = 0
        while packets == 0 or seq < packets:
            phase = (seq * Kaicong_SAMPLES_PER_PACKET) % Kaicong_RATE
            need = Kaicong_SAMPLES_PER_PACKET
            pcm = bytearray()
            while need:
                take = min(need, Kaicong_RATE - phase)
                pcm += sine_pcm(freq, take)
                phase = 0
                need -= take
            yield make_kaicong_packet(pcm16le_to_adpcm(bytes(pcm)), seq)
            seq += 1
    return http_headers, gen


def handle(conn, kaicong=False, packets=0, freq=440):
    try:
        conn.recv(4096)  # прочитать GET-запрос (не парсим его)
        if not kaicong:
            payload = b"\xff\xfb\x90\x00" * 512   # похоже на MP3-фрейм
            while True:
                try:
                    conn.sendall(payload)
                except OSError:
                    break
                time.sleep(0.05)                  # ~ 40 КБ/с
        else:
            headers, gen = build_kaicong_body(freq=freq, packets=packets)
            conn.sendall(headers)
            for i, packet in enumerate(gen()):
                try:
                    conn.sendall(packet)
                except OSError:
                    break
                time.sleep(Kaicong_SAMPLES_PER_PACKET / Kaicong_RATE)  # реальное время
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=8099)
    ap.add_argument("--kaicong", action="store_true",
                    help="режим Kaicong: HTTP-заголовки + ADPCM-пакеты 544/32")
    ap.add_argument("--packets", type=int, default=0,
                    help="число пакетов (0 = бесконечно)")
    ap.add_argument("--freq", type=float, default=440.0, help="частота тестового синуса, Гц")
    args = ap.parse_args()

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", args.port))
    srv.listen(5)
    mode = f"Kaicong ADPCM 544/32 ({args.freq} Гц, пакетов: {'∞' if args.packets == 0 else args.packets})" \
        if args.kaicong else "сырой поток без заголовков"
    print(f"Фейковая камера на 127.0.0.1:{args.port} — {mode}")
    try:
        while True:
            conn, _ = srv.accept()
            threading.Thread(target=handle,
                             args=(conn, args.kaicong, args.packets, args.freq),
                             daemon=True).start()
    except KeyboardInterrupt:
        print("\nОстановлено.")


if __name__ == "__main__":
    main()
