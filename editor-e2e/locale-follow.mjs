// Locale tables follow the disk (pix3-core `.plans/write-model.md` W20), in headless Chrome.
//
// A `pix3 new 2d` project (`proj-locale/`, made here) with locales/en.json + de.json; its own Vite
// on a free port runs this checkout's plugin and editor from dist/ (rebuild editor-core first).
// The Localization panel is opened from the Window menu and driven with real input over CDP; the
// "agent" writes the JSON files with fs and calls `pix3_sync`. Judged by the bytes on disk, the
// panel's inputs and the notices banner. Checks:
//   - an agent's new key shows up in the open panel after pix3_sync, no reload;
//   - an unsaved edit (typed, not committed) of key A, the agent writes key X, the user commits:
//     both on disk — once with the commit racing the agent's write (the editor has not followed
//     yet: its If-Match is refused, the tables merge, the write goes again) and once after the
//     panel followed (the typed text survives the re-render);
//   - the same key: the disk value stays, a notice says so, the editor's table is in the journal
//     (rejected-draft); with the typed text when the panel follows first, a notice too;
//   - a new locale file appears as a target locale, a deleted one disappears.
//
// Usage: node locale-follow.mjs [--core <pix3-core checkout>]
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { freePort, launchChrome } from './cdp.mjs';

const HERE = import.meta.dirname;
const coreFlag = process.argv.indexOf('--core');
const CORE = resolve(coreFlag >= 0 ? process.argv[coreFlag + 1] : join(HERE, '..', '..', 'pix3-core'));
const PROJ = join(HERE, 'proj-locale');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitUntil = async (fn, timeoutMs = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { v, ms: -1 };
    await sleep(50);
  }
};

const table = (locale, strings) => `${JSON.stringify({ $meta: { locale, name: locale.toUpperCase() }, strings, sprites: {} }, null, 2)}\n`;
const disk = locale => JSON.parse(readFileSync(join(PROJ, 'locales', `${locale}.json`), 'utf8')).strings;
const agentWrite = (locale, change) => {
  const strings = { ...disk(locale), ...change };
  writeFileSync(join(PROJ, 'locales', `${locale}.json`), table(locale, strings));
};

// --- project --------------------------------------------------------------------------------------
rmSync(PROJ, { recursive: true, force: true });
spawnSync(process.execPath, [join(CORE, 'packages', 'cli', 'src', 'index.ts'), 'new', '2d', 'proj-locale', '--name', 'locale-e2e'], { cwd: HERE, stdio: 'ignore' });
symlinkSync(join(CORE, 'node_modules'), join(PROJ, 'node_modules'));
writeFileSync(join(PROJ, 'vite.config.ts'), "import { defineConfig } from 'vite';\nimport { pix3 } from '@pix3/vite-plugin';\n\nexport default defineConfig({ plugins: [pix3()], server: { host: '127.0.0.1' }, cacheDir: '.vite-cache' });\n");
spawnSync('mkdir', ['-p', join(PROJ, 'locales')]);
writeFileSync(join(PROJ, 'locales', 'en.json'), table('en', { bye: 'Bye', hello: 'Hello' }));
writeFileSync(join(PROJ, 'locales', 'de.json'), table('de', { bye: 'Tschüss', hello: 'Hallo' }));

// --- Vite + Chrome --------------------------------------------------------------------------------
const vitePort = await freePort();
const vite = spawn(process.execPath, [join(PROJ, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort'], {
  cwd: PROJ,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FORCE_COLOR: '0' },
});
let viteLog = '';
vite.stdout.on('data', d => (viteLog += d));
vite.stderr.on('data', d => (viteLog += d));
process.once('exit', () => vite.kill());
const BASE = `http://127.0.0.1:${vitePort}`;
const up = await waitUntil(async () => {
  try {
    return (await fetch(`${BASE}/__pix3/api/hello`)).ok;
  } catch {
    return false;
  }
}, 30000);
if (!up.v) {
  console.log(viteLog);
  throw new Error('vite did not come up');
}
const profile = join(HERE, 'profile-locale');
rmSync(profile, { recursive: true, force: true });
const { chrome, browser } = await launchChrome(profile, ['--window-size=1600,1000']);

const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;
let page;
const call = (name, params = {}) => page.evaluate(`window.__PIX3_DEBUG__.call(${JSON.stringify(name)}, ${JSON.stringify(params)})`);
const clickAt = async rect => {
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
};
const rectOf = selector => page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(selector)})[0]; if (!el) return null; el.scrollIntoView?.({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const click = async selector => {
  const rect = await rectOf(selector);
  if (!rect) throw new Error(`nothing matches ${selector}`);
  await clickAt(rect);
};
const cell = (key, locale) => `pix3-localization-panel input[aria-label="${key} in ${locale}"]`;
const cellValue = (key, locale) => page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(cell(key, locale))})[0]; return el ? el.value : null; })()`);
const notices = () => page.evaluate(`(() => { ${DEEP} return deep(document, 'pix3-host-banner').map(el => (el.shadowRoot ? el.shadowRoot.textContent : '') + el.textContent).join(' ').replace(/\\s+/g, ' '); })()`);
const targetOptions = () => page.evaluate(`(() => { ${DEEP} return deep(document, 'pix3-localization-panel select option').map(o => o.value); })()`);
const key = async (k, code = k, vk = 13) => {
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk });
};
/** Focus a cell with a real click, select its text and type (not committed). */
const typeInto = async (k, locale, text) => {
  await click(cell(k, locale));
  await page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(cell(k, locale))})[0]; el.focus(); el.select(); })()`);
  await page.send('Input.insertText', { text });
};
const journal = async path => (await (await fetch(`${BASE}/__pix3/api/history?path=${encodeURIComponent(path)}`)).json()).entries ?? [];

try {
  page = await browser.newPage('editor');
  await page.navigate(`${BASE}/__pix3/`);
  await page.waitFor(`!!window.__PIX3_DEBUG__ && window.__PIX3_DEBUG__.call && true`, 60000);
  const ready = await waitUntil(async () => (await call('pix3_status')).activeScene, 60000);
  check('editor mounted', ready.v, ready.v);
  await page.evaluate(`window.__marker = 'never-reloaded'`);

  // Window → Localization, with real clicks.
  await click('.menu-section-button[data-section="window"]');
  await waitUntil(async () => !!(await rectOf('[data-command-id="localization.open-panel"]')), 3000);
  await click('[data-command-id="localization.open-panel"]');
  const opened = await waitUntil(async () => (await cellValue('hello', 'en')) === 'Hello', 8000);
  check('the panel shows the tables on disk', opened.v && (await cellValue('hello', 'de')) === 'Hallo', { en: await cellValue('hello', 'en'), de: await cellValue('hello', 'de') });

  // 1. The agent adds a key; after pix3_sync the open panel has it.
  agentWrite('en', { title: 'Agent title' });
  const synced = await call('pix3_sync', { timeoutMs: 10000 });
  check('an agent key: pix3_sync ok', synced.ok, synced);
  check('…and the open panel shows it (no reload)', (await cellValue('title', 'en')) === 'Agent title', await cellValue('title', 'en'));

  // 2a. Unsaved edit of `hello`, the agent writes `agent1`, the user commits at once (the editor
  // has not seen the agent's version yet: the write's If-Match is refused → merge → write).
  await typeInto('hello', 'en', 'Hello there');
  agentWrite('en', { agent1: 'from the agent' });
  await key('Enter');
  const race = await call('pix3_sync', { timeoutMs: 10000 });
  const d1 = disk('en');
  check('commit racing an agent write: both keys on disk', race.ok && d1.hello === 'Hello there' && d1.agent1 === 'from the agent' && d1.title === 'Agent title', { sync: race.ok, disk: d1 });
  check('…the panel shows both', (await cellValue('hello', 'en')) === 'Hello there' && (await cellValue('agent1', 'en')) === 'from the agent');
  check('…no notice', !/changed on disk/.test(await notices()), await notices());

  // 2b. Unsaved edit of `bye`, the agent writes `agent2`, the panel follows first; the typed text
  // is still in the cell; then the user commits.
  await typeInto('bye', 'en', 'Ciao');
  agentWrite('en', { agent2: 'second agent key' });
  const followed = await waitUntil(async () => (await cellValue('agent2', 'en')) === 'second agent key', 8000);
  check('the panel follows the agent write while a cell is being typed in', followed.v, { ms: followed.ms });
  check('…the typed text survives the re-render', (await cellValue('bye', 'en')) === 'Ciao', await cellValue('bye', 'en'));
  await key('Enter');
  const after = await call('pix3_sync', { timeoutMs: 10000 });
  const d2 = disk('en');
  check('…committed: both on disk', after.ok && d2.bye === 'Ciao' && d2.agent2 === 'second agent key' && d2.hello === 'Hello there', d2);

  // 3a. The same key, racing: the disk value stays, a notice, the journal has the editor table.
  const journalBefore = (await journal('locales/en.json')).filter(e => e.author === 'rejected-draft').length;
  await typeInto('hello', 'en', 'Mine');
  agentWrite('en', { hello: 'Agent hello' });
  await key('Enter');
  await call('pix3_sync', { timeoutMs: 10000 });
  check('same key, racing: the disk keeps the agent value', disk('en').hello === 'Agent hello', disk('en'));
  const n1 = await waitUntil(async () => /locales\/en\.json changed on disk while you were editing it/.test(await notices()), 3000);
  check('…a notice names it', n1.v && /hello/.test(await notices()), await notices());
  check('…the panel shows the disk value', (await cellValue('hello', 'en')) === 'Agent hello', await cellValue('hello', 'en'));
  const journalAfter = (await journal('locales/en.json')).filter(e => e.author === 'rejected-draft');
  check('…the editor table is in the journal (rejected-draft)', journalAfter.length === journalBefore + 1, journalAfter.slice(0, 2));

  // 3b. The same key while typing, the panel follows first: the cell shows the disk, a notice.
  await typeInto('bye', 'en', 'Mine too');
  agentWrite('en', { bye: 'Agent bye' });
  const replaced = await waitUntil(async () => (await cellValue('bye', 'en')) === 'Agent bye', 8000);
  check('same key while typing: the cell shows the disk value', replaced.v, await cellValue('bye', 'en'));
  check('…and a notice says the text was not saved', /"bye" in locales\/en\.json changed on disk while you were typing it/.test(await notices()), await notices());
  await key('Enter');
  await call('pix3_sync', { timeoutMs: 10000 });
  check('…the disk keeps the agent value', disk('en').bye === 'Agent bye', disk('en'));

  // 4. New and deleted locale files.
  writeFileSync(join(PROJ, 'locales', 'fr.json'), table('fr', { hello: 'Bonjour' }));
  await call('pix3_sync', { timeoutMs: 10000 });
  const fr = await waitUntil(async () => (await targetOptions()).includes('fr'), 5000);
  check('a new locale file appears as a target locale', fr.v, await targetOptions());
  rmSync(join(PROJ, 'locales', 'de.json'));
  await call('pix3_sync', { timeoutMs: 10000 });
  const de = await waitUntil(async () => !(await targetOptions()).includes('de'), 5000);
  check('a deleted locale file disappears', de.v, await targetOptions());
  check('the editor never reloaded', (await page.evaluate('window.__marker')) === 'never-reloaded');
  // A refused If-Match is the mechanism under test (the editor merges and writes again).
  const errors = page.errors.filter(e => !/favicon|412 \(Precondition Failed\)/.test(e.text));
  check('no page errors', errors.length === 0, errors.slice(0, 3));
} catch (error) {
  check('run completed', false, String(error?.stack ?? error));
} finally {
  browser.close();
  chrome.kill('SIGKILL');
  vite.kill();
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
