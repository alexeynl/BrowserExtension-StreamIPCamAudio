#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Native messaging host: камера (raw TCP, HTTP/0.9-ответ без заголовков) -> расширение.

Протокол: stdin/stdout, length-prefixed JSON (4 байта little-endian + JSON).
Расширение присылает {"host","port","path","auth"?}; хост стримит назад
{"audio": "<base64>"} и в конце {"eof": true} либо {"error": "..."}.
Если камера всё же прислала HTTP-заголовки, они уходят одним сообщением {"meta": "..."}.
"""
import base64
import json
import socket
import struct
import sys
import threading

CHUNK_SIZE = 65536

try:  # чтобы stderr не падал на консолях Windows (cp866/cp1251)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def send_msg(obj):
    try:
        data = json.dumps(obj, ensure_ascii=True).encode("ascii")
        sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
        sys.stdout.buffer.flush()
    except (BrokenPipeError, OSError, ValueError):
        pass  # браузер закрыл канал — выходим молча


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    payload = sys.stdin.buffer.read(n)
    if len(payload) < n:
        return None
    return json.loads(payload)


def pump(sock):
    """Читает поток камеры и пересылает его в расширение base64-чанками."""
    state = "probe"  # probe -> header|body -> body
    buf = b""
    try:
        while True:
            chunk = sock.recv(CHUNK_SIZE)
            if not chunk:
                break
            if state == "body":                # самый частый случай — сразу отдаём
                send_msg({"audio": base64.b64encode(chunk).decode()})
                continue
            buf += chunk
            if state == "probe":
                if len(buf) < 5:
                    continue
                if buf[:5].upper().startswith(b"HTTP/"):
                    state = "header"
                else:                          # HTTP/0.9: тело без заголовков
                    state = "body"
                    send_msg({"audio": base64.b64encode(buf).decode()})
                    buf = b""
            if state == "header":              # камера прислала валидные заголовки
                end = buf.find(b"\r\n\r\n")
                if end == -1:
                    continue
                send_msg({"meta": buf[:end].decode("latin-1", "replace")})
                state = "body"
                rest, buf = buf[end + 4:], b""
                if rest:
                    send_msg({"audio": base64.b64encode(rest).decode()})
    except OSError as e:
        send_msg({"error": f"Ошибка сокета: {e}"})
        return
    send_msg({"eof": True})


def main():
    req = read_msg()
    if not req:
        return
    host = str(req.get("host", "")).strip()
    path = str(req.get("path", "/")).strip()
    auth = req.get("auth") or None
    try:
        port = int(req.get("port", 80))
    except (TypeError, ValueError):
        send_msg({"error": "Некорректный порт"})
        return

    if not host or not path.startswith("/") or not 1 <= port <= 65535:
        send_msg({"error": "Некорректные параметры host/port/path"})
        return
    if any(c in path for c in " \r\n"):
        send_msg({"error": "Путь не должен содержать пробелов и переводов строк"})
        return

    try:
        sock = socket.create_connection((host, port), timeout=10)
        sock.settimeout(30)  # детект «мёртвого» потока
    except OSError as e:
        send_msg({"error": f"Не удалось подключиться к {host}:{port}: {e}"})
        return

    request = f"GET {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n"
    if auth:
        token = base64.b64encode(str(auth).encode("utf-8")).decode("ascii")
        request += f"Authorization: Basic {token}\r\n"
    request += "User-Agent: camera-audio-native-host/1.0\r\n\r\n"

    try:
        sock.sendall(request.encode("latin-1"))
    except OSError as e:
        send_msg({"error": f"Не удалось отправить запрос: {e}"})
        return

    threading.Thread(target=pump, args=(sock,), daemon=True).start()
    while read_msg() is not None:   # живём, пока расширение держит порт
        pass
    sock.close()


if __name__ == "__main__":
    main()
