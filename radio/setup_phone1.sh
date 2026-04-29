#!/data/data/com.termux/files/usr/bin/bash
# One-shot setup for phone 1 (RTMP streaming via ffmpeg)

echo "=== Updating package index ==="
pkg update -y || echo "(mirror error — continuing anyway)"

echo "=== Installing termux-api, ffmpeg, curl ==="
pkg install -y termux-api ffmpeg curl

echo "=== Downloading stream script ==="
curl -fsSL -o ~/rtmp_stream.sh https://kyo.sk/radio/rtmp_stream.sh
chmod +x ~/rtmp_stream.sh

echo ""
echo "=== Verifying ffmpeg ==="
ffmpeg -version 2>&1 | head -1

echo ""
echo "=== DONE ==="
echo "Run: bash ~/rtmp_stream.sh"
echo ""
echo "Before streaming, grant microphone permission:"
echo "  Android Settings → Apps → Termux:API → Permissions → Microphone → Allow"
