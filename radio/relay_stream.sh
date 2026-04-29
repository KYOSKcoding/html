#!/data/data/com.termux/files/usr/bin/bash
# Stream live audio to kyo.sk — no ffmpeg needed on phone.
# Requires: termux-microphone-record (termux-api), curl
export PATH=/data/data/com.termux/files/usr/bin:$PATH
HOME=/data/data/com.termux/files/home

PASSWORD="broadcast"
SERVER="https://kyo.sk"
AUDIO_FILE="$HOME/.live_relay.ogg"

echo "Authenticating..."
AUTH=$(curl -sf -X POST \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\"}" \
  "$SERVER/api/radio/auth")

TOKEN=$(echo "$AUTH" | sed 's/.*"token":"\([^"]*\)".*/\1/')
if [ -z "$TOKEN" ] || [ "$TOKEN" = "$AUTH" ]; then
  echo "Auth failed: $AUTH"
  exit 1
fi
echo "Authenticated (${TOKEN:0:8}...)"

# Stop any leftover recording session
termux-microphone-record -q 2>/dev/null
sleep 0.5
rm -f "$AUDIO_FILE"

echo "Starting microphone..."
termux-microphone-record -e OPUS -r 44100 -c 1 -f "$AUDIO_FILE"

echo "Waiting for audio data..."
until [ -f "$AUDIO_FILE" ] && [ "$(wc -c < "$AUDIO_FILE" 2>/dev/null || echo 0)" -gt 1000 ]; do
  sleep 0.5
done

echo "Streaming to server (server converts audio)..."
tail -c +0 -f "$AUDIO_FILE" | \
  curl -X PUT \
    -H "X-Auth-Token: $TOKEN" \
    -H "Content-Type: audio/ogg" \
    -H "Transfer-Encoding: chunked" \
    --data-binary @- \
    "$SERVER/api/radio/relay-stream"

echo "Stream ended."
termux-microphone-record -q 2>/dev/null
