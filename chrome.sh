#!/usr/bin/env bash
# Headless Chrome for the e2e checks (no root needed): chrome-headless-shell in .browsers/,
# libasound extracted from the Ubuntu deb into .browsers/libs (see README); WebGL2 via SwiftShader.
# Usage: ./chrome.sh --remote-debugging-port=9333 [--user-data-dir=DIR] [URL]
HERE="$(cd "$(dirname "$0")" && pwd)"
export LD_LIBRARY_PATH="$HERE/.browsers/libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$HERE/.browsers/chrome-headless-shell/linux-155.0.8059.39/chrome-headless-shell-linux64/chrome-headless-shell" \
  --no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --no-first-run "$@"
