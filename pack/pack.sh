#!/usr/bin/env bash
# Сборка zip расширения + (опционально) ключ для стабильного ID.
set -euo pipefail
cd "$(dirname "$0")"

python3 pack.py "${1:-}"

if command -v openssl >/dev/null 2>&1; then
  if [ ! -f key.pem ]; then
    openssl genrsa -out key.pem 2048 2>/dev/null
    echo "Сгенерирован pack/key.pem (для стабильного ID и CRX)"
  fi
  ID=$(openssl rsa -in key.pem -pubout -outform DER 2>/dev/null \
       | openssl dgst -sha256 -binary | head -c 16 \
       | od -An -tx1 | tr -d ' \n' | cut -c1-32 | tr '0-9a-f' 'a-p')
  echo "Extension ID из key.pem: $ID"
  echo "Собрать CRX: chrome --pack-extension=../extension --pack-extension-key=$(pwd)/key.pem"
else
  echo "openssl не найден — key.pem не создан (для Web Store он не обязателен)"
fi
