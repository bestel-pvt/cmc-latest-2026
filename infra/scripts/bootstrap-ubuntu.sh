#!/usr/bin/env bash
# ---------------------------------------------------------------------
# One-time Ubuntu server bootstrap for DEMP.
# Run as a user with sudo. Idempotent — safe to re-run.
# Tested on Ubuntu 22.04 LTS and 24.04 LTS.
# ---------------------------------------------------------------------
set -euo pipefail

REPO_URL="${REPO_URL:-}"                              # optional: git clone URL if not already present
REPO_DIR="${REPO_DIR:-/opt/demp}"
NODE_MAJOR="${NODE_MAJOR:-22}"
PYTHON_VERSION="${PYTHON_VERSION:-3.11}"
SERVICE_USER="${SERVICE_USER:-demp}"

log() { printf '\033[1;32m[bootstrap]\033[0m %s\n' "$*"; }

log "updating apt cache"
sudo apt-get update -y

log "installing system dependencies"
sudo apt-get install -y \
  ca-certificates curl gnupg lsb-release git build-essential \
  ffmpeg tesseract-ocr tesseract-ocr-urd tesseract-ocr-hin tesseract-ocr-chi-sim tesseract-ocr-ara \
  python${PYTHON_VERSION} python${PYTHON_VERSION}-venv python3-pip \
  htop iotop nload

log "installing Docker Engine + Compose plugin"
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
fi

log "installing Node.js ${NODE_MAJOR} + pnpm"
if ! command -v node >/dev/null || [ "$(node -v | grep -oP '^v\K\d+')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v pnpm >/dev/null; then
  sudo npm install -g pnpm@9
fi

log "creating service user + data dirs"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
  sudo usermod -aG docker "$SERVICE_USER"
fi
sudo mkdir -p /data/demp/{postgres,redis,recordings,clips,tickers,collages,uploads,ollama,models} /opt/demp
sudo chown -R "$SERVICE_USER":"$SERVICE_USER" /data/demp /opt/demp

log "cloning repository (if not present)"
if [ ! -d "$REPO_DIR/.git" ]; then
  if [ -z "$REPO_URL" ]; then
    echo "  → repo not cloned; provide REPO_URL=... and re-run, or copy the tree to $REPO_DIR manually"
  else
    sudo -u "$SERVICE_USER" git clone "$REPO_URL" "$REPO_DIR"
  fi
fi

log "installing Python dependencies for AI workers"
sudo -u "$SERVICE_USER" bash -lc "
  cd $REPO_DIR
  for svc in transcription ticker-detect ticker-grouper; do
    python${PYTHON_VERSION} -m venv services/\$svc/.venv 2>/dev/null || true
    services/\$svc/.venv/bin/pip install -q --upgrade pip
    services/\$svc/.venv/bin/pip install -q -r services/\$svc/requirements.txt || true
  done
" || true

log "installing systemd units"
sudo cp $REPO_DIR/infra/systemd/*.service /etc/systemd/system/
sudo cp $REPO_DIR/infra/systemd/demp.target /etc/systemd/system/
sudo systemctl daemon-reload

log "bootstrap done. Next: copy .env into $REPO_DIR, then run infra/scripts/deploy.sh"
