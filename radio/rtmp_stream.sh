#!/data/data/com.termux/files/usr/bin/bash
export PATH=/data/data/com.termux/files/usr/bin:$PATH
HOME=/data/data/com.termux/files/home

SERVER="rtmp://kyo.sk:45860/live/stream"
AUDIO_FILE="$HOME/.live_audio.ogg"
FFMPEG_PID=""

cleanup() {
    echo "Stopping..."
    termux-microphone-record -q 2>/dev/null
    [ -n "$FFMPEG_PID" ] && kill "$FFMPEG_PID" 2>/dev/null
    rm -f "$AUDIO_FILE"
    exit 0
}
# HUP catches Termux session close; INT catches Ctrl+C; TERM catches kill
trap cleanup INT TERM HUP

# Stop any leftover recording from a previous session
termux-microphone-record -q 2>/dev/null
sleep 0.3
rm -f "$AUDIO_FILE"

echo "Starting recording (2h max)..."
# -l 7200 = 2 hour limit; prevents the 15-minute default cap
termux-microphone-record -e OPUS -r 44100 -c 1 -l 7200 -f "$AUDIO_FILE"

echo "Waiting for audio data..."
until [ -f "$AUDIO_FILE" ] && [ "$(wc -c < "$AUDIO_FILE" 2>/dev/null || echo 0)" -gt 1000 ]; do
    sleep 0.5
done
echo "Streaming to $SERVER — Ctrl+C or close Termux to stop"

tail -c +0 -f "$AUDIO_FILE" | \
    ffmpeg -f ogg -i pipe:0 \
        -acodec libmp3lame -b:a 128k \
        -vn \
        -f flv "$SERVER" &
FFMPEG_PID=$!

wait $FFMPEG_PID
echo "Stream ended — stopping recording"
cleanup
