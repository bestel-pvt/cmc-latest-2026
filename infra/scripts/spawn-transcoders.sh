#!/usr/bin/env bash
# demp-transcoders supervisor — the proven Analysys pattern.
#
# For each active channel we spawn ONE long-lived ffmpeg that reads the
# raw UDP multicast DIRECTLY (bypassing mediamtx as a middle hop) and
# publishes it into mediamtx as the browser-friendly <slug>-hls path.
#
# The critical optimisation: for H264 sources we just copy the video
# stream (`-c:v copy`, ~0 CPU). Only sources that aren't H264 — MPEG-2,
# H265, "force" overrides — go through libx264. That is why the same box
# ran ~100 channels stably in the previous system: only a handful of
# transcoders, not all 100+.
#
# Codec lookup is a JSON file (data/codecs.json) — the exact table
# Analysys tuned per source. Unknown slugs default to h264 copy.
set -uo pipefail
: "${DATABASE_URL:?DATABASE_URL required}"
: "${MEDIAMTX_RTSP_URL:=rtsp://127.0.0.1:8554}"
: "${DEMP_CODECS_FILE:=/opt/demp/data/codecs.json}"
: "${DEMP_ABITRATE:=128k}"

PSQL_URL="${DATABASE_URL%%\?*}"

# Fetch (slug, primary UDP URL) for every active channel with a source.
# Prefer primary; fall back to the first available source.
rows=$(psql "$PSQL_URL" -At -F '|' -c "
  SELECT c.slug,
         (SELECT s.url FROM \"Source\" s
          WHERE s.\"channelId\" = c.id
          ORDER BY s.\"isPrimary\" DESC, s.priority DESC
          LIMIT 1)
    FROM \"Channel\" c
   WHERE c.active = true
     AND EXISTS (SELECT 1 FROM \"Source\" s WHERE s.\"channelId\" = c.id)
   ORDER BY c.slug
")

if [ -z "$rows" ]; then
  echo "no channels to transcode — exiting"
  exit 0
fi

count=$(echo "$rows" | wc -l)
echo "spawning $count transcoder workers (staggered over 45 s)"

# Read codec table once.
declare -A CODEC
if [ -f "$DEMP_CODECS_FILE" ]; then
  while IFS='=' read -r k v; do CODEC["$k"]="$v"; done < <(
    python3 -c "
import json
for k, v in json.load(open('$DEMP_CODECS_FILE')).items():
    print(f'{k}={v}')
"
  )
fi

idx=0
pids=()
while IFS='|' read -r slug udp; do
  [ -n "$slug" ] || continue
  [ -n "$udp" ] || { echo "  skip $slug — no source URL"; idx=$((idx+1)); continue; }

  # Normalise mediamtx-style URL back to ffmpeg-listening syntax.
  #   udp://224.2.2.2:2020  →  udp://@224.2.2.2:2020
  # (Delimiter is # so | inside the (udp|rtp) alternation isn't confused
  # for the s command separator.)
  input=$(echo "$udp" | sed -E 's#^(udp|rtp)://([^@])#\1://@\2#')
  # fifo_size is in 188-byte TS packets. 100000 ≈ 19 MB per worker.
  input="${input}?fifo_size=100000&overrun_nonfatal=1&timeout=6000000"

  # Codec-aware branch. Default = h264 copy (0 CPU), the safe majority case.
  vcodec_note=""
  vcodec="${CODEC[$slug]:-h264}"
  case "$vcodec" in
    h264*)
      VOPT=(-c:v copy)
      vcodec_note="COPY"
      ;;
    *)
      # Non-H264 or forced: proven Analysys params.
      VOPT=(-threads 2 -filter_threads 1
            -c:v libx264 -preset veryfast -tune zerolatency
            -maxrate 2500k -bufsize 5000k -g 50 -sc_threshold 0
            -pix_fmt yuv420p)
      vcodec_note="TRANSCODE ($vcodec)"
      ;;
  esac

  stagger=$(( idx * 45 / count ))
  echo "  [$idx] $slug → $vcodec_note (stagger ${stagger}s)"
  (
    sleep "$stagger"
    while true; do
      ffmpeg -hide_banner -loglevel warning -nostdin \
        -fflags +genpts+discardcorrupt -f mpegts -i "$input" \
        -map 0:v:0 -map 0:a:0 \
        "${VOPT[@]}" -c:a aac -b:a "$DEMP_ABITRATE" -ac 2 -ar 48000 \
        -rtsp_transport tcp -f rtsp "$MEDIAMTX_RTSP_URL/${slug}-hls"
      # brief backoff so a broken source doesn't hot-loop
      sleep 3
    done
  ) &
  pids+=($!)
  idx=$((idx + 1))
done <<<"$rows"

trap 'echo "stopping ${#pids[@]} transcoders"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; wait; exit 0' TERM INT

wait
