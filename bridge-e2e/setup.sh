#!/usr/bin/env bash
# Recreate the bridge-e2e project: a 2D template project served by @pix3/vite-plugin from a
# pix3-core checkout (default: ../../pix3-core-bridge; pass another as $1). node_modules is a
# symlink into that checkout, so the plugin and the editor come from its packages' dist/ —
# build them first:
#   (cd <core> && npm run build -w packages/editor-core && cd packages/vite-plugin && npx tsc -p tsconfig.build.json)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CORE="$(cd "${1:-$HERE/../../pix3-core-bridge}" && pwd)"
PROJ="$HERE/proj"
rm -rf "$PROJ"
# `pix3 new` from the checkout: the template, pix3project.yaml and the agent kit (with the
# pix3-editor skill) exactly as a user gets them. The recipes left create-pix3 (owner decision
# 2026-10-10); the tapper lives on in the runtime's scene corpus, which `pix3 new` reads through
# PIX3_TEMPLATES_DIR.
(cd "$HERE" && PIX3_TEMPLATES_DIR="$CORE/packages/runtime/fixtures/scene-corpus" \
  node "$CORE/packages/cli/src/index.ts" new recipe-tapper-2d proj --name bridge-e2e)
ln -s "$CORE/node_modules" "$PROJ/node_modules"
cat > "$PROJ/index.html" <<'HTML'
<!doctype html><html><body><div id="app"></div></body></html>
HTML
cat > "$PROJ/vite.config.ts" <<'TS'
import { defineConfig } from 'vite';
import { pix3 } from '@pix3/vite-plugin';

export default defineConfig({
  plugins: [pix3()],
  server: { host: '127.0.0.1' },
  cacheDir: '.vite-cache',
});
TS
printf '{ "name": "bridge-e2e-proj", "private": true, "type": "module" }\n' > "$PROJ/package.json"
# pix3 new writes a root tsconfig that extends .pix3/tsconfig.check.json; vite does not need it.
echo "bridge-e2e project in $PROJ (core: $CORE)"
