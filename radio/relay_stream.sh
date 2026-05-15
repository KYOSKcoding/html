#!/data/data/com.termux/files/usr/bin/bash
# Stream live audio to kyo.sk via 4-second segments — no ffmpeg needed on phone.
# Requires: termux-microphone-record (termux-api package), curl
export PATH=/data/data/com.termux/files/usr/bin:$PATH
HOME=/data/data/com.termux/files/home

PASSWORD="broadcast"
SERVER="https://kyo.sk/kyosky"
CURR="$HOME/.relay_curr.ogg"
NEXT="$HOME/.relay_next.ogg"

trap 'echo "Stopping..."; termux-microphone-record -q 2>/dev/null; termux-wake-unlock 2>/dev/null; rm -f "$CURR" "$NEXT"; exit 0' INT TERM HUP

echo "Acquiring wakelock..."
termux-wake-lock

echo "Recording first segment..."
rm -f "$CURR"
termux-microphone-record -e OPUS -r 44100 -c 1 -l 4 -f "$CURR"
sleep 4.2
termux-microphone-record -q 2>/dev/null

echo "Starting pipeline loop — Ctrl+C or close Termux to stop."

N=0
while true; do
  # Start recording NEXT segment immediately (non-blocking)
  rm -f "$NEXT"
  termux-microphone-record -e OPUS -r 44100 -c 1 -l 4 -f "$NEXT"

  # Upload CURR while NEXT is recording
  SIZE=$(wc -c < "$CURR" 2>/dev/null || echo 0)
  if [ "$SIZE" -ge 500 ]; then
    HTTP=$(curl -sf -o /dev/null -w "%{http_code}" -X POST \
      -H "X-Broadcaster-Token: $PASSWORD" \
      -H "Content-Type: audio/ogg" \
      --data-binary @"$CURR" \
      "$SERVER/api/radio/relay-segment")
    echo "Segment $N → $HTTP (${SIZE}B)"
  else
    echo "Segment $N: too small (${SIZE}B), skipping"
  fi

  # Wait for NEXT recording to finish, then swap
  sleep 4.2
  termux-microphone-record -q 2>/dev/null
  mv "$NEXT" "$CURR"
  N=$((N + 1))
done
