// Shared harness for the browser checks: the pix3-core checkout (`--core <dir>` or `$PIX3_CORE`,
// default ../../pix3-core), its plugin and editor from `dist/`, a fresh fixture project copied
// from the scene corpus, Vite on a free port, headless Chrome on a free CDP port (`cdp.mjs`), and
// the async bridge v2 (`await __PIX3_DEBUG__.status()` / `.node()` / `.find()` / `.pending()`).
// Ports are never fixed: another agent runs servers and Chrome on this box too.
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { freePort, launchChrome } from './cdp.mjs';

export const HERE = import.meta.dirname;

/** The pix3-core checkout under test. */
export const resolveCore = () => {
  const flag = process.argv.indexOf('--core');
  return resolve(flag >= 0 ? process.argv[flag + 1] : (process.env.PIX3_CORE ?? join(HERE, '..', '..', 'pix3-core')));
};

/** The plugin from the checkout's `dist/` (rebuild it first; README). */
export const loadPix3 = async core =>
  (await import(pathToFileURL(join(core, 'packages', 'vite-plugin', 'dist', 'index.js')).href)).pix3;

/**
 * A fresh fixture project `dir` from the corpus recipe (`recipe-tapper-2d`, `recipe-grid-3d`, …):
 * the recipe's files, `node_modules` linked to the checkout, a bare `index.html`. Afresh every
 * run — a project an earlier run left behind (a node moved, a file converted) misleads the next.
 */
export const makeProject = (core, recipe, dir) => {
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(core, 'packages', 'runtime', 'fixtures', 'scene-corpus', recipe, 'files'), dir, { recursive: true });
  symlinkSync(join(core, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body><div id="app"></div></body></html>\n');
  return dir;
};

/**
 * Vite + pix3() on `proj`, a free port, its own cache dir (made afresh). A restart of the same
 * server passes the port it had: a tab's IndexedDB (drafts) belongs to the origin, so a reopened
 * tab on another port would never see the draft the closed one checkpointed.
 */
export const startServer = async (core, proj, cacheDir, port = null) => {
  const { createServer } = await import(pathToFileURL(join(core, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
  const pix3 = await loadPix3(core);
  if (port === null) rmSync(cacheDir, { recursive: true, force: true });
  port ??= await freePort();
  const server = await createServer({ configFile: false, root: proj, logLevel: 'warn', cacheDir, plugins: [pix3()], server: { port, strictPort: true, host: '127.0.0.1' } });
  await server.listen();
  return { server, port, base: `http://127.0.0.1:${port}` };
};

/** Headless Chrome with a fresh profile dir. */
export const startChrome = async (profileDir, args = ['--window-size=1600,1000']) => {
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  return launchChrome(profileDir, args);
};

/** An editor tab on `/__pix3/`, mounted with its entry scene (the async bridge answers). */
export const openEditor = async (browser, base, name) => {
  const page = await browser.newPage(name);
  await page.navigate(`${base}/__pix3/`);
  await page.waitFor(`(async () => !!window.__PIX3_DEBUG__ && !!(await window.__PIX3_DEBUG__.status()).activeScene)()`, 60000);
  return page;
};

/** Bridge v2 short forms over CDP: every one awaited in the page. */
export const bridge = page => ({
  call: (name, params = {}) => page.evaluate(`window.__PIX3_DEBUG__.call(${JSON.stringify(name)}, ${JSON.stringify(params)})`),
  status: () => page.evaluate(`window.__PIX3_DEBUG__.status()`),
  node: id => page.evaluate(`window.__PIX3_DEBUG__.node(${JSON.stringify(id)})`),
  find: text => page.evaluate(`window.__PIX3_DEBUG__.find(${JSON.stringify(text)})`),
  pending: () => page.evaluate(`window.__PIX3_DEBUG__.pending()`),
  screen: id => page.evaluate(`window.__PIX3_DEBUG__.screen(${JSON.stringify(id)})`),
  errors: () => page.evaluate(`window.__PIX3_DEBUG__.errors()`),
  sync: options => page.evaluate(`window.__PIX3_DEBUG__.sync(${JSON.stringify(options ?? {})})`),
  play: {
    start: () => page.evaluate(`window.__PIX3_DEBUG__.play.start()`),
    stop: () => page.evaluate(`window.__PIX3_DEBUG__.play.stop()`),
    status: () => page.evaluate(`window.__PIX3_DEBUG__.play.status()`),
  },
});

export const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const waitUntil = async (fn, timeoutMs = 8000, step = 100) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { v, ms: -1 };
    await sleep(step);
  }
};

/** A click at the centre of the first element matching `selector` (through shadow roots). */
export const click = async (page, selector) => {
  const rect = await page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(selector)})[0]; if (!el) return null; el.scrollIntoView?.({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
};

export const key = async (page, keyName, code, vk, modifiers = 0) => {
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
};

/** A check list with a non-zero exit when any check failed. */
export const makeChecks = () => {
  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass: Boolean(pass) });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''}`);
  };
  const finish = () => {
    const failed = results.filter(r => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed > 0 ? 1 : 0);
  };
  return { results, check, finish };
};
