#!/bin/sh
set -eu

URL=${1:-}
OUTPUT_DIR="${2:-downloads}"

if [ -z "$URL" ]; then
  echo "Usage: npm run test:youtube -- 'https://www.youtube.com/watch?v=VIDEO_ID'"
  exit 1
fi

YTDLP=$(command -v yt-dlp || true)
FFMPEG=$(command -v ffmpeg || true)

if [ -z "$YTDLP" ] || [ -z "$FFMPEG" ]; then
  echo "yt-dlp et ffmpeg sont nécessaires pour le test local."
  echo "Installe-les avec : brew install yt-dlp ffmpeg"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
echo "Téléchargement local avec $YTDLP"
"$YTDLP" \
  --no-playlist \
  --no-warnings \
  --format "bestaudio/best" \
  --extract-audio \
  --audio-format mp3 \
  --audio-quality 0 \
  --ffmpeg-location "$FFMPEG" \
  --output "$OUTPUT_DIR/%(title)s.%(ext)s" \
  "$URL"

echo "MP3 enregistré dans : $OUTPUT_DIR"
