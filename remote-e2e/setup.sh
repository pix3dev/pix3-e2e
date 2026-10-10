#!/usr/bin/env bash
# Recreate the remote-e2e project (the "remote host"'s project): a 2D starter served by
# @pix3/vite-plugin from a pix3-core checkout (default: ../../pix3-core-ssh; pass another as $1).
# node_modules is a symlink into that checkout, so build its editor and plugin first:
#   (cd <core> && npm run build -w packages/editor-core && cd packages/vite-plugin && npx tsc -p tsconfig.build.json)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CORE="$(cd "${1:-$HERE/../../pix3-core-ssh}" && pwd)"
PROJ="$HERE/proj"
rm -rf "$PROJ"
(cd "$HERE" && node "$CORE/packages/cli/src/index.ts" new 2d proj --name remote-e2e)
rm -rf "$PROJ/node_modules"
ln -s "$CORE/node_modules" "$PROJ/node_modules"
echo "remote-e2e project in $PROJ (core: $CORE)"
