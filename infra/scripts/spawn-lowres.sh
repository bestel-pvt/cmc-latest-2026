#!/usr/bin/env bash
# demp-lowres — per-channel low-resolution mezzanine.
#
# Publishes each channel to mediamtx as <slug>-lo at 640x360 @ ~400 kbps.
# The desktop viewer automatically prefers -lo when the wall is 4x4 or
# larger, so a laptop can play 16+ tiles smoothly instead of drowning in
# 16× 720p/1080p streams.
#
# One libx264 per channel, preset veryfast, threads=1 → ~5 % of one core
# each. 111 channels ≈ 6 cores on the 80-core box.

set -uo pipefail
: "${DATABASE_URL:?DATABASE_URL required}"
: "${MEDIAMTX_RTSP_URL:=rtsp://127.0.0.1:8554}"

PSQL_URL="${DATABASE_URL%%\?*}"

rows=$(psql "$PSQL_URL" -At -F '|' -c "
  SELECT c.slug,
         (SELECT s.url  FROM \"Source\" s WHERE s.\"channelId\" = c.id
          ORDER BY s.\"isPrimary\" DESC, s.priority DESC LIMIT 1),
         (SELECT s.kind FROM \"Source\" s WHERE s.\"channelId\" = c.id
          ORDER BY s.\"isPrimary\" DESC, s.priority DESC LIMIT 1)
    FROM \"Channel\" c
   WHERE c.active = true
     AND EXISTS (SELECT 1 FROM \"Source\" s WHERE s.\"channelId\" = c.id)
   ORDER BY c.slug
")

if [ -z "$rows" ]; then
  echo "no channels — exiting"
  exit 0
fi

count=$(echo "$rows" | wc -l)
echo "spawning $count low-res transcoders (640x360 @ 400k → <slug>-lo)"

pids=()
idx=0
while IFS='|' read -r slug src_url src_kind; do
  [ -n "$slug" ] || continue
  [ -n "$src_url" ] || { idx=$((idx+1)); continue; }

  input="$src_url"
  case "$src_kind" in
    UDP|RTP)
      if [[ "$input" != *"://@"* ]]; then
        input=$(echo "$input" | sed -E 's#^(udp|rtp)://([^@])#\1://@\2#')
      fi
      input="${input}?fifo_size=100000&overrun_nonfatal=1&timeout=6000000"
      input_args=(-f mpegts -i "$input")
      ;;
    *)
      input_args=(-i "$input")
      ;;
  esac

  stagger=$(( idx * 45 / count ))
  (
    sleep "$stagger"
    while true; do
      ffmpeg -hide_banner -nostdin -loglevel warning \
        -analyzeduration 5M -probesize 5M -err_detect ignore_err \
        -fflags +discardcorrupt+igndts+genpts \
        "${input_args[@]}" \
        -map 0:v:0 -map 0:a:0? \
        -vf "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2" \
        -c:v libx264 -preset veryfast -tune zerolatency -profile:v baseline -pix_fmt yuv420p \
        -threads 1 -x264opts threads=1:sliced-threads=0 \
        -b:v 400k -maxrate 500k -bufsize 800k -g 50 \
        -c:a aac -b:a 64k -ac 2 -ar 48000 \
        -avoid_negative_ts make_zero \
        -rtsp_transport tcp -f rtsp "$MEDIAMTX_RTSP_URL/${slug}-lo"
      sleep 3
    done
  ) &
  pids+=($!)
  idx=$((idx + 1))
done <<<"$rows"

trap 'echo "stopping ${#pids[@]} lowres workers"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; wait; exit 0' TERM INT
wait
