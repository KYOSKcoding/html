#!/data/data/com.termux/files/usr/bin/bash
# Stream live audio to kyo.sk via 4-second segments — no ffmpeg needed on phone.
# Requires: termux-microphone-record (termux-api package), curl
export PATH=/data/data/com.termux/files/usr/bin:$PATH
HOME=/data/data/com.termux/files/home

PASSWORD="broadcast"
SERVER="https://kyo.sk/kyosky"
SEG_FILE="$HOME/.relay_seg.ogg"

trap 'echo "Stopping..."; termux-microphone-record -q 2>/dev/null; exit 0' INT TERM HUP

echo "Starting segment loop — Ctrl+C to stop."

N=0
while true; do
  rm -f "$SEG_FILE"

  # Record 4 seconds (non-blocking — returns immediately)
  termux-microphone-record -e OPUS -r 44100 -c 1 -l 4 -f "$SEG_FILE"

  # Wait for recording to finish
  sleep 4.5
  termux-microphone-record -q 2>/dev/null

  SIZE=$(wc -c < "$SEG_FILE" 2>/dev/null || echo 0)
  if [ "$SIZE" -lt 500 ]; then
    echo "Segment $N: too small ($SIZE bytes), skipping"
    continue
  fi

  # Upload segment — password in header, no session token needed
  HTTP=$(curl -sf -o /dev/null -w "%{http_code}" -X POST \
    -H "X-Broadcast-Password: $PASSWORD" \
    -H "Content-Type: audio/ogg" \
    --data-binary @"$SEG_FILE" \
    "$SERVER/api/radio/relay-segment")

  echo "Segment $N → $HTTP (${SIZE}B)"
  N=$((N + 1))
done
