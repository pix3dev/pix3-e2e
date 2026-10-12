// Debug mode of the player (`/?debug` on the dev server): a 2D starter from the checkout's
// `npm create pix3`, plus a probe script on the root (a ~1 ms busy-wait reported as a
// FrameProfiler activity, one thrown error at frame 30, a registerGameDebug provider), served by
// the project's own vite.config.ts through Vite's dev server, opened in headless Chrome.
//
// Judged by state, not pixels: `/` loads no overlay (no shadow host, no `__PIX3_PLAYER__.debug`,
// no request for `player/debug/`); `/?debug` mounts it and `__PIX3_PLAYER__.debug.snapshot()`
// carries FPS, renderer counters, the probe's activity, the probe's error and the game snapshot;
// Pause freezes `frames`, Step advances exactly one, Resume runs again. `/` carries the "Pix3
// editor" link (none on `?clean`), which turns its tab into the editor when none is open and
// says so when one is; `?scene=` boots that scene. In the editor, the run modes (Run menu, the
// toolbar's run options) open `<base>?debug&scene=…` / `<base>?scene=…` or run in the Game tab,
// Play runs the last mode, and the mode survives a reload. Screenshots for the visual questions.
//
//   node debug-e2e/run.mjs [--core <pix3-core checkout>] [--keep]
//
// Needs the checkout's `packages/vite-plugin/dist` and `packages/editor-core/dist` built:
// the project resolves `@pix3/vite-plugin/player` through the package's `exports`, as a real
// project does.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Browser } from '../build-check/cdp.mjs';

const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const CORE = resolve(option('--core', join(HERE, '../../pix3-core')));
const CHROME = join(HERE, '../chrome.sh');
const KEEP = args.includes('--keep');
const PROJ = join(HERE, 'proj');
const PROFILE = join(HERE, `profile-${process.pid}`);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
};
const freePort = () =>
  new Promise((res, rej) => {
    const server = createServer();
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => res(port));
    });
  });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let chrome = null;
let server = null;
const cleanup = () => {
  if (chrome && chrome.exitCode === null) chrome.kill('SIGKILL');
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

// --- 1. a 2D starter plus the probe ---------------------------------------------------------
rmSync(PROJ, { recursive: true, force: true });
const created = spawnSync(
  process.execPath,
  [join(CORE, 'packages/create-pix3/index.js'), PROJ, '--template', '2d', '--name', 'debug-e2e', '--yes'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
);
check('npm create pix3 --template 2d', created.status === 0, created.status === 0 ? undefined : created.stderr);
const mainPath = join(PROJ, 'scenes/main.pix3scene');
writeFileSync(
  mainPath,
  readFileSync(mainPath, 'utf8').replace(
    /^(root:\n  - id: game-root\n    type: \w+\n    name: Game Root\n)/m,
    '$1    components:\n      - id: probe\n        type: user:DebugProbe\n        enabled: true\n        config: {}\n      - id: throw-once\n        type: user:ThrowOnce\n        enabled: true\n        config: {}\n'
  )
);
// A second scene for `?scene=` (the main scene without the probe scripts).
writeFileSync(join(PROJ, 'scenes/second.pix3scene'), readFileSync(join(CORE, 'packages/create-pix3/templates/2d/files/scenes/main.pix3scene'), 'utf8'));
mkdirSync(join(PROJ, 'scripts'), { recursive: true });
writeFileSync(
  join(PROJ, 'scripts/DebugProbe.ts'),
  `import { registerGameDebug, Script } from '@pix3/runtime';

/** Busy-waits ~1 ms a frame and says so, and exposes a game snapshot. */
export class DebugProbe extends Script {
  private frames = 0;
  private unregister: (() => void) | null = null;

  onStart(): void {
    this.unregister = registerGameDebug({ name: 'probe', snapshot: () => ({ frames: this.frames }) });
  }

  onUpdate(): void {
    this.frames++;
    const t0 = performance.now();
    while (performance.now() - t0 < 1) {
      // busy
    }
    this.scene?.reportFrameProfilerActivities([{ label: 'Probe busy-wait', selfTimeMs: performance.now() - t0 }]);
  }

  onDetach(): void {
    this.unregister?.();
  }
}
`
);
// A throwing script is disabled by the runtime, so the error comes from its own component.
writeFileSync(
  join(PROJ, 'scripts/ThrowOnce.ts'),
  `import { Script } from '@pix3/runtime';

export class ThrowOnce extends Script {
  private frames = 0;

  onUpdate(): void {
    if (++this.frames === 30) throw new Error('probe error at frame 30');
  }
}
`
);
const coreModules = join(CORE, 'node_modules');
const nm = join(PROJ, 'node_modules');
mkdirSync(nm);
for (const entry of readdirSync(coreModules)) {
  if (entry === '.bin' || entry === '.package-lock.json') continue;
  symlinkSync(join(coreModules, entry), join(nm, entry), 'dir');
}
check('plugin dist has the overlay', existsSync(join(CORE, 'packages/vite-plugin/dist/player/debug/index.js')));

// --- 2. the project's dev server ----------------------------------------------------------------
const vite = await import(pathToFileURL(join(CORE, 'node_modules/vite/dist/node/index.js')).href);
const port = await freePort();
server = await vite.createServer({
  root: PROJ,
  configFile: join(PROJ, 'vite.config.ts'),
  logLevel: 'warn',
  server: { port, strictPort: true, host: '127.0.0.1' },
});
await server.listen();
const origin = `http://127.0.0.1:${port}`;

// --- 3. Chrome ------------------------------------------------------------------------------------
const cdpPort = await freePort();
chrome = spawn(CHROME, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${PROFILE}`, '--window-size=1280,800', 'about:blank'], {
  stdio: 'ignore',
});
const browser = await Browser.connect(cdpPort);

const resources = page => page.evaluate("performance.getEntriesByType('resource').map(e => e.name)");

// 3a. `/`: the game, no debug mode.
const plain = await browser.newPage('plain');
await plain.navigate(`${origin}/`);
await plain.waitFor("window.__PIX3_PLAYER__?.status === 'running' && window.__PIX3_PLAYER__.frames > 10", 60000);
await sleep(500);
check(
  '/ runs without the overlay',
  await plain.evaluate("!document.querySelector('.pix3-debug-overlay') && window.__PIX3_PLAYER__.debug === undefined"),
);
const plainRequests = (await resources(plain)).filter(name => name.includes('player/debug'));
check('/ requests nothing from player/debug', plainRequests.length === 0, plainRequests);
const linkRoot = "document.querySelector('.pix3-editor-link')?.shadowRoot";
await plain.waitFor(`!!${linkRoot}`, 10000).catch(() => null);
check('/ shows the Pix3 editor link', await plain.evaluate(`${linkRoot}?.querySelector('[data-action="open"]')?.textContent.includes('Pix3 editor') === true`));
// With no editor open, the link turns this tab into the editor.
await plain.evaluate(`${linkRoot}.querySelector('[data-action="open"]').click()`);
await plain.waitFor("location.pathname === '/__pix3/'", 10000).catch(() => null);
check('the link opens the editor in this tab when none is open', (await plain.evaluate('location.pathname')) === '/__pix3/');
await browser.send('Target.closeTarget', { targetId: plain.targetId });

const other = await browser.newPage('other');
await other.navigate(`${origin}/?clean&scene=scenes/second.pix3scene`);
await other.waitFor("window.__PIX3_PLAYER__?.status === 'running'", 60000);
await sleep(500);
check('?clean shows no link', await other.evaluate("!document.querySelector('.pix3-editor-link')"));
check('?scene= boots that scene', (await other.evaluate('window.__PIX3_PLAYER__.scene')) === 'scenes/second.pix3scene');
await other.navigate(`${origin}/?clean&scene=scenes/nope.pix3scene`);
await other.waitFor("window.__PIX3_PLAYER__?.status === 'running'", 60000);
check('an unknown ?scene= falls back to the entry scene', (await other.evaluate('window.__PIX3_PLAYER__.scene')) === 'scenes/main.pix3scene');
// One rendering page at a time: two SwiftShader games in one headless Chrome halve each other.
await browser.send('Target.closeTarget', { targetId: other.targetId });

// 3b. `/?debug`.
const page = await browser.newPage('debug');
await page.navigate(`${origin}/?debug`);
await page.waitFor("window.__PIX3_PLAYER__?.status === 'running' && !!window.__PIX3_PLAYER__.debug", 60000);
await page.waitFor('window.__PIX3_PLAYER__.frames > 60', 30000);
await sleep(1200); // two text windows
const snap = await page.evaluate('window.__PIX3_PLAYER__.debug.snapshot()');
check('/?debug mounts the overlay in a shadow root', await page.evaluate("document.querySelector('.pix3-debug-overlay')?.shadowRoot?.querySelector('.title')?.textContent === 'Pix3 debug'"));
check('snapshot: FPS and the frame split', snap.window.fps > 0 && snap.window.logicMs > 0 && snap.stability.sampleCount > 0, {
  fps: snap.window.fps,
  frameMs: snap.window.frameMs,
  logicMs: snap.window.logicMs,
  renderMs: snap.window.renderMs,
  p95: snap.stability.p95Ms,
});
check('snapshot: renderer counters from a painted frame', snap.renderer && snap.renderer.calls > 0 && snap.renderer.programs > 0, snap.renderer);
const probe = snap.window.activities.find(activity => activity.label === 'Probe busy-wait');
check('snapshot: the FrameProfiler activity, ~1 ms', probe && probe.ms >= 0.9 && probe.ms < 5, probe);
const probeError = snap.errors.recent.find(error => error.message.includes('probe error at frame 30'));
check('snapshot: the script error, with where it happened', probeError && /update/.test(probeError.where ?? '') && /ThrowOnce/.test(probeError.where ?? ''), probeError);
check('snapshot: the game provider', snap.game?.name === 'probe' && snap.game.snapshot.frames > 30, snap.game);
check('snapshot: device', typeof snap.device.gpu === 'string' && snap.device.cores > 0, snap.device);
const panelText = await page.evaluate("document.querySelector('.pix3-debug-overlay').shadowRoot.querySelector('.sections').textContent");
check('panel shows the activity and the error', panelText.includes('Probe busy-wait') && panelText.includes('probe error at frame 30'));

// Pause / Step / Resume through the panel's buttons.
const click = action =>
  page.evaluate(`document.querySelector('.pix3-debug-overlay').shadowRoot.querySelector('[data-action="${action}"]').click()`);
const frameNumber = () => page.evaluate('window.__PIX3_PLAYER__.debug.snapshot().frameNumber');
await click('pause');
await sleep(100);
const pausedAt = await frameNumber();
await sleep(500);
const stillAt = await frameNumber();
check('Pause freezes the game', stillAt === pausedAt && (await page.evaluate('window.__PIX3_PLAYER__.debug.snapshot().paused')), { pausedAt, stillAt });
await click('step');
const stepped = await frameNumber();
check('Step advances exactly one frame', stepped === pausedAt + 1, { pausedAt, stepped });
const pausedLabel = await page.evaluate("document.querySelector('.pix3-debug-overlay').shadowRoot.querySelector('.fps').textContent");
check('header says paused', pausedLabel === 'paused', pausedLabel);
await page.screenshot(join(HERE, 'debug-paused.png'));
await click('pause');
await sleep(500);
const resumedAt = await frameNumber();
check('Resume runs the game again', resumedAt > stepped + 3, { stepped, resumedAt });

await click('collapse');
check('Hide collapses the panel to its header', await page.evaluate("document.querySelector('.pix3-debug-overlay').shadowRoot.querySelector('.panel').classList.contains('collapsed')"));
await click('collapse');
await sleep(600);
await page.screenshot(join(HERE, 'debug-running.png'));
const pageErrors = page.errors.filter(error => !error.text.includes('probe error at frame 30'));
check('no other page errors', pageErrors.length === 0, pageErrors.slice(0, 3));

// 3c. The editor's run modes: Run menu and the toolbar's Play / run options.
await browser.send('Target.closeTarget', { targetId: page.targetId });
const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;
const editor = await browser.newPage('editor');
const openEditorTab = async () => {
  await editor.navigate(`${origin}/__pix3/`);
  await editor.waitFor(`(async () => (!!window.__PIX3_DEBUG__ && !!(await window.__PIX3_DEBUG__.status()).activeScene))()`, 60000);
  await sleep(800);
};
await openEditorTab();
const centerOf = (selector, text = null) =>
  editor.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(selector)}).find(e => ${JSON.stringify(text)} === null || e.textContent.includes(${JSON.stringify(text)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.textContent.trim() }; })()`);
const clickAt = async (selector, text = null) => {
  const at = await centerOf(selector, text);
  if (!at) throw new Error(`nothing matches ${selector} ${text ?? ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await editor.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  return at;
};
const PLAY_BUTTON = '.toolbar-group--play pix3-toolbar-button';
const playLabel = () => editor.evaluate(`(() => { ${DEEP} return deep(document, ${JSON.stringify(PLAY_BUTTON)})[0]?.getAttribute('aria-label') ?? null; })()`);
const pickRunOption = async label => {
  await clickAt('.run-options-dropdown');
  await sleep(300);
  return clickAt('.dropdown__item', label);
};
const waitForPage = async url => {
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const target = targetInfos.find(t => t.type === 'page' && t.url === url);
    if (target) return target;
    await sleep(100);
  }
  return null;
};
const attach = async (target, name) => {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const attached = new (page.constructor)(browser, sessionId, target.targetId, name);
  browser.sessions.set(sessionId, attached);
  await attached.send('Runtime.enable');
  return attached;
};
const status = () => editor.evaluate('window.__PIX3_DEBUG__.status()');
const SCENE_QUERY = 'scene=scenes%2Fmain.pix3scene';

check('Play starts in the Game Tab mode', (await playLabel()) === 'Play (Game Tab)', await playLabel());

await clickAt('.menu-section-button[data-section="run"]');
await sleep(300);
const item = await clickAt('[data-command-id="game.play-in-debug"]');
check('Run menu has Play with Profiler', /Play with Profiler/.test(item.text), item.text);
const debugTarget = await waitForPage(`${origin}/?debug&${SCENE_QUERY}`);
check('Play with Profiler opened <base>?debug&scene=<active scene>', !!debugTarget, debugTarget?.url);
if (debugTarget) {
  const opened = await attach(debugTarget, 'opened-debug');
  await opened.waitFor("window.__PIX3_PLAYER__?.status === 'running' && !!window.__PIX3_PLAYER__.debug", 60000);
  check('the profiler page runs the active scene with the overlay', (await opened.evaluate('window.__PIX3_PLAYER__.scene')) === 'scenes/main.pix3scene');
  check('the overlay has the Editor button', await opened.evaluate("!!document.querySelector('.pix3-debug-overlay').shadowRoot.querySelector('[data-action=\"editor\"]')"));
  await browser.send('Target.closeTarget', { targetId: debugTarget.targetId });
}
check('Play now names the Profiler mode', (await playLabel()) === 'Play (Profiler)', await playLabel());

await pickRunOption('Play in Browser Tab');
const browserTarget = await waitForPage(`${origin}/?${SCENE_QUERY}`);
check('Play in Browser Tab opened <base>?scene=<active scene>', !!browserTarget, browserTarget?.url);
if (browserTarget) {
  const opened = await attach(browserTarget, 'opened-browser');
  await opened.waitFor("window.__PIX3_PLAYER__?.status === 'running'", 60000);
  check('the browser tab has no overlay', await opened.evaluate("!document.querySelector('.pix3-debug-overlay')"));
  await opened.waitFor(`!!${linkRoot}`, 10000).catch(() => null);
  await opened.evaluate(`${linkRoot}.querySelector('[data-action="open"]').click()`);
  await sleep(500);
  await opened.screenshot(join(HERE, 'editor-link.png'));
  await sleep(800);
  check(
    'its editor link sees the open editor and stays on the game',
    (await opened.evaluate(`location.pathname === '/' && ${linkRoot}.querySelector('.note').hidden === false`)) === true
  );
  await browser.send('Target.closeTarget', { targetId: browserTarget.targetId });
}

await openEditorTab();
check('the mode survives a reload', (await playLabel()) === 'Play (Browser Tab)', await playLabel());

await pickRunOption('Play in Game Tab');
await editor.waitFor('(async () => (await window.__PIX3_DEBUG__.status()).play.playing)()', 30000).catch(() => null);
check('Play in Game Tab runs in the editor', (await status()).play.playing === true);
check('the toolbar button is Stop while it runs', (await playLabel()) === 'Stop', await playLabel());
await clickAt(PLAY_BUTTON);
await editor.waitFor('(async () => !(await window.__PIX3_DEBUG__.status()).play.playing)()', 30000).catch(() => null);
check('Stop stops it', (await status()).play.playing === false);
await clickAt(PLAY_BUTTON);
await editor.waitFor('(async () => (await window.__PIX3_DEBUG__.status()).play.playing)()', 30000).catch(() => null);
check('Play runs the last mode (Game Tab) again', (await status()).play.playing === true && (await playLabel()) === 'Stop');
await editor.screenshot(join(HERE, 'editor-playing.png'));
const pageCount = async () => (await browser.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page').length;
const pagesBefore = await pageCount();
await pickRunOption('Play in Game Window');
await sleep(1500);
await editor.waitFor('(async () => (await window.__PIX3_DEBUG__.status()).play.playing)()', 30000).catch(() => null);
check('Play in Game Window opens the window and runs there', (await pageCount()) === pagesBefore + 1 && (await status()).play.playing === true, {
  pagesBefore,
  pagesAfter: await pageCount(),
});
await pickRunOption('Play in Game Tab');
await sleep(1500);
await editor.waitFor('(async () => (await window.__PIX3_DEBUG__.status()).play.playing)()', 30000).catch(() => null);
check('Play in Game Tab closes the window and runs in the tab', (await pageCount()) === pagesBefore && (await status()).play.playing === true, {
  pagesAfter: await pageCount(),
});
check('no editor errors', editor.errors.filter(e => !e.text.includes('probe error')).length === 0, editor.errors.filter(e => !e.text.includes('probe error')).slice(0, 3));
await clickAt('.run-options-dropdown');
await sleep(300);
await editor.screenshot(join(HERE, 'run-options.png'));

browser.close();
await server.close();
cleanup();
if (!KEEP) {
  rmSync(PROJ, { recursive: true, force: true });
  rmSync(PROFILE, { recursive: true, force: true });
}
const passed = results.filter(r => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
