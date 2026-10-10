# pix3-core P0 spikes

Throwaway spike code for `pix3/.plans/pix3-core.md` §G.1 (P0). Not a product repo, and the pix3
repository itself is never modified from here. Reports live in `reports/`.

- `chrome.sh` — headless Chrome 155 (chrome-headless-shell) with WebGL2 via SwiftShader; this
  server lacks `libasound`, so it is extracted from the Ubuntu deb into `.browsers/libs`.
- `cdp-eval.mjs` — evaluate an expression in a page over raw CDP.
- `mcp-call.mjs` — minimal stdio MCP client driving `chrome-devtools-mcp@1.10.1`.
- `s4-metrics.py` — S4 metrics from a Codex rollout jsonl (`python3 s4-metrics.py <rollout>.jsonl`).
- `pix3-full/` (gitignored) — local clone of pix3 with `w-skeleton/editor-patch/` applied; the
  skeleton editor is built from here.
- `w-skeleton/` — W: the current editor served at `/__pix3/` by a Vite plugin over `pix3 serve`,
  plus the S4 3p-tool registration.
- `s1-one-instance/` — S1: one runtime instance, no editor reload, sync barrier.
- `s12-patch/` — S12: `ScenePatchWriter` + `norm` prototype.
- `build-check/` — P1 artifact check (plan §B.6): build a template project with `@pix3/vite-plugin`
  from a pix3-core checkout and open the single-file html via `vite preview`, `file://` and a
  sandboxed iframe (`node build-check/run.mjs [--core ../pix3-core] [--template <name>]`).
- `bridge-e2e/` — P1 agent bridge end to end (plan §D, `pix3-core/.plans/agent-bridge.md`): `setup.sh`
  makes a project with `pix3 new` from a pix3-core checkout, `run.mjs` runs `pix3 editor` (detached
  Vite + headless Chrome on a free port) and `pix3 agent-setup`, then drives chrome-devtools-mcp
  from the written `.mcp.json` through `mcp.mjs`: 3p tools, sync with `expect`, play ownership,
  inline fallback (`node bridge-e2e/run.mjs [--core <checkout>]`).
- `scripts-e2e/` — P1 scripts and bot policies through Vite (`pix3-core/.plans/scripts-vite.md`):
  `setup.sh` makes a `pix3 new 2d` project from a pix3-core checkout (default `../pix3-core-scripts`)
  with a script whose fields come from a nested module and a bot policy with a helper; `run.mjs`
  runs its Vite + headless Chrome on free ports and checks sync stamps, the inspector field, no
  reload, bot policies added/changed/deleted (also during play), no `/@vite/client`, and the
  contract-B negative control (`node scripts-e2e/run.mjs [--core <checkout>]`).
- `remote-e2e/` — Remote SSH (`pix3-core/.plans/agent-bridge.md` A20–A23): two HOMEs on this box
  (the "remote" with `SSH_CONNECTION`, the project and Vite; the "local" with headless Chrome
  behind the token proxy), two non-1:1 TCP forwards standing in for VS Code's and the SSH
  `RemoteForward`; chrome-devtools-mcp 1.10.1 from the remote `.mcp.json` reaches the tab through
  the forward with the token and is refused without it (`./remote-e2e/setup.sh`, then
  `node remote-e2e/run.mjs [--core <checkout>]`; default checkout `../pix3-core`).
- `imagegen-e2e/` — the image-gen key proxy (`pix3-core/.plans/editor-core-port.md` §11): a
  `pix3 new 2d` project in `imagegen-e2e/work/`, its Vite with `PIX3_HOME` and the providers'
  origins on a local mock, headless Chrome on a free port; a 1.x browser-stored key migrates to
  `keys.json`, Generate from the panel reaches the mock with the key header, no page response /
  DOM / storage / log holds a key, the game page at `/` is refused (fetch, forged referrer,
  framed, `window.open`) — `node imagegen-e2e/run.mjs [--core <checkout>]` (27 checks).
- `reports/` — `pix3-core-p0-{w,s1,s12,human}.md`.
