#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Проверка native-хоста без браузера.

Использование:
  python3 test_host.py <ip> <port> <path> [user:pass]

Шлёт конфиг в camera_audio_host.py через length-prefixed JSON
и печатает статистику приходящих чанков. Ctrl+C — остановка.
"""
import json
import os
import struct
import subprocess
import sys
import time

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "camera_audio_host.py")

def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    cfg = {"host": sys.argv[1], "port": int(sys.argv[2]), "path": sys.argv[3]}
    if len(sys.argv) > 4:
        cfg["auth"] = sys.argv[4]

    proc = subprocess.Popen([sys.executable, HOST], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    msg = json.dumps(cfg).encode("ascii")
    proc.stdin.write(struct.pack("<I", len(msg)) + msg)
    proc.stdin.flush()

    chunks = total = 0
    start = time.time()
    try:
        while True:
            raw = proc.stdout.read(4)
            if len(raw) < 4:
                break
            (n,) = struct.unpack("<I", raw)
            obj = json.loads(proc.stdout.read(n))
            if "audio" in obj:
                chunks += 1
                total += len(obj["audio"]) * 3 // 4
                if chunks % 50 == 1:
                    rate = total / max(time.time() - start, 1e-6) / 1024
                    print(f"чанк #{chunks}: всего {total} байт ({rate:.1f} КБ/с)")
            elif "error" in obj:
                print("ОШИБКА:", obj["error"]); break
            elif "eof" in obj:
                print("Поток завершён (eof)."); break
    except KeyboardInterrupt:
        print("Прервано пользователем.")
    finally:
        proc.kill()
    print(f"Итого: чанков {chunks}, байт {total}.")

if __name__ == "__main__":
    main()
