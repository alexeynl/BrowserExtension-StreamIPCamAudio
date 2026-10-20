#!/usr/bin/env bash
# Использование: ./install-linux.sh <ID_расширения>   (ID из chrome://extensions)
set -euo pipefail

HOST_NAME="com.camera.audio"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.local/share/camera-audio-host"

ID="${1:?Укажите ID расширения: ./install-linux.sh <id>  (см. chrome://extensions)}"
[[ "$ID" =~ ^[a-p]{32}$ ]] || { echo "Ошибка: ID должен быть 32 символа из a-p"; exit 1; }

mkdir -p "$INSTALL_DIR"
install -m 0755 "$SCRIPT_DIR/camera_audio_host.py" "$INSTALL_DIR/"

python3 - "$ID" "$INSTALL_DIR" <<'PY'
import json, sys
ext_id, install_dir = sys.argv[1], sys.argv[2]
manifest = {
    "name": "com.camera.audio",
    "description": "Native messaging host: audio stream of IP camera",
    "path": f"{install_dir}/camera_audio_host.py",
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{ext_id}/"],
}
with open(f"{install_dir}/com.camera.audio.json", "w") as f:
    json.dump(manifest, f, indent=2)
PY

for DIR in "$HOME/.config/google-chrome/NativeMessagingHosts" \
           "$HOME/.config/chromium/NativeMessagingHosts" \
           "$HOME/.config/microsoft-edge/NativeMessagingHosts"; do
  mkdir -p "$DIR"
  ln -sf "$INSTALL_DIR/com.camera.audio.json" "$DIR/$HOST_NAME.json"
  echo "  зарегистрировано: $DIR"
done
echo "Готово. Native host установлен в $INSTALL_DIR"
