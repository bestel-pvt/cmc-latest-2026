# DEMP — AI-Powered Broadcast Monitoring & Media Intelligence

Production-grade platform to ingest 200+ live TV channels (UDP MPEG-TS), monitor each with multi-source failover, record 24×7 on a 30-day rolling window, transcribe live in EN/UR/AR, crop tickers with AI, and repurpose content via an NLE-style clip editor.

Powered by **Analysys** — [analysys.tech](https://analysys.tech)

---

## Repo layout

```
apps/
  web/                      Next.js 14 frontend
  api/                      Fastify API + WebSocket
services/
  failover-controller/      Node — per-channel health scoring + hitless-ish switching
  recording/                Node — FFmpeg segmenter + SHA-256 evidentiary chain
  janitor/                  Node cron — 30-day retention (respects legal holds)
  transcription/            Python — faster-whisper pool
  ticker-detect/            Python — OpenCV region detector
packages/
  db/                       Prisma schema + client (shared)
  shared/                   Zod, TS types, brand tokens, constants
infra/
  mediamtx/                 MediaMTX config
  nginx/                    Path-router for MediaMTX shards
```

## Prerequisites

- Node.js **≥ 20** (v24 tested)
- pnpm **9** (`npm i -g pnpm@9`)
- Docker Desktop (Windows/Mac) or Docker Engine (Linux)
- **FFmpeg** on `PATH` (Windows: `winget install Gyan.FFmpeg`)
- Python **3.10+** with `pip` (for AI workers, later)

## Bootstrap (local dev)

```bash
cp .env.example .env
pnpm install
pnpm docker:up            # postgres, redis, mediamtx, nginx
pnpm db:generate
pnpm db:migrate           # first time — creates schema
pnpm db:seed              # admin@demp.local / demp-admin-2026 + 8 sample channels
pnpm dev                  # runs web + api + all Node services
```

Then open:

- Web:      http://localhost:3001
- API:      http://localhost:4001
- MediaMTX API: http://localhost:9997
- HLS:      http://localhost:8888
- Nginx:    http://localhost:8080

## Server deployment (roadmap)

Deploy is a separate session. High-level:

1. Provision Linux server (Ubuntu 22.04+). Sizing table below.
2. `git pull`, copy `.env`, `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`.
3. Load real UDP source URLs in the Channels admin page.
4. Point NTP/PTP; verify time authority (evidentiary timestamps).

### Hardware sizing (indicative, for target channel count)

| Channels | CPU cores | RAM   | GPUs (Whisper large-v3) | Hot storage (NVMe, 48h) | Cold storage (HDD, 30d) |
|---------:|----------:|-------|-------------------------|-------------------------|-------------------------|
| 50       | 32        | 128GB | 1–2                     | 5 TB                    | 60 TB                   |
| 100      | 64        | 256GB | 3–5                     | 10 TB                   | 130 TB                  |
| 200      | 128       | 512GB | 8–12                    | 20 TB                   | 260 TB                  |

Assumes ~2 Mbps average per channel. News-HD adds ~50%. Multi-resolution recording adds another 50–100%. Add 30–40% headroom.

## Compliance notes (defense/govt profile)

- **Chain of custody** — every recording segment has a SHA-256 written alongside it; hourly manifests are ed25519-signed.
- **Legal hold** — per-channel windows that override the 30-day janitor.
- **Audit log** — every mutating API call is written to an append-only `AuditLog` table.
- **Export watermark** — clip exports burn in `<user-id> · <timestamp>` via FFmpeg `drawtext`.
- **Air-gap mode** — a setting that disables all outbound network (fonts self-hosted, Whisper models pre-downloaded).

## Realistic scope note

Even the foundation is a multi-week build. The current codebase covers **Phase 1** — foundation + core paths (ingest → play → record → clip, plus transcription for a limited channel count). Phase 2+ items (multi-shard MediaMTX, face/logo/scene detection, SAML/OIDC + MFA, storage tiering, public REST + webhooks) are called out in the [plan file](../.claude/plans/breezy-strolling-sky.md).
