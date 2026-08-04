#!/usr/bin/env bash
# demp-rebroadcast supervisor.
#
# For each active channel with a dempOutputPort configured, spawns one
# long-lived ffmpeg that reads the SOURCE UDP multicast directly and
# re-broadcasts it to the DEMP multicast group. Straight stream-copy —
# all PIDs, program number, and audio tracks preserved.
#
# Why not via mediamtx runOnReady?
#   mediamtx demux/remux drops non-H264/AAC tracks (Dunya's MP2 audio
#   disappears) and rewrites the program number and PIDs. The resulting
#   MPEG-TS confuses many decoders (VLC in particular refuses to play
#   an audioless PMT for a program that declared audio). Directly
#   passthrough-copying the source stream keeps the container byte-
#   identical, so every downstream consumer plays it exactly like the
#   satellite feed.

set -uo pipefail
: "${DATABASE_URL:?DATABASE_URL required}"
: "${PUBLIC_STREAM_HOST:=239.7.0.0}"    # placeholder; per-channel multicast computed

PSQL_URL="${DATABASE_URL%%\?*}"

rows=$(psql "$PSQL_URL" -At -F '|' -c "
  SELECT c.slug, c.\"dempOutputPort\",
         (SELECT s.url  FROM \"Source\" s WHERE s.\"channelId\" = c.id
          ORDER BY s.\"isPrimary\" DESC, s.priority DESC LIMIT 1),
         (SELECT s.kind FROM \"Source\" s WHERE s.\"channelId\" = c.id
          ORDER BY s.\"isPrimary\" DESC, s.priority DESC LIMIT 1)
    FROM \"Channel\" c
   WHERE c.active = true
     AND c.\"dempOutputPort\" IS NOT NULL
     AND EXISTS (SELECT 1 FROM \"Source\" s WHERE s.\"channelId\" = c.id)
   ORDER BY c.slug
")

if [ -z "$rows" ]; then
  echo "no channels to re-broadcast — exiting"
  exit 0
fi

count=$(echo "$rows" | wc -l)
echo "spawning $count UDP re-broadcast workers (source → multicast passthrough)"

pids=()
idx=0
while IFS='|' read -r slug port src_url src_kind; do
  [ -n "$slug" ] || continue
  [ -n "$src_url" ] || { echo "  skip $slug (no source)"; idx=$((idx+1)); continue; }
  [ -n "$port" ]    || { echo "  skip $slug (no dempOutputPort)"; idx=$((idx+1)); continue; }

  # Multicast group per port (matches dempUrlsFor in the API)
  octet=$(( 100 + (port % 155) ))
  last=$(( port & 255 ))
  mcast="239.7.${octet}.${last}"

  # Input URL normalisation (udp://X:Y → udp://@X:Y for multicast)
  input="$src_url"
  case "$src_kind" in
    UDP|RTP)
      if [[ "$input" == */@* ]] || [[ "$input" == *://@* ]]; then :; else
        input=$(echo "$input" | sed -E 's#^(udp|rtp)://([^@])#\1://@\2#')
      fi
      input="${input}?fifo_size=100000&overrun_nonfatal=1&timeout=6000000"
      ;;
  esac

  echo "  [$idx] $slug: $src_url → udp://$mcast:$port"

  (
    while true; do
      # PACING is the critical part for smooth same-LAN multicast:
      #  -re                            pace input at native rate so we
      #                                 don't blast packets in bursts
      #  -flush_packets 0               let ffmpeg batch UDP writes
      #                                 instead of flushing every packet
      #  -bsf:v h264_mp4toannexb        no-op for MPEG-2, safe for H264
      #  buffer_size=8388608 on output  8 MB kernel send buffer — with
      #                                 default 208 KB the sender was
      #                                 dropping bursts, receiver saw
      #                                 stalls on same-switch VLC
      #  fifo_size=1048576 pkt_size=1316 same pattern Analysys used
      ffmpeg -hide_banner -nostdin -loglevel warning \
        -re \
        -fflags +genpts+discardcorrupt -err_detect ignore_err \
        -f mpegts -i "$input" \
        -c copy \
        -flush_packets 0 \
        -f mpegts "udp://${mcast}:${port}?pkt_size=1316&buffer_size=8388608&fifo_size=1048576&ttl=8"
      # If ffmpeg exits, back off briefly and reconnect.
      sleep 3
    done
  ) &
  pids+=($!)
  idx=$((idx + 1))
done <<<"$rows"

trap 'echo "stopping ${#pids[@]} workers"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; wait; exit 0' TERM INT
wait
