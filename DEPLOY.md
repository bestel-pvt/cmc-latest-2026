# DEMP — Production Deploy Guide (Ubuntu)

End-to-end deploy pack for an Ubuntu 22.04 / 24.04 server. Everything runs
on-prem; the only piece that touches the public internet is an optional
**Cloudflare Tunnel** for HTTPS ingress (no port forwarding needed).

---

## 0. What runs where

| Component | Runs as | Port | Notes |
|---|---|---|---|
| Postgres, Redis, MediaMTX, Ollama, nginx | Docker (`docker-compose.prod.yml`) | see compose | MediaMTX uses `network_mode: host` for UDP multicast |
| API (Fastify), Web (Next.js) | **systemd** on the host | 4001 / 3001 | fronted by nginx :8080 |
| Recording, Failover controller, Janitor, AI Scheduler | systemd (Node) | — | spawn FFmpeg on host |
| Transcription, Ticker OCR, Ticker Grouper | systemd (Python venv per service) | — | need Tesseract + Python 3.11 |
| Cloudflare Tunnel | separate `cloudflared` systemd unit | — | terminates HTTPS + gives public URL |

All persistent state is under **`/data/demp/`** — mount that path on your storage array so it survives host reinstalls.

---

## 1. First-time bootstrap (once per server)

RustDesk into the server → open a terminal (or SSH from anywhere):

```bash
# 1. clone or copy the DEMP repo
sudo mkdir -p /opt/demp && sudo chown $USER /opt/demp
git clone <your-git-remote-of-DEMP> /opt/demp
# (or from RustDesk: drop the folder into /opt/demp)

cd /opt/demp

# 2. run the bootstrap script — installs Docker, Node 22, pnpm, Python 3.11,
#    Tesseract with urd/hin/chi_sim/ara language packs, FFmpeg, and the
#    systemd unit files. Idempotent — safe to re-run.
sudo -E bash infra/scripts/bootstrap-ubuntu.sh
```

**Prepare the environment file:**

```bash
cp .env.example .env
nano .env
```

At minimum change:
- `POSTGRES_PASSWORD` — set a strong one
- `JWT_SECRET` and `JWT_REFRESH_SECRET` — `openssl rand -hex 32` for each
- `MANIFEST_SIGNING_KEY` — `openssl rand -hex 32`
- `PUBLIC_STREAM_HOST` — the server's LAN IP so operators can pull `udp://@IP:PORT` with VLC
- `AIR_GAP_MODE=true` if this deployment has no outbound internet

---

## 2. Deploy (every subsequent update)

```bash
cd /opt/demp
sudo -u demp bash infra/scripts/deploy.sh
```

That single script:

1. `git pull` + `pnpm install`
2. Brings up Postgres / Redis / MediaMTX / Ollama / nginx via Docker Compose
3. Runs `prisma migrate deploy` + `generate`
4. Pulls the Ollama model if missing (Analysys GPT — Qwen 2.5 3B multilingual)
5. Builds `@demp/api` and `@demp/web`
6. Restarts every systemd unit

Watch it come up:

```bash
sudo journalctl -u demp-api -u demp-web -u demp-recording -f
sudo systemctl status demp.target
```

---

## 3. Ingesting the 200+ real UDP feeds

Once the stack is up, log in as `admin@demp.local` / (your seeded password),
open **Channels → New Channel** for each network. Add sources with the exact
`udp://@ip:port` or `udp://ip:port` your uplink gives you. Set one as
**Primary**; the failover controller starts scoring them within 2 seconds.

**LAN consumers** (VLC, OBS, downstream OB vans, etc.) can attach to DEMP's
own published UDP output for any channel — the URL shown in the Channels
table (e.g. `udp://@10.0.0.5:5002`) is bound to the port stored in
`Channel.dempOutputPort` and doesn't change when the upstream source flips.

To hand a stakeholder a spreadsheet: **Channels → Export CSV** dumps every
channel + every input source + the DEMP UDP URL.

---

## 4. Cloudflare Tunnel (optional, for public HTTPS access)

Copy `infra/cloudflared/config.yml.example` → `/etc/cloudflared/config.yml`,
follow the numbered instructions inside. Once installed:

```bash
sudo systemctl enable --now cloudflared
```

You now have `https://demp.example.com` proxying to nginx :8080 with a real
TLS certificate and no exposed inbound port.

---

## 5. Demo scope — AI features

For the current hardware budget, recording, tickers, flashers, transcription
and alerts are wired to **ARY News + Dunya News** only. Failover and the
multiviewer work for **every** channel. Flip more channels on later:

```sql
UPDATE "Channel" SET "aiFeaturesEnabled" = true WHERE slug IN ('geo-news','ptv-news');
```

The next tick of each worker picks it up automatically.

---

## 6. Hardware sizing (5 channels doing everything, CPU-only)

| Component | Recommended |
|---|---|
| CPU | 16 cores comfortable · 24 cores if transcription runs continuous |
| RAM | 32 GB |
| Disk | 2 TB NVMe (hot 48 h + cold 30 d combined) |
| Network | 1 Gbps NIC |
| OS | Ubuntu 22.04 LTS or 24.04 LTS |

Adding more channels: budget ~2 CPU cores + ~500 GB disk per additional
channel with AI features on.

---

## 7. Backups

```bash
# nightly cron
sudo docker exec demp_postgres pg_dump -U demp -d demp | gzip > /data/demp/backups/db-$(date +%F).sql.gz
# recordings are already on /data/demp/recordings — snapshot that volume too
```

---

## 8. I can't SSH from the assistant sandbox

To be clear: the assistant that wrote this repo has no SSH-out capability
and RustDesk is a graphical remote-desktop, not a shell pipe. Everything
under `infra/` is designed so a human operator (you) copy-pastes the two
commands from §1 and §2 into a shell on the server, and that's the entire
deploy story. If you want the assistant to modify the server, you'd need
to relay commands manually.
