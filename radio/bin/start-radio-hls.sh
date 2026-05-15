#!/bin/bash
RADIO_DIR=~/html/radio/live
ARCHIVE_DIR=~/html/radio/music/archive/invisible
TITLE_FILE=~/html/radio/.broadcast_title
KYO_API="https://kyo.sk/kyosky/api"
KYO_PASS="broadcast"

mkdir -p "$RADIO_DIR" "$ARCHIVE_DIR"

# Supervisor restarts leave the child ffmpeg orphaned, still holding :45860.
# Kill any stale listener so the new loop can bind the port.
pkill -f 'ffmpeg .*45860' 2>/dev/null && sleep 2

kyo_live() {
  curl -s -X POST "$KYO_API/radio/live/$1" \
    -H "Content-Type: application/json" \
    -H "X-Broadcaster-Token: $KYO_PASS" > /dev/null
}

echo "[radio-hls] started"

while true; do
  rm -f "$RADIO_DIR"/*.ts "$RADIO_DIR"/index.m3u8
  TS=$(date +%Y-%m-%d_%H-%M-%S)
  TITLE=$(cat "$TITLE_FILE" 2>/dev/null | tr -cd '[:alnum:]_-' | cut -c1-40)
  ARCHIVE="$ARCHIVE_DIR/${TS}_LIVE${TITLE:+_${TITLE}}.mp3"

  kyo_live stop
  echo "[radio-hls] listening on :45860, will archive to $ARCHIVE"

  ffmpeg \
    -listen 1 -i rtmp://[::]:45860/live/stream \
    -map 0:a -c:a libmp3lame -b:a 128k \
    -f hls \
    -hls_time 3 \
    -hls_list_size 5 \
    -hls_flags delete_segments \
    -hls_segment_filename "$RADIO_DIR/seg%03d.ts" \
    "$RADIO_DIR/index.m3u8" \
    -map 0:a -c:a libmp3lame -b:a 128k \
    "$ARCHIVE" 2>&1 | \
  while IFS= read -r line; do
    echo "$line"
    if [[ "$line" == *"Input #0"* ]]; then
      echo "[radio-hls] stream connected — going live"
      kyo_live start
    fi
  done

  kyo_live stop
  echo "[radio-hls] stream ended, restarting listener..."

  if [ -f "$ARCHIVE" ]; then
    SIZE=$(wc -c < "$ARCHIVE")
    if [ "$SIZE" -lt 160000 ]; then
      rm -f "$ARCHIVE"
      echo "[radio-hls] archive too short, discarded"
    else
      echo "[radio-hls] archived $ARCHIVE ($SIZE bytes)"
    fi
  fi

  sleep 0.5
done
