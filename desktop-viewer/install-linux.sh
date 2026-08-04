#!/usr/bin/env bash
# One-command DEMP Viewer install for Linux.
# Usage:   sudo ./install-linux.sh
#      or: curl -sL http://<demp-host>/api/downloads/desktop-viewer/install-linux.sh | sudo bash
set -euo pipefail

BIN_NAME=demp-viewer
BIN_URL="${DEMP_BIN_URL:-http://100.105.45.112:4001/api/downloads/desktop-viewer/DEMP-Viewer-linux}"
ICON_URL="${DEMP_ICON_URL:-http://100.105.45.112:4001/api/downloads/desktop-viewer/demp.png}"

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run as root (sudo ./install-linux.sh)"; exit 1
fi

echo "==> installing system dependencies"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y --no-install-recommends vlc python3-tk libvlc-dev
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y vlc python3-tkinter
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm vlc tk
else
  echo "warning: no known package manager; install 'vlc' and 'python3-tk' manually"
fi

echo "==> downloading DEMP Viewer binary"
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar -o /usr/local/bin/"$BIN_NAME" "$BIN_URL"
else
  wget -O /usr/local/bin/"$BIN_NAME" "$BIN_URL"
fi
chmod +x /usr/local/bin/"$BIN_NAME"

mkdir -p /usr/local/share/icons /usr/local/share/applications
curl -sfL -o /usr/local/share/icons/demp-viewer.png "$ICON_URL" 2>/dev/null || true

cat > /usr/local/share/applications/demp-viewer.desktop <<DESK
[Desktop Entry]
Type=Application
Name=DEMP Viewer
Comment=DEMP Video Wall (Directorate of Electronic Media & Publications)
Exec=/usr/local/bin/${BIN_NAME}
Icon=/usr/local/share/icons/demp-viewer.png
Terminal=false
Categories=AudioVideo;Video;Player;
StartupNotify=true
DESK

echo ""
echo "✓ Installed."
echo "  Launch from Applications menu, or run:  demp-viewer"
