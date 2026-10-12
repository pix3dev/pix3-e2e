# pix3-e2e

Browser end-to-end checks for [pix3-core](https://github.com/pix3dev/pix3-core): the editor on
`/__pix3/`, the agent bridge through chrome-devtools-mcp, scripts through Vite, the playable build,
the player's debug mode, Remote SSH and the image-gen key proxy, each in a real headless Chrome.
They live outside pix3-core because they need a browser, real ports and real processes; the
package specs cover the rest.

Every check builds its own fixture project afresh, picks free ports, uses a fresh Chrome profile,
prints `PASS` / `FAIL` per row and exits non-zero when any row failed.

## Setup

The checks expect a pix3-core checkout next to this one (`../pix3-core`); every one takes another
checkout with `--core <dir>` (most also read `$PIX3_CORE`; the `setup.sh` scripts take it as
`$1`), so a worktree can be checked without touching the main one.

```sh
git clone https://github.com/pix3dev/pix3-core.git
git clone https://github.com/pix3dev/pix3-e2e.git
(cd pix3-core && npm ci && npm run build --workspaces --if-present)

# Dependencies (vite, ws, @pix3/*) come from the checkout's node_modules.
ln -s ../../pix3-core/node_modules pix3-e2e/editor-e2e/node_modules

# Headless Chrome, the version chrome.sh launches.
cd pix3-e2e
npx @puppeteer/browsers install chrome-headless-shell@155.0.8059.39 --path .browsers
```

`chrome.sh` runs chrome-headless-shell with WebGL2 through SwiftShader, so no GPU is needed. On a
server without `libasound`, extract it from the distribution's package into `.browsers/libs`
(Ubuntu: `apt download libasound2t64 && dpkg -x libasound2t64_*.deb .browsers/libs`); `chrome.sh`
puts it on `LD_LIBRARY_PATH`.

## Checks

- `editor-e2e/` — the editor port: mount on `/__pix3/` (`run.mjs`), inspector, saves, agent
  edits, two tabs (`m3.mjs`), write-model gates P1 and P2 (`gate-p1.mjs`, `gate-p2.mjs`), the N9
  draft race, sizes against the Node runtime, anchors, locales, texture follow. See its
  [README](editor-e2e/README.md).
- `build-check/` — the playable build: a starter from `npm create pix3` built with
  `@pix3/vite-plugin`, the single-file html opened through `vite preview`, `file://` and a
  sandboxed iframe (`node build-check/run.mjs [--core <dir>] [--template <name>] [--compress]
  [--vite 7|8] [--lib named|namespace]`).
- `bridge-e2e/` — the agent bridge: `pix3 editor` (Vite + headless Chrome on a free port) and
  `pix3 agent-setup`, then chrome-devtools-mcp from the written `.mcp.json` — 3p tools, sync with
  `expect`, play ownership, inline fallback, the CDP token (`./bridge-e2e/setup.sh`, then
  `node bridge-e2e/run.mjs [--core <dir>]`).
- `scripts-e2e/` — scripts and bot policies through Vite: sync stamps, the inspector field, no
  reload, policies added / changed / deleted (also during play), no `/@vite/client`
  (`./scripts-e2e/setup.sh`, then `node scripts-e2e/run.mjs [--core <dir>]`).
- `debug-e2e/` — the player's debug mode (`/?debug`): overlay, FPS and profiler activity, errors,
  pause / step / resume, `?scene=`, the editor's run modes (`node debug-e2e/run.mjs [--core <dir>]
  [--keep]`).
- `remote-e2e/` — Remote SSH: two HOMEs on one box (the "remote" with `SSH_CONNECTION`, the
  project and Vite; the "local" with Chrome behind the token proxy) joined by two TCP forwards;
  chrome-devtools-mcp reaches the tab through the forward with the token and is refused without it
  (`./remote-e2e/setup.sh`, then `node remote-e2e/run.mjs [--core <dir>]`).
- `imagegen-e2e/` — the image-gen key proxy against a local mock of the providers: key
  migration, Generate from the panel, no key in any page response, DOM, storage or log, the game
  page refused (`node imagegen-e2e/run.mjs [--core <dir>]`).

## Tools

- `chrome.sh` — `./chrome.sh --remote-debugging-port=<port> [--user-data-dir=<dir>] [url]`.
- `cdp-eval.mjs` — evaluate an expression in a page over raw CDP:
  `node cdp-eval.mjs <port> <url substring> '<expression>'`.
- `mcp-call.mjs` — minimal stdio MCP client driving `chrome-devtools-mcp@1.10.1`:
  `CDP=http://127.0.0.1:<port> node mcp-call.mjs '[{"name": "list_pages", "arguments": {}}]'`.
