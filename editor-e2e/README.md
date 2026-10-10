# editor-e2e — browser checks of the pix3-core editor port

Throwaway harness (raw CDP, headless Chrome from `../chrome.sh`). Plugin and editor are loaded
from their `dist/` in `../../pix3-core` — rebuild both first:

    (cd ../../pix3-core && npm run build -w packages/editor-core && cd packages/vite-plugin && npx tsc -p tsconfig.build.json)

Chrome gets a free debugging port per run (`launchChrome` in `cdp.mjs`): a fixed port let a run
attach to another process's Chrome (a leftover of a killed run, another agent's) — the "Chrome did
not come up" and hung runs of the first gate record. After a change in `packages/runtime`, delete
`.vite-cache*/`: the dev server pre-bundles `@pix3/runtime` there and does not notice the source
changed.

Project fixture (recreate before each run; `proj-race/`, `proj-size/` the same way for scripts
run in parallel with the gate):

    rm -rf proj && mkdir proj && cp -r ../../pix3-core/packages/runtime/fixtures/scene-corpus/recipe-tapper-2d/files/. proj/ \
      && ln -s ../../../pix3-core/node_modules proj/node_modules \
      && printf '<!doctype html><html><body><div id="app"></div></body></html>\n' > proj/index.html
    ln -sfn ../../pix3-core/node_modules node_modules

- `run.mjs` — M2: editor mounts on `/__pix3/` (8 checks).
- `m3.mjs` + `harness.mjs` — M3: inspector rename → idle save, agent edit → reload, script edit,
  bridge sync, agent play → stale sync, second tab read-only + take over, menus (19 checks).
- `gate-p1.mjs` — gate P1 of plan §G.2 (write model): real drags in the viewport, idle/upper-bound
  writes, Esc, N8, N10, external same key, two tabs, close → reopen, N9 draft across a dev-server
  restart (37 checks; a free port and its own profile). Run it on a fresh `proj/`.
  `PIX3_CDP_PROXY=1` runs it through the P2 CDP token proxy: Chrome is launched by the CLI's
  Chrome owner over `--remote-debugging-pipe` and this harness connects with the token
  (`launchBehindProxy` in `cdp.mjs`).
- `gate-p2.mjs` — gate P2 of plan §G.3, the rows that are not about the build: CDP without the
  token / with a wrong one / from a page refused, Chrome without any debugging port; the window
  minimized → `pix3_game_run` frames > 0 (inline and through chrome-devtools-mcp); kill the dev
  server → banner, edits go on, IndexedDB draft, `pix3 editor` again → flushed; a second tab with
  a stale `If-Match` → 412, bytes untouched (30 checks). Makes its own `proj-p2/` with
  `pix3 new` and `home-p2/` (`PIX3_HOME`); real `pix3 editor --headless` + chrome-devtools-mcp
  1.10.1 from `.mcp.json` + a raw CDP probe, all through the proxy, free ports.
  `--core <checkout>` (default `../../pix3-core`).
- `size-crosscheck.mjs` — write-model W2 / S12 §4.2: an un-sized `Sprite2D` gets the same size in
  the editor (decoded) as `readImageHeaderSize` gives Node (PNG/JPEG/WebP made by Chrome, 8 SVG
  variants); every textured node type (`AnimatedSprite2D` stretch/native, `AnimatedSprite3D`,
  `Sprite3D`, `TiledSprite2D`, `Button2D`, `Bar2D`, `Slider2D`, `Checkbox2D`) saves the same
  node in the editor as the runtime's Node harness (loaded through Vite SSR); a `flow` column
  with `autoSize` over un-sized sprites lays out the same; nothing is pending after opening
  (39 checks). Uses `$PROJ_DIR` (default `proj/`); restores its `scenes/main.pix3scene`.
- `n9-race.mjs [rounds]` — the N9 flake: stops the dev server the moment a Ctrl+S is on disk
  (its answer is lost), edits while it is down, reopens — is the draft offered and restored?
  Before editor-core `0c33774`: 6/6 rejected; after: offered every round. Uses `$PROJ_DIR`.
- `esc3d.mjs` — Esc during a real 3D gizmo drag (aimed with `__PIX3_DEBUG__.screen(id)`), with a
  no-Esc control. Needs `proj3d/`: the same recipe as above with `recipe-grid-3d`.

The recipes left `create-pix3` (owner decision 2026-10-10); they live on as the scene corpus
`packages/runtime/fixtures/scene-corpus/`. `gate-p1.mjs` speaks the async bridge v2
(`await __PIX3_DEBUG__.status()` / `.node()`); `m3`, `esc3d`, `n9-race`, `size-crosscheck` still
use the v1 sync calls.
- `plugin-barrier.mjs` — plugin-only S1 counter-example (needs its own `proj/` with a
  `scripts/entry→middle→leaf` chain; see the file).
