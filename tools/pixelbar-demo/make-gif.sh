#!/usr/bin/env bash
# Rebuilds pixelbar/demo.gif from pixelbar's own drawing code and made-up demo data.
#
# Needs: node (20+), npx, python3 with venv, ffmpeg, and the DejaVu fonts.
# Run from anywhere: tools/pixelbar-demo/make-gif.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$here/shim.js" "$here/demo.mjs" "$here/render.py" "$work/"
cd "$work"

# 1. Bundle the mod with the 'claude-code' import pointed at the shim.
npx -y esbuild@0.24 "$repo/pixelbar/hooks/register.tsx" --bundle --format=esm \
  --jsx-factory=h --jsx-fragment=Fragment --alias:claude-code=./shim.js \
  --outfile=pixelbar.mjs --log-level=warning

# 2. Play the scripted demo, writing every frame's cells to frames.json.
node demo.mjs

# 3. Draw the frames as PNGs.
python3 -m venv venv
venv/bin/python -m pip install -q pillow
venv/bin/python render.py

# 4. Assemble a looping GIF at 8 frames a second, no dithering (pixel art).
ffmpeg -loglevel error -y -framerate 8 -i png/%04d.png -vf "palettegen=max_colors=128:stats_mode=full" palette.png
ffmpeg -loglevel error -y -framerate 8 -i png/%04d.png -i palette.png -lavfi "paletteuse=dither=none" -loop 0 demo.gif

cp demo.gif "$repo/pixelbar/demo.gif"
echo "wrote $repo/pixelbar/demo.gif"
