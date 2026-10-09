# editor-e2e — browser checks of the pix3-core editor port

Throwaway harness (raw CDP, headless Chrome from `../chrome.sh`). Plugin and editor are loaded
from their `dist/` in `../../pix3-core` — rebuild both first:

    (cd ../../pix3-core && npm run build -w packages/editor-core && cd packages/vite-plugin && npx tsc -p tsconfig.build.json)

Project fixture (recreate before each run):

    rm -rf proj && mkdir proj && cp -r ../../pix3-core/packages/create-pix3/templates/recipe-tapper-2d/files/. proj/ \
      && ln -s ../../../pix3-core/node_modules proj/node_modules \
      && printf '<!doctype html><html><body><div id="app"></div></body></html>\n' > proj/index.html
    ln -sfn ../../pix3-core/node_modules node_modules

- `run.mjs` — M2: editor mounts on `/__pix3/` (8 checks).
- `m3.mjs` + `harness.mjs` — M3: inspector rename → idle save, agent edit → reload, script edit,
  bridge sync, agent play → stale sync, second tab read-only + take over, menus (19 checks).
- `gate-p1.mjs` — gate P1 of plan §G.2 (write model): real drags in the viewport, idle/upper-bound
  writes, Esc, N8, N10, external same key, two tabs, close → reopen, N9 draft across a dev-server
  restart (37 checks; own port 5296 and profile). Run it on a fresh `proj/`.
- `size-crosscheck.mjs` — write-model W2: an un-sized `Sprite2D` gets the same size in the editor
  (decoded) as `readImageHeaderSize` gives Node (PNG/JPEG/WebP made by Chrome, 8 SVG variants).
  Uses `proj/`; restores its `scenes/main.pix3scene`.
- `esc3d.mjs` — Esc during a real 3D gizmo drag (aimed with `__PIX3_DEBUG__.screen(id)`), with a
  no-Esc control. Needs `proj3d/`: the same recipe as above with `recipe-grid-3d`.
- `plugin-barrier.mjs` — plugin-only S1 counter-example (needs its own `proj/` with a
  `scripts/entry→middle→leaf` chain; see the file).
