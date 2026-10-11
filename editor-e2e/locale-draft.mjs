// W22 (pix3-core `.plans/write-model.md`): a locale edit whose write got no answer survives the tab
// in an IndexedDB draft — the locale-table counterpart of the scene's N9 row. Headless Chrome, real
// input over CDP, judged by the bytes on disk, IndexedDB, the notices banner and the panel:
//   the dev server is stopped → a cell is edited and committed (the write fails) → a draft for
//   locales/en.json is in IndexedDB, nothing on disk → the tab closes → the server comes back →
//   a new tab offers the draft → "Restore" writes it → the panel shows it.
//
// Usage: node locale-draft.mjs   (PIX3_CDP_PROXY=1 to run through the CDP token proxy)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { pathToFileURL } from 'node:url';
import { freePort, launchChrome } from './cdp.mjs';

const HERE = import.meta.dirname;
// The checkout under test: `--core <dir>` or $PIX3_CORE (default ../../pix3-core); plugin and
// editor come from its dist/.
const coreFlag = process.argv.indexOf('--core');
const CORE = coreFlag >= 0 ? resolve(process.argv[coreFlag + 1]) : (process.env.PIX3_CORE ?? join(HERE, '../../pix3-core'));
const { pix3 } = await import(pathToFileURL(join(CORE, 'packages/vite-plugin/dist/index.js')).href);
const PROJ = join(HERE, 'proj-locale-draft');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitUntil = async (fn, timeoutMs = 8000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { v, ms: -1 };
    await sleep(step);
  }
};
const table = (locale, strings) => `${JSON.stringify({ $meta: { locale, name: locale.toUpperCase() }, strings, sprites: {} }, null, 2)}\n`;
const EN = join(PROJ, 'locales', 'en.json');
const disk = () => JSON.parse(readFileSync(EN, 'utf8')).strings;
const sha = () => createHash('sha256').update(readFileSync(EN)).digest('hex');

// --- project / server / browser ------------------------------------------------------------------
for (const dir of [PROJ, join(HERE, '.vite-cache-locale-draft'), join(HERE, 'profile-locale-draft')]) rmSync(dir, { recursive: true, force: true });
mkdirSync(join(PROJ, 'scenes'), { recursive: true });
mkdirSync(join(PROJ, 'locales'), { recursive: true });
writeFileSync(join(PROJ, 'pix3project.yaml'), 'version: 1.0.0\nprojectType: 2d\nviewportBaseSize:\n  width: 1920\n  height: 1080\ndefaultExportScenePath: scenes/main.pix3scene\nmetadata:\n  projectId: locale-draft-e2e\n');
writeFileSync(join(PROJ, 'index.html'), '<!doctype html><html><body><div id="app"></div></body></html>\n');
writeFileSync(join(PROJ, 'scenes/main.pix3scene'), 'version: 1.0.0\nroot:\n  - id: game-root\n    type: Group2D\n    name: Game Root\n    properties:\n      width: 1920\n      height: 1080\n');
writeFileSync(EN, table('en', { bye: 'Bye', hello: 'Hello' }));
symlinkSync(join(CORE, 'node_modules'), join(PROJ, 'node_modules'));
mkdirSync(join(HERE, 'profile-locale-draft'), { recursive: true });
let server = null;
const startServer = async () => {
  server = await createServer({ configFile: false, root: PROJ, logLevel: 'warn', cacheDir: join(HERE, '.vite-cache-locale-draft'), plugins: [pix3()], server: { port: PORT, strictPort: true, host: '127.0.0.1' } });
  await server.listen();
};
await startServer();
const { chrome, browser } = await launchChrome(join(HERE, 'profile-locale-draft'), ['--window-size=1600,1000']);

const openEditor = async name => {
  const page = await browser.newPage(name);
  await page.navigate(`${BASE}/__pix3/`);
  await page.waitFor(`(async () => (!!window.__PIX3_DEBUG__ && !!(await window.__PIX3_DEBUG__.status()).activeScene))()`, 60000);
  await sleep(800);
  return page;
};
const closePage = page => browser.send('Target.closeTarget', { targetId: page.targetId });
const rectOf = (page, selector) => page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(selector)})[0]; if (!el) return null; el.scrollIntoView?.({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const click = async (page, selector) => {
  const rect = await rectOf(page, selector);
  if (!rect) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
};
const key = async (page, k, code = k, vk = 13) => {
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk });
};
const cell = (k, locale) => `pix3-localization-panel input[aria-label="${k} in ${locale}"]`;
const cellValue = (page, k, locale) => page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(cell(k, locale))})[0]; return el ? el.value : null; })()`);
const notices = page => page.evaluate(`(() => { ${DEEP} return deep(document, '[data-notice-id]').map(n => n.textContent.replace(/\\s+/g, ' ').trim()); })()`);
const openPanel = async page => {
  await click(page, '.menu-section-button[data-section="window"]');
  await waitUntil(async () => !!(await rectOf(page, '[data-command-id="localization.open-panel"]')), 3000);
  await click(page, '[data-command-id="localization.open-panel"]');
  return waitUntil(async () => (await cellValue(page, 'hello', 'en')) === 'Hello', 8000);
};
const typeInto = async (page, k, locale, text) => {
  await click(page, cell(k, locale));
  await page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(cell(k, locale))})[0]; el.focus(); el.select(); })()`);
  await page.send('Input.insertText', { text });
};
const draftsInDb = page => page.evaluate(`new Promise(r => { const q = indexedDB.open('pix3-drafts'); q.onsuccess = () => { try { const tx = q.result.transaction('drafts', 'readonly'); const g = tx.objectStore('drafts').getAll(); g.onsuccess = () => r(g.result.map(d => ({ path: d.path, baselineSha: d.baselineSha, text: d.text }))); g.onerror = () => r([]); } catch { r([]); } }; q.onerror = () => r(null); })`);

let pageA = null, pageB = null;
try {
  pageA = await openEditor('A');
  const opened = await openPanel(pageA);
  check('the panel shows the table on disk', opened.v, { hello: await cellValue(pageA, 'hello', 'en') });
  const diskSha = sha();
  const before = disk();

  // The dev server dies; the user commits an edit: the write gets no answer.
  await server.close();
  server = null;
  await sleep(500);
  await typeInto(pageA, 'hello', 'en', 'Hello draft');
  await key(pageA, 'Enter');
  const drafted = await waitUntil(async () => { const d = await draftsInDb(pageA); return Array.isArray(d) && d.some(x => x.path === 'locales/en.json' && /Hello draft/.test(x.text)) ? d : null; }, 8000);
  check('server down: the edit is in an IndexedDB draft for locales/en.json', !!drafted.v, drafted.v);
  check('…made against the disk version the editor read', Array.isArray(drafted.v) && drafted.v.find(x => x.path === 'locales/en.json')?.baselineSha === diskSha, { diskSha });
  check('…and the disk is untouched', JSON.stringify(disk()) === JSON.stringify(before), disk());
  check('…the panel keeps the edit in memory', (await cellValue(pageA, 'hello', 'en')) === 'Hello draft');

  // The tab closes, the server comes back, a new tab offers the draft.
  await closePage(pageA); pageA = null;
  await startServer();
  pageB = await openEditor('B');
  const offered = await waitUntil(async () => (await notices(pageB)).some(n => /Unsaved edits to locales\/en\.json/.test(n)), 8000);
  check('reopened: the editor offers the locale draft', offered.v, await notices(pageB));
  check('…before Restore the disk still has the old value', disk().hello === 'Hello');
  await click(pageB, '[data-notice-id] .host-banner__action');
  const restored = await waitUntil(() => disk().hello === 'Hello draft', 5000);
  check('"Restore" writes the draft to disk', restored.v, { ms: restored.ms, disk: disk() });
  const gone = await waitUntil(async () => { const d = await draftsInDb(pageB); return Array.isArray(d) && !d.some(x => x.path === 'locales/en.json'); }, 3000);
  check('…and the draft is dropped', gone.v);
  const panel = await openPanel(pageB);
  check('…the panel shows the restored value', (await cellValue(pageB, 'hello', 'en')) === 'Hello draft' || (!panel.v && false), { hello: await cellValue(pageB, 'hello', 'en') });
  // A failed-fetch is the mechanism under test; nothing else may error.
  const errors = pageB.errors.filter(e => !/Failed to fetch|ERR_CONNECTION|favicon/.test(e.text));
  check('no page errors', errors.length === 0, errors.slice(0, 3));
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  browser.close();
  chrome.kill();
  await server?.close();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
