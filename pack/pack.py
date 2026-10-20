#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собирает zip расширения для Chrome Web Store (manifest в корне архива).

Использование: python3 pack.py [выход.zip]
"""
import os
import sys
import zipfile

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.normpath(os.path.join(here, "..", "extension"))
    out = (sys.argv[1] if len(sys.argv) > 1 and sys.argv[1]
           else os.path.join(here, "camera-audio-extension.zip"))
    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(src):
            for name in files:
                full = os.path.join(root, name)
                z.write(full, os.path.relpath(full, src))
    print("OK:", out)

if __name__ == "__main__":
    main()
