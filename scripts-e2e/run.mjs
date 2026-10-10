// Scripts and bot policies through Vite, end to end (pix3-core plan §B.2/§B.3, `.plans/scripts-vite.md`).
//
// The project (setup.sh) is made by `pix3 new 2d` outside pix3-core; its Vite dev server runs the
// checkout's plugin and editor from dist/. Headless Chrome on a free CDP port opens /__pix3/; the
// agent's calls go through `__PIX3_DEBUG__.call` (the bridge's inline transport, same table as
// the 3p tools). Checks:
//   - no /@vite/client among the editor page's resources (and pix3_status.viteClient false);
//   - a script and the nested module it imports edited → pix3_sync ok, executed stamps = sha on
//     disk, the inspector shows the new field, the page never reloaded;
//   - bot policies: a run uses the policy; a policy added during play → sync ok (no restart) and a
//     run uses it; its helper outside bots/ changed → stale until restart, then the run sees it;
//     the policy deleted → sync ok, a run refuses it;
//   - negative control: a script with a CSS import → `pix3 check` warns W_EDITOR_CSS_IMPORT, the
//     sync answer carries viteClient:true.
// Everything started here (Vite, Chrome) is stopped at the end.
//
// Usage: ./setup.sh [<core>] && node run.mjs [--core <pix3-core checkout>]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { freePort, launchChrome } from '../editor-e2e/cdp.mjs';

const HERE = import.meta.dirname;
const coreFlag = process.argv.indexOf('--core');
const CORE = resolve(coreFlag >= 0 ? process.argv[coreFlag + 1] : join(HERE, '..', '..', 'pix3-core-scripts'));
const PROJ = join(HERE, 'proj');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''}`);
};
const sha = path => createHash('sha256').update(readFileSync(join(PROJ, path))).digest('hex');
const write = (path, text) => {
  mkdirSync(join(PROJ, path, '..'), { recursive: true });
  writeFileSync(join(PROJ, path), text);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitUntil = async (fn, timeoutMs = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { v, ms: -1 };
    await sleep(100);
  }
};

// --- Vite ---------------------------------------------------------------------------------------
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

const profile = join(HERE, 'profile');
rmSync(profile, { recursive: true, force: true });
const { chrome, browser, port: cdpPort } = await launchChrome(profile, ['--window-size=1600,1000']);
console.log(`vite :${vitePort}, chrome cdp :${cdpPort}`);

const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;
let page;
const call = (name, params = {}) => page.evaluate(`window.__PIX3_DEBUG__.call(${JSON.stringify(name)}, ${JSON.stringify(params)})`);
const click = async selector => {
  const rect = await page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(selector)})[0]; if (!el) return null; el.scrollIntoView?.(); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
};
const inspectorText = () => page.evaluate(`(() => { ${DEEP} return deep(document, 'pix3-inspector-panel').map(el => (el.shadowRoot ? el.shadowRoot.textContent : '') + el.textContent).join(' '); })()`);
const syncOk = async (expectPaths, tries = 5) => {
  let answer;
  for (let i = 0; i < tries; i++) {
    const expect = Object.fromEntries(expectPaths.map(p => [p, sha(p)]));
    answer = await call('pix3_sync', { expect, timeoutMs: 10000 });
    if (answer.ok || !['stale_modules', 'gesture_in_progress'].includes(answer.reason)) return answer;
    await sleep(200);
  }
  return answer;
};
const executed = () => page.evaluate('({ ...(globalThis.__pix3Executed ?? {}) })');
const UNTIL_NEVER = [{ kind: 'nodeGone', name: 'Background' }];
const botRun = name => call('pix3_game_run', { bot: { name }, until: UNTIL_NEVER, maxFrames: 120, maxWallMs: 15000 });

try {
  page = await browser.newPage('editor');
  await page.send('Network.enable');
  await page.navigate(`${BASE}/__pix3/`);
  await page.waitFor(`!!window.__PIX3_DEBUG__ && window.__PIX3_DEBUG__.call && true`, 60000);
  const ready = await waitUntil(async () => (await call('pix3_status')).activeScene, 60000);
  check('editor mounted with the entry scene', ready.v, ready.v);
  await page.evaluate(`window.__marker = 'never-reloaded'`);
  const navigationsAtStart = page.navigations.length;

  // 1. Contract B at load.
  const resources = await page.evaluate(`performance.getEntriesByType('resource').map(e => new URL(e.name).pathname)`);
  check('/@vite/client is not among the editor page resources', !resources.some(p => p.endsWith('/@vite/client')), { resources: resources.length });
  check('every editor-chain module came from this server', resources.length > 10);
  const status0 = await call('pix3_status');
  check('pix3_status.viteClient is false', status0.viteClient === false, { viteClient: status0.viteClient, scriptsStatus: status0.scriptsStatus });

  // 2. The component's fields come from a nested module.
  await click('[data-node-id="background"]');
  const speed = await waitUntil(async () => (await inspectorText()).includes('Speed'), 5000);
  check('inspector shows the script field from the nested module', speed.v);
  check('the new field is not there yet', !(await inspectorText()).includes('Jump Height'));

  // 3. Edit the script and the nested module it imports, then sync.
  const mover = readFileSync(join(PROJ, 'scripts/Mover.ts'), 'utf8');
  write('scripts/Mover.ts', mover.replace("label: 'Mover', expanded: true", "label: 'Mover', expanded: true /* v2 */"));
  write('src/game/fields.ts', "export const FIELDS = [\n  { name: 'speed', label: 'Speed' },\n  { name: 'jumpHeight', label: 'Jump Height' },\n];\n");
  const t0 = Date.now();
  const synced = await syncOk(['scripts/Mover.ts', 'src/game/fields.ts']);
  check('pix3_sync after a script + nested module edit is ok', synced.ok, { ...synced, ms: Date.now() - t0 });
  const stamps = await executed();
  check('executed stamp of the script = sha on disk', stamps['scripts/Mover.ts'] === sha('scripts/Mover.ts'));
  check('executed stamp of the nested module = sha on disk', stamps['src/game/fields.ts'] === sha('src/game/fields.ts'));
  const jump = await waitUntil(async () => (await inspectorText()).includes('Jump Height'), 5000);
  check('inspector shows the new field', jump.v, { ms: jump.ms });
  check('the editor did not reload', (await page.evaluate('window.__marker')) === 'never-reloaded' && page.navigations.length === navigationsAtStart, page.navigations);

  // 4. Bot policies.
  const started = await call('pix3_play', { action: 'start' });
  check('agent play starts', started.ok, started);
  await sleep(500);
  const idle = await botRun('idle');
  const idleText = JSON.stringify(idle);
  check('a run uses the stored policy (idle, mark-v1)', idle.ok && idleText.includes('idle mark-v1'), idle.verdict ?? idle);

  write('design/tests/bots/rush.ts', "export default {\n  name: 'rush',\n  tick(bot: { frame: number; log(e: string): void; done(p: boolean, r: string): void }) {\n    bot.log('rush here');\n    if (bot.frame >= 2) bot.done(true, 'rush here');\n  },\n};\n");
  const added = await syncOk(['design/tests/bots/rush.ts']);
  check('a policy added during play: sync ok without a restart', added.ok, added);
  check('…with its executed stamp', (await executed())['design/tests/bots/rush.ts'] === sha('design/tests/bots/rush.ts'));
  const rush = await botRun('rush');
  check('a run uses the added policy', rush.ok && JSON.stringify(rush).includes('rush here'), rush.verdict ?? rush);

  write('design/tests/lib/mark.ts', "export const MARK = 'mark-v2';\n");
  const helperDuringPlay = await call('pix3_sync', { timeoutMs: 10000 });
  check('a helper outside bots/ changed during play: stale, playing agent', helperDuringPlay.ok === false && helperDuringPlay.reason === 'stale' && helperDuringPlay.playing === 'agent', helperDuringPlay);
  const restarted = await call('pix3_play', { action: 'restart' });
  check('agent restarts its play', restarted.ok, restarted);
  const afterRestart = await syncOk(['design/tests/lib/mark.ts']);
  check('sync after the restart is ok', afterRestart.ok, afterRestart);
  check('…helper stamp = sha on disk', (await executed())['design/tests/lib/mark.ts'] === sha('design/tests/lib/mark.ts'));
  await sleep(500);
  const idle2 = await botRun('idle');
  check('a run sees the new helper (mark-v2)', idle2.ok && JSON.stringify(idle2).includes('idle mark-v2'), idle2.verdict ?? idle2);

  rmSync(join(PROJ, 'design/tests/bots/rush.ts'));
  const deleted = await call('pix3_sync', { timeoutMs: 10000 });
  check('a policy deleted: sync ok, reported as null', deleted.ok && deleted.changed?.['design/tests/bots/rush.ts'] === null, deleted);
  const gone = await botRun('rush');
  check('a run of the deleted policy is refused', gone.ok === false && /No policy stored/.test(String(gone.detail)), gone);
  const stopped = await call('pix3_play', { action: 'stop' });
  check('agent stops its play', stopped.ok, stopped);
  check('still no reload', (await page.evaluate('window.__marker')) === 'never-reloaded');

  // 5. Negative control: contract B broken on purpose.
  write('scripts/Styled.ts', "import './styled.css';\nexport const styled = 1;\n");
  write('scripts/styled.css', '.x { color: red; }\n');
  const checked = spawnSync(process.execPath, [join(CORE, 'packages', 'cli', 'src', 'index.ts'), 'check', '--json', '--no-sync', '--no-hydrate'], { cwd: PROJ, encoding: 'utf8' });
  let report = null;
  try {
    report = JSON.parse(checked.stdout);
  } catch {
    // printed below
  }
  const cssWarn = report?.diagnostics?.find(d => d.code === 'W_EDITOR_CSS_IMPORT');
  check('pix3 check warns W_EDITOR_CSS_IMPORT for scripts/Styled.ts', cssWarn?.file === 'scripts/Styled.ts' && cssWarn.line === 1, cssWarn ?? checked.stderr.slice(0, 400));
  const broken = await syncOk(['scripts/Styled.ts']);
  check('the sync answer carries viteClient: true', broken.viteClient === true && /pix3 check/.test(String(broken.warning)), broken);
  check('pix3_status.viteClient turns true', (await call('pix3_status')).viteClient === true);
  rmSync(join(PROJ, 'scripts/Styled.ts'));
  rmSync(join(PROJ, 'scripts/styled.css'));

  const pageErrors = page.errors.filter(e => !/vite\/client|\[pix3\] \/@vite/.test(e.text));
  check('no page errors (besides the negative control)', pageErrors.length === 0, pageErrors.slice(0, 5));
} catch (error) {
  check('run completed', false, String(error?.stack ?? error));
} finally {
  browser.close();
  chrome.kill('SIGKILL');
  vite.kill();
  // Restore the project for the next run.
  spawnSync('bash', [join(HERE, 'setup.sh'), CORE], { stdio: 'ignore' });
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
