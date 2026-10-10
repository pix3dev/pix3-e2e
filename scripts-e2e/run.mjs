// Scripts and bot policies through Vite, end to end (pix3-core plan §B.2/§B.3, `.plans/scripts-vite.md`).
//
// The project (setup.sh) is made by `pix3 new 2d` outside pix3-core; its Vite dev server runs the
// checkout's plugin and editor from dist/. Headless Chrome on a free CDP port opens /__pix3/; the
// agent's calls go through `__PIX3_DEBUG__.call` (the bridge's inline transport, same table as
// the 3p tools). Checks:
//   - no /@vite/client among the editor page's resources (and pix3_status.viteClient false);
//   - an inspector commit (the Title label) reads back through pix3_scene before any sync: the
//     node's properties, saved and the tree agree with the inspector, and the file gets it;
//   - the placed Mover component becomes an instance of the edited class on sync (config kept,
//     scene clean); a dirty scene keeps its unsaved Speed edit through a swap Vite's re-import
//     triggers, and the next sync writes exactly that edit;
//   - a script and the nested module it imports edited → pix3_sync ok, executed stamps = sha on
//     disk, the inspector shows the new field, the page never reloaded;
//   - bot policies: a run uses the policy; a policy added during play → sync ok (no restart) and a
//     run uses it; its helper outside bots/ (imported only by policies) changed → sync ok during
//     play (S11), the next run sees it; the policy deleted → sync ok, a run refuses it;
//   - autoloads (S10): a Counter declared in pix3project.yaml ticks through a changeScene in the
//     editor's play as one instance (pix3_game_run gameState), a play restart builds a fresh one;
//   - a script deleted (S12): its placed component is parked, the scene stays clean and the file
//     keeps it; the script restored → the component is live again with the file's config;
//   - negative control: a script with a CSS import → `pix3 check` warns W_EDITOR_CSS_IMPORT, the
//     sync answer carries viteClient:true; the same check type-checks the policy written
//     `satisfies BotPolicy` against the kit's design/tests/bots/pix3-test-bot.d.ts.
// Everything started here (Vite, Chrome) is stopped at the end.
//
// Usage: ./setup.sh [<core>] && node run.mjs [--core <pix3-core checkout>]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { freePort, launchChrome } from '../editor-e2e/cdp.mjs';

const HERE = import.meta.dirname;
const coreFlag = process.argv.indexOf('--core');
const CORE = resolve(coreFlag >= 0 ? process.argv[coreFlag + 1] : join(HERE, '..', '..', 'pix3-core'));
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

  // 1b. An inspector commit, read back through pix3_scene before any sync: the node's
  // `properties` and `saved` both carry the new label, and so does the file once flushed.
  await click('[data-node-id="title"]');
  const labelInput = `(() => { ${DEEP} return deep(document, 'pix3-inspector-panel input').find(i => i.value === 'Play'); })()`;
  const hasInput = await waitUntil(async () => page.evaluate(`!!${labelInput}`), 5000);
  check('inspector shows the Title label field', hasInput.v);
  await page.evaluate(`${labelInput}.focus(), ${labelInput}.select()`);
  await page.send('Input.insertText', { text: 'Coins' });
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.evaluate(`document.activeElement?.blur?.()`);
  const committed = await waitUntil(async () => (await call('pix3_status')).dirty?.length > 0 || readFileSync(join(PROJ, 'scenes/main.pix3scene'), 'utf8').includes('label: Coins'), 5000);
  const titleRead = await call('pix3_scene', { nodeId: 'title' });
  check('pix3_scene right after the inspector commit: properties.label is the new one', titleRead.node?.properties?.label === 'Coins', { properties: titleRead.node?.properties, committed: committed.v });
  check('…and saved.properties.label too', titleRead.saved?.properties?.label === 'Coins', titleRead.saved?.properties);
  const titleTree = await call('pix3_scene', { maxDepth: 3 });
  const treeTitle = titleTree.scene?.children?.[0]?.children?.find(c => c.nodeId === 'title');
  check('…and the tree read', treeTitle?.properties?.label === 'Coins', treeTitle?.properties);
  const flushed = await call('pix3_sync', { timeoutMs: 10000 });
  check('the file gets the same label', flushed.ok && /label: Coins/.test(readFileSync(join(PROJ, 'scenes/main.pix3scene'), 'utf8')), flushed);

  // 2. The component's fields come from a nested module.
  await click('[data-node-id="background"]');
  const speed = await waitUntil(async () => (await inspectorText()).includes('Speed'), 5000);
  check('inspector shows the script field from the nested module', speed.v);
  check('the new field is not there yet', !(await inspectorText()).includes('Jump Height'));

  // 3. Edit the script and the nested module it imports, then sync.
  const mover = readFileSync(join(PROJ, 'scripts/Mover.ts'), 'utf8');
  const moverBefore = (await call('pix3_scene', { nodeId: 'background' })).node?.components?.[0];
  check('the live Mover is the first version', moverBefore?.state?.revision === undefined && moverBefore?.state?.config?.speed === 3, moverBefore);
  write('scripts/Mover.ts', mover.replace("label: 'Mover', expanded: true", "label: 'Mover', expanded: true /* v2 */").replace('export class Mover extends Script {', "export class Mover extends Script {\n  readonly revision = 'v2';"));
  write('src/game/fields.ts', "export const FIELDS = [\n  { name: 'speed', label: 'Speed' },\n  { name: 'jumpHeight', label: 'Jump Height' },\n];\n");
  const t0 = Date.now();
  const synced = await syncOk(['scripts/Mover.ts', 'src/game/fields.ts']);
  check('pix3_sync after a script + nested module edit is ok', synced.ok, { ...synced, ms: Date.now() - t0 });
  const stamps = await executed();
  check('executed stamp of the script = sha on disk', stamps['scripts/Mover.ts'] === sha('scripts/Mover.ts'));
  check('executed stamp of the nested module = sha on disk', stamps['src/game/fields.ts'] === sha('src/game/fields.ts'));
  const jump = await waitUntil(async () => (await inspectorText()).includes('Jump Height'), 5000);
  check('inspector shows the new field', jump.v, { ms: jump.ms });
  const moverAfter = (await call('pix3_scene', { nodeId: 'background' })).node?.components?.[0];
  check('the live Mover component is an instance of the edited class, config kept', moverAfter?.state?.revision === 'v2' && moverAfter?.state?.config?.speed === 3 && moverAfter?.state?.id === 'mover', moverAfter);
  const afterSwap = await call('pix3_status');
  check('…the scene stays clean, nothing pending', afterSwap.dirty?.length === 0 && Object.keys(afterSwap.pending ?? {}).length === 0, { dirty: afterSwap.dirty, pending: afterSwap.pending });

  // 3b. A dirty scene through a script swap: an unsaved inspector edit of Speed, then the script
  // changes again and Vite re-imports it (no sync, so nothing flushes first) — the new instance
  // carries the edit, the scene stays dirty, and the next sync writes exactly that edit.
  // Speed is a pix3-number-field (scrub control): a plain click opens its text input.
  const speedField = `(() => { ${DEEP} const group = deep(document, '.script-prop-group')[0]; return group && deep(group, 'pix3-number-field')[0]; })()`;
  await waitUntil(async () => page.evaluate(`!!${speedField}`), 5000);
  // Scrolled into view first: the margin rows (W21) made the inspector taller than the panel.
  const at = await page.evaluate(`(() => { ${speedField}.scrollIntoView({ block: 'center' }); const r = ${speedField}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  const speedInput = `${speedField}.shadowRoot.querySelector('input')`;
  await waitUntil(async () => page.evaluate(`!!${speedInput}`), 3000);
  await page.evaluate(`${speedInput}.focus(), ${speedInput}.select()`);
  await page.send('Input.insertText', { text: '9' });
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const dirtyBefore = (await call('pix3_status')).dirty;
  write('scripts/Mover.ts', readFileSync(join(PROJ, 'scripts/Mover.ts'), 'utf8').replace("readonly revision = 'v2';", "readonly revision = 'v3';"));
  const v3 = await waitUntil(async () => (await call('pix3_scene', { nodeId: 'background' })).node?.components?.[0]?.state?.revision === 'v3', 5000);
  const dirtySwap = await call('pix3_status');
  const moverV3 = (await call('pix3_scene', { nodeId: 'background' })).node?.components?.[0];
  check('a dirty scene: the swap keeps the unsaved edit and the dirty mark', dirtyBefore?.length === 1 && v3.v && moverV3?.state?.config?.speed === 9 && dirtySwap.dirty?.length === 1, { dirtyBefore, ms: v3.ms, config: moverV3?.state?.config, dirty: dirtySwap.dirty, pending: dirtySwap.pending });
  const sceneBeforeFlush = readFileSync(join(PROJ, 'scenes/main.pix3scene'), 'utf8');
  const flushedEdit = await syncOk(['scripts/Mover.ts']);
  const sceneAfterFlush = readFileSync(join(PROJ, 'scenes/main.pix3scene'), 'utf8');
  check('…the next sync writes exactly that edit', flushedEdit.ok && sceneAfterFlush === sceneBeforeFlush.replace('speed: 3', 'speed: 9'), flushedEdit);
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
  const playBefore = await call('pix3_play', { action: 'status' });
  const helperDuringPlay = await syncOk(['design/tests/lib/mark.ts']);
  const playAfter = await call('pix3_play', { action: 'status' });
  check('a helper only policies import, changed during play: sync ok, no restart (S11)', helperDuringPlay.ok === true && playAfter.playing === true && playAfter.startedAt === playBefore.startedAt, { sync: helperDuringPlay, before: playBefore.startedAt, after: playAfter.startedAt });
  check('…helper stamp = sha on disk', (await executed())['design/tests/lib/mark.ts'] === sha('design/tests/lib/mark.ts'));
  const idle2 = await botRun('idle');
  check('a run sees the new helper (mark-v2) in the same play', idle2.ok && JSON.stringify(idle2).includes('idle mark-v2'), idle2.verdict ?? idle2);
  // A game module still waits for play to stop: the Mover's field module.
  write('src/game/fields.ts', readFileSync(join(PROJ, 'src/game/fields.ts'), 'utf8') + '// touched during play\n');
  const gameDuringPlay = await call('pix3_sync', { timeoutMs: 10000 });
  check('a game module changed during play: still stale, playing agent', gameDuringPlay.ok === false && gameDuringPlay.reason === 'stale' && gameDuringPlay.playing === 'agent' && gameDuringPlay.pending?.includes('src/game/fields.ts'), gameDuringPlay);
  const restarted = await call('pix3_play', { action: 'restart' });
  check('agent restarts its play', restarted.ok, restarted);
  const afterRestart = await syncOk(['src/game/fields.ts']);
  check('sync after the restart is ok', afterRestart.ok, afterRestart);

  rmSync(join(PROJ, 'design/tests/bots/rush.ts'));
  const deleted = await call('pix3_sync', { timeoutMs: 10000 });
  check('a policy deleted: sync ok, reported as null', deleted.ok && deleted.changed?.['design/tests/bots/rush.ts'] === null, deleted);
  const gone = await botRun('rush');
  check('a run of the deleted policy is refused', gone.ok === false && /No policy stored/.test(String(gone.detail)), gone);
  const stopped = await call('pix3_play', { action: 'stop' });
  check('agent stops its play', stopped.ok, stopped);
  check('still no reload', (await page.evaluate('window.__marker')) === 'never-reloaded');

  // 4b. A script deleted (S12): its placed component is parked like a fresh load parks it.
  const moverText = readFileSync(join(PROJ, 'scripts/Mover.ts'), 'utf8');
  const sceneBeforeDelete = readFileSync(join(PROJ, 'scenes/main.pix3scene'), 'utf8');
  rmSync(join(PROJ, 'scripts/Mover.ts'));
  const deletedScript = await call('pix3_sync', { timeoutMs: 10000 });
  const parked = await call('pix3_scene', { nodeId: 'background' });
  const statusParked = await call('pix3_status');
  check('a deleted script: sync ok, the placed component is no longer live', deletedScript.ok && parked.node?.nodeId === 'background' && (parked.node?.components ?? []).length === 0, { sync: deletedScript.ok, components: parked.node?.components });
  check('…the scene stays clean and the file keeps the component', statusParked.dirty?.length === 0 && Object.keys(statusParked.pending ?? {}).length === 0 && readFileSync(join(PROJ, 'scenes/main.pix3scene'), 'utf8') === sceneBeforeDelete && /type: user:Mover/.test(sceneBeforeDelete), { dirty: statusParked.dirty, pending: statusParked.pending });
  write('scripts/Mover.ts', moverText);
  const restoredScript = await syncOk(['scripts/Mover.ts']);
  const backWait = await waitUntil(async () => (await call('pix3_scene', { nodeId: 'background' })).node?.components?.[0], 5000);
  const back = backWait.v;
  check('the script restored: the component is live again with the file\'s config', restoredScript.ok && back?.state?.id === 'mover' && back?.state?.config?.speed === 9, { sync: restoredScript, ms: backWait.ms, back, node: (await call('pix3_scene', { nodeId: 'background' })).node, status: await call('pix3_status'), errors: await call('pix3_errors') });

  // 4c. Autoloads in the editor's play (S10): the Counter singleton from pix3project.yaml ticks
  // through the hop scene's changeScene as one instance; a restart builds a fresh one.
  const hopStart = await call('pix3_play', { action: 'start', scenePath: 'res://scenes/hop.pix3scene' });
  check('agent play starts on the hop scene', hopStart.ok, hopStart);
  await sleep(300);
  // Play runs in real time from the start, so the hop (frame 10) may be behind us already: run to a
  // tick count well past it and read which scenes the one singleton has seen.
  const hop = await call('pix3_game_run', { until: [{ kind: 'gameState', path: 'ticks', op: 'gte', value: 60 }], maxFrames: 600, maxWallMs: 15000 });
  const hopState = hop.game?.snapshot;
  check('the autoload counter ticks through changeScene as one instance', hop.ok && /^PASS/.test(String(hop.verdict)) && JSON.stringify(hopState?.scenes) === JSON.stringify(['Hop Root', 'Second Root']) && hopState?.scene === 'Second Root' && hopState?.ticks >= 60, { verdict: hop.verdict, snapshot: hopState });
  const later = await call('pix3_game_run', { until: [{ kind: 'gameState', path: 'ticks', op: 'gte', value: (hopState?.ticks ?? 0) + 30 }], maxFrames: 600, maxWallMs: 15000 });
  check('…and keeps counting in the second scene, same id', later.game?.snapshot?.id === hopState?.id && later.game?.snapshot?.ticks >= (hopState?.ticks ?? 0) + 30 && later.game?.snapshot?.scene === 'Second Root', { verdict: later.verdict, snapshot: later.game?.snapshot });
  const hopRestart = await call('pix3_play', { action: 'restart' });
  await sleep(300);
  const fresh = await call('pix3_game_run', { until: [{ kind: 'gameState', path: 'ticks', op: 'gte', value: 1 }], maxFrames: 60, maxWallMs: 10000 });
  check('a play restart builds a fresh singleton', hopRestart.ok && fresh.game?.snapshot?.id && fresh.game.snapshot.id !== hopState?.id && fresh.game.snapshot.ticks < 30, { restart: hopRestart.ok, snapshot: fresh.game?.snapshot });
  const hopErrors = await call('pix3_errors');
  check('no runtime errors in the autoload plays', !JSON.stringify(hopErrors).includes('Autoload'), hopErrors);
  const hopStopped = await call('pix3_play', { action: 'stop' });
  check('agent stops the hop play', hopStopped.ok, hopStopped);


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
  check('the kit shipped design/tests/bots/pix3-test-bot.d.ts', existsSync(join(PROJ, 'design/tests/bots/pix3-test-bot.d.ts')));
  const typeErrors = report?.diagnostics?.filter(d => d.code === 'E_TYPE') ?? null;
  check('pix3 check type-checks the policy (satisfies BotPolicy) with no E_TYPE', report?.typecheck?.ok === true && typeErrors?.length === 0 && report.files.some(f => f.file === 'design/tests/bots/idle.ts'), { typecheck: report?.typecheck, typeErrors });
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
