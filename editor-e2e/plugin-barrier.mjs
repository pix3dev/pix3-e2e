// One-off browser check of @pix3/vite-plugin (dist) — plan §B.2/§B.3 in a real Chrome.
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { pix3 } from '/data/igor.gritsenko/projects/pix3-stuff/pix3-core/packages/vite-plugin/dist/index.js';
import { Browser } from './cdp.mjs';

const HERE = import.meta.dirname;
const PROJ = join(HERE, 'proj');
const CHROME = '/data/igor.gritsenko/projects/pix3-stuff/pix3-core-spikes/chrome.sh';
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const write = (p, s) => writeFileSync(join(PROJ, p), s);

let watcherDelayMs = 0;
const server = await createServer({
  configFile: false, root: PROJ, logLevel: 'warn', cacheDir: join(HERE, '.vite-cache'),
  plugins: [pix3()], server: { port: 5291, strictPort: true, host: '127.0.0.1' },
});
const emit = server.watcher.emit.bind(server.watcher);
server.watcher.emit = (event, ...args) => {
  if (watcherDelayMs > 0 && ['change', 'add', 'unlink'].includes(event)) { setTimeout(() => emit(event, ...args), watcherDelayMs); return true; }
  return emit(event, ...args);
};
await server.listen();
const BASE = 'http://127.0.0.1:5291';

mkdirSync(join(HERE, 'profile'), { recursive: true });
const chrome = spawn(CHROME, ['--remote-debugging-port=9361', `--user-data-dir=${join(HERE, 'profile')}`, 'about:blank'], { stdio: 'ignore' });
let browser;
try {
  browser = await Browser.connect(9361);
  const editor = await browser.newPage('editor');
  const t0 = Date.now();
  await editor.navigate(`${BASE}/__pix3/`);
  await editor.waitFor(`document.getElementById('pix3-editor')?.dataset.tabId`);
  check('editor host connected', true, { ms: Date.now() - t0 });
  await editor.evaluate(`window.__marker = 'first-load'`);
  const viteClient = await editor.evaluate(`performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('@vite/client'))`);
  check('no /@vite/client on the editor page', viteClient.length === 0, viteClient);
  const claim = await editor.evaluate(`window.__PIX3_HOST__.claim()`);
  check('tab claims writer', claim.writerId === (await editor.evaluate(`window.__PIX3_HOST__.tabId`)));
  const probe = `window.__PIX3_HOST__.currentRoots.editorScripts.modules['/scripts/probe.ts']?.value`;
  check('editor executed probe chain', (await editor.evaluate(probe)) === 'leaf-0', await editor.evaluate(probe));

  const game = await browser.newPage('game');
  await game.navigate(`${BASE}/`);
  await game.waitFor(`document.title === 'leaf-0'`);
  check('game tab runs the same chain', true);

  // Watcher path: a plain edit reaches the editor through pix3:scripts, without a reload.
  let t = Date.now();
  write('scripts/leaf.ts', `export const value = 'leaf-1';\n`);
  await editor.waitFor(`${probe} === 'leaf-1'`, 5000);
  check('plain edit reaches the editor (watcher path)', true, { ms: Date.now() - t });
  await game.waitFor(`document.title === 'leaf-1'`, 5000);
  check('game tab got the edit too', true);

  // S1 counter-example: watcher delayed 2 s, sync right after the write.
  watcherDelayMs = 2000;
  write('scripts/leaf.ts', `export const value = 'leaf-2';\n`);
  t = Date.now();
  const sync = await editor.evaluate(`window.__PIX3_HOST__.sync({ timeoutMs: 5000 })`);
  const syncMs = Date.now() - t;
  check('sync ok with the watcher 2 s late', sync.ok === true, { ok: sync.ok, reason: sync.reason, paths: sync.paths, ms: syncMs, changed: Object.keys(sync.changed ?? {}) });
  check('executed leaf is new at the moment sync answers', (await editor.evaluate(probe)) === 'leaf-2', await editor.evaluate(probe));
  const stamp = await editor.evaluate(`globalThis.__pix3Executed['scripts/leaf.ts']`);
  check('executed stamp equals sync changed sha', stamp === sync.changed?.['scripts/leaf.ts'], stamp?.slice(0, 12));
  await sleep(2600); // let the delayed watcher event fire; it must not propagate again
  check('editor still on its first load after the late watcher event', (await editor.evaluate(`window.__marker`)) === 'first-load');

  // add + sync, unlink + sync
  write('scripts/Extra.ts', `export const extra = 'x';\n`);
  const added = await editor.evaluate(`window.__PIX3_HOST__.sync({ timeoutMs: 5000 })`);
  const hasExtra = await editor.evaluate(`'/scripts/Extra.ts' in window.__PIX3_HOST__.currentRoots.editorScripts.modules`);
  check('added script is registered by sync', added.ok && hasExtra, { ok: added.ok, reason: added.reason, hasExtra });
  unlinkSync(join(PROJ, 'scripts/Extra.ts'));
  const removed = await editor.evaluate(`window.__PIX3_HOST__.sync({ timeoutMs: 5000 })`);
  const stillExtra = await editor.evaluate(`'/scripts/Extra.ts' in window.__PIX3_HOST__.currentRoots.editorScripts.modules`);
  check('removed script is gone after sync', removed.ok && !stillExtra, { ok: removed.ok, reason: removed.reason, stillExtra });
  watcherDelayMs = 0;

  // expect mismatch from the page
  const mismatch = await editor.evaluate(`window.__PIX3_HOST__.sync({ expect: { 'scenes/main.pix3scene': '${'0'.repeat(64)}' } })`);
  check('page sync reports expect mismatch', mismatch.ok === false && mismatch.reason === 'expect_mismatch', mismatch.reason);

  await sleep(500);
  check('editor never reloaded', (await editor.evaluate(`window.__marker`)) === 'first-load' && editor.navigations.length === 1, { navigations: editor.navigations.length });
  check('no errors on the editor page', editor.errors.length === 0, editor.errors.slice(0, 5));
  const viteClientEnd = await editor.evaluate(`performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('@vite/client'))`);
  check('still no /@vite/client at the end', viteClientEnd.length === 0);
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  browser?.close();
  chrome.kill();
  await server.close();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
