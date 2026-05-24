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
  # Re-create dirs every cycle — ffmpeg dies instantly if the archive
  # output dir is missing, which breaks the broadcaster's RTMP pipe.
  mkdir -p "$RADIO_DIR" "$ARCHIVE_DIR"
  TS=$(date +%Y-%m-%d_%H-%M-%S)
  TITLE=$(cat "$TITLE_FILE" 2>/dev/null | tr -cd '[:alnum:]_-' | cut -c1-40)
  ARCHIVE="$ARCHIVE_DIR/${TS}_LIVE${TITLE:+_${TITLE}}.mp3"

  kyo_live stop
  echo "[radio-hls] listening on :45860, will archive to $ARCHIVE"

  WATCHDOG_PID=""

  # Process substitution (not pipe) so WATCHDOG_PID assignment is visible to
  # this shell — bash 4.2 runs the last segment of `cmd | while` in a subshell.
  while IFS= read -r line; do
    echo "$line"
    if [[ "$line" == *"Input #0"* ]] && [ -z "$WATCHDOG_PID" ]; then
      echo "[radio-hls] stream connected — going live"
      kyo_live start

      # Staleness watchdog: kills ffmpeg if HLS output stops updating for >60s.
      # Catches the half-open-socket case (broadcaster power-off, no TCP FIN)
      # where ffmpeg sits forever in a blocking read() on a dead socket.
      (
        LAST_FRESH=$(date +%s)
        while pgrep -f 'ffmpeg .*45860/live/stream' >/dev/null; do
          sleep 5
          MTIME=$(stat -c %Y "$RADIO_DIR/index.m3u8" 2>/dev/null)
          if [ -n "$MTIME" ]; then
            NOW=$(date +%s)
            AGE=$((NOW - MTIME))
            [ "$AGE" -lt 10 ] && LAST_FRESH=$NOW
          fi
          if [ "$(( $(date +%s) - LAST_FRESH ))" -gt 60 ]; then
            echo "[radio-hls] watchdog: HLS stale >60s, killing stuck ffmpeg"
            pkill -TERM -f 'ffmpeg .*45860/live/stream'
            sleep 3
            pkill -KILL -f 'ffmpeg .*45860/live/stream' 2>/dev/null
            break
          fi
        done
      ) &
      WATCHDOG_PID=$!
    fi
  done < <(ffmpeg \
    -listen 1 -i rtmp://[::]:45860/live/stream \
    -map 0:a -c:a libmp3lame -b:a 128k \
    -f hls \
    -hls_time 3 \
    -hls_list_size 10 \
    -hls_flags delete_segments \
    -hls_segment_filename "$RADIO_DIR/seg%03d.ts" \
    "$RADIO_DIR/index.m3u8" \
    -map 0:a -c:a libmp3lame -b:a 128k \
    "$ARCHIVE" 2>&1)

  # ffmpeg has exited (clean end, error, or killed by watchdog).
  # Reap the watchdog if it's still alive.
  if [ -n "$WATCHDOG_PID" ]; then
    kill "$WATCHDOG_PID" 2>/dev/null
    wait "$WATCHDOG_PID" 2>/dev/null
  fi

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
