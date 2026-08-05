#!/usr/bin/env bash
# ---------------------------------------------------------------------
# DEMP one-shot deploy — run on the Ubuntu server after bootstrap.
# Pulls latest git, installs deps, migrates DB, restarts services.
# ---------------------------------------------------------------------
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/demp}"
BRANCH="${BRANCH:-main}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:3b-instruct}"

cd "$REPO_DIR"
log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }

log "git pull ($BRANCH)"
git fetch --all --tags
git reset --hard "origin/$BRANCH"

log "pnpm install"
pnpm install --frozen-lockfile

log "docker compose up -d (infra)"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d postgres redis ollama nginx

log "waiting for postgres to be healthy"
for i in $(seq 1 30); do
  if docker exec demp_postgres pg_isready -U demp -d demp >/dev/null 2>&1; then break; fi
  sleep 1
done

log "prisma migrate deploy + generate"
pnpm --filter @demp/db exec prisma migrate deploy
pnpm --filter @demp/db exec prisma generate

log "ensuring Ollama model is present ($OLLAMA_MODEL)"
if ! docker exec demp_ollama ollama list | grep -q "$OLLAMA_MODEL"; then
  docker exec demp_ollama ollama pull "$OLLAMA_MODEL"
fi

log "building web + api"
pnpm --filter @demp/api build
pnpm --filter @demp/web build

log "restarting systemd units"
sudo systemctl restart \
  demp-api.service demp-web.service demp-recording.service demp-janitor.service \
  demp-failover-controller.service demp-ai-scheduler.service demp-ticker-detect.service \
  demp-ticker-grouper.service demp-transcription.service

log "status:"
sudo systemctl status --no-pager demp.target || true

log "done — the DEMP stack is up. Public entry: :8080 (front by Cloudflare Tunnel)."
