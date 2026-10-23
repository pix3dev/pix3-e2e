# editor-e2e — browser checks of the pix3-core editor port

Raw CDP, headless Chrome from `../chrome.sh`. Plugin and editor are loaded
from their `dist/` in `../../pix3-core` — rebuild both first:

    (cd ../../pix3-core && npm run build -w packages/editor-core && cd packages/vite-plugin && npx tsc -p tsconfig.build.json)

Chrome gets a free debugging port per run (`launchChrome` in `cdp.mjs`): a fixed port let a run
attach to another process's Chrome (a leftover of a killed run, another agent's) — the "Chrome did
not come up" and hung runs of the first gate record. After a change in `packages/runtime`, delete
`.vite-cache*/`: the dev server pre-bundles `@pix3/runtime` there and does not notice the source
changed.

Every script takes the checkout under test as `--core <dir>` (or `$PIX3_CORE`; default
`../../pix3-core`) and loads the plugin from that checkout's `packages/vite-plugin/dist/index.js`,
so a worktree can be checked without touching the main checkout. Each makes its own fixture project
afresh from the scene corpus (`harness.mjs` `makeProject`: `proj-m3/`, `proj-race/`, `proj-size/`,
`proj3d/`, the gate's `proj/`, …), on a free Vite port, with a fresh Chrome profile. Exit code is 1
when any check failed.

- `run.mjs` — M2: editor mounts on `/__pix3/` — entry scene open, writer, viewport canvas, no
  `/@vite/client`, no request outside the known paths, no errors (8 checks; `proj-m2/`).
- `m3.mjs` — M3: inspector rename → idle save, agent edit → reload, script edit, bridge sync,
  agent play → stale sync, second tab read-only + take over, menus (19 checks; `proj-m3/`).
  `harness.mjs` is the shared half of run (M2), m3, n9-race, esc3d and size-crosscheck: `--core`, the
  fixture copy, the server on a free port, Chrome, `openEditor` (waits for the async bridge),
  `bridge(page)` (every short form awaited), `makeChecks` (non-zero exit on a failure).
- `gate-p1.mjs` — gate P1 of plan §G.2 (write model): real drags in the viewport, idle/upper-bound
  writes, Esc, N8, N10, external same key, two tabs, close → reopen, N9 draft across a dev-server
  restart (39 checks; a free port and its own profile). The fixture is a pre-W21 file (anchored
  rects, no margins), so the gate warms up with one rename — the editor's first write converts
  the file — and measures its rows against the converted text. Makes `proj/`, `.vite-cache-gate/` and
  `profile-gate/` afresh each run — a `proj/` an earlier run left (the node moved off the press
  point) failed it 6/10 with "Invalid parameters".
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
  (39 checks; `proj-size/`, the Node side through the checkout's Vite SSR).
- `n9-race.mjs [rounds]` — the N9 flake: stops the dev server the moment a Ctrl+S is on disk
  (its answer is lost), edits while it is down, reopens — is the draft offered and restored?
  Before editor-core `0c33774`: 6/6 rejected; after: offered every round. Green = offered and
  restored in every round, else exit 1 (`proj-race/`).
- `anchor-resize.mjs` — write-model W21: a container resized by its east handle writes the
  container alone (its width and centre), the anchored children live in their `layout:` margins —
  child lines byte-identical, a fresh tab agrees, the inspector shows the knob's `Right` row only;
  the same scene in the legacy form converts on its first write (margins in, anchored position
  components `0`, the stretched bar's `width` gone, comments intact), a second resize is one node
  again (25 checks; `proj-anchor/`, `.vite-cache-anchor/`, `profile-anchor/`).
- `locale-draft.mjs` — write-model W22: a locale cell committed while the dev server is down is
  drafted in IndexedDB against the disk sha; the tab closes, the server comes back, the new tab
  offers it, Restore writes it, the panel shows it (11 checks; `proj-locale-draft/`).
- `locale-follow.mjs` — write-model W20: locale tables follow the disk. Makes its own
  `proj-locale/` (`pix3 new 2d` + `locales/en.json`, `de.json`), opens Window → Localization with
  real clicks; an agent key appears after `pix3_sync`; an uncommitted cell edit + an agent write
  of another key → both on disk (once racing the commit: 412 → merge → write; once after the panel
  followed); the same key → disk value, notice, `rejected-draft` in the journal (and while typing:
  the cell shows the disk value + notice); a new/deleted locale file appears/disappears; an
  inline key rename vs a key the agent removes / a name it takes; a project that declares its
  locales follows `pix3project.yaml` (30 checks; free ports). `--core <checkout>`.
- `ledger-reopen.mjs` — write-model W26: the flush ledger in IndexedDB (`pix3-flush-ledgers`)
  outlives the tab — a stale agent write while no tab is open → the next tab's "An agent overwrote
  your edit" → Restore writes; a reopen on the own write adopts the record (a stale write while
  that tab is open is caught); an agent that read after the flush → no notice, record spent
  (18 checks; `proj-ledger/`, `.vite-cache-ledger/`, `profile-ledger/`).
- `texture-follow.mjs` — editor-core-port T1–T3: one PNG drawn by a Sprite2D, a Sprite3D and an
  AnimatedSprite3D; fs overwrites it (red → green) → the pixel at each node's `screen(id)` in a CDP
  screenshot turns green without a reload; a write during play is held (`pendingExternal`) and shows
  after stop (11 checks; `proj-texture/` from `pix3 new 2d`, free ports). Without the fix 9/11.
- `esc3d.mjs` — Esc during a real 3D gizmo drag (aimed with `__PIX3_DEBUG__.screen(id)`), with a
  no-Esc control (7 checks; `proj3d/` from `recipe-grid-3d`).

The recipes left `create-pix3` (owner decision 2026-10-10); they live on as the scene corpus
`packages/runtime/fixtures/scene-corpus/`. Every script speaks the async bridge v2
(`await __PIX3_DEBUG__.status()` / `.node()` / `.find()` / `.pending()`); `m3`, `esc3d`, `n9-race`
and `size-crosscheck` were ported from the v1 sync calls and fixed ports on 2026-10-11.
- `plugin-barrier.mjs` — plugin-only S1 counter-example (needs its own `proj/` with a
  `scripts/entry→middle→leaf` chain; see the file).
