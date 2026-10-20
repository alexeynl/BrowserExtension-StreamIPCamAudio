#!/usr/bin/env bash
set -euo pipefail
HOST_NAME="com.camera.audio"
for DIR in "$HOME/.config/google-chrome/NativeMessagingHosts" \
           "$HOME/.config/chromium/NativeMessagingHosts" \
           "$HOME/.config/microsoft-edge/NativeMessagingHosts"; do
  rm -f "$DIR/$HOST_NAME.json"
done
rm -rf "${HOME}/.local/share/camera-audio-host"
echo "Native host удалён."
