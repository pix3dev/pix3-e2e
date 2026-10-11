// Gate P1 of ../pix3/.plans/pix3-core.md §G.2 ("до dogfood"), the rows a browser can prove:
// drag / idle / Esc / continuous edits / N10 / N8 / Ctrl+Z / external same key / two tabs /
// close → reopen / N9 draft. Real input over CDP; judged by state (bridge, DOM, bytes on disk,
// network) — AGENTS.md rule 10. Plugin-level rows (N6 kill between renames, N4) are specs.
// `PIX3_CDP_PROXY=1` runs it through the P2 CDP token proxy (cdp.mjs `launchBehindProxy`).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { pathToFileURL } from 'node:url';
import { freePort, launchChrome } from './cdp.mjs';

const HERE = import.meta.dirname;
const PROJ = join(HERE, 'proj');
// A free port, never a fixed one: another agent runs servers and Chrome on this box too.
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const SCENE = join(PROJ, 'scenes/main.pix3scene');
const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const disk = () => readFileSync(SCENE, 'utf8');
const comments = text => text.split('\n').filter(l => /(^|\s)#/.test(l)).map(l => l.slice(l.indexOf('#')).trim());
const changedLines = (a, b) => {
  const x = a.split('\n'), y = b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return x.length + y.length - 2 * dp[0][0];
};
const waitUntil = async (fn, timeoutMs = 8000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { v, ms: -1 };
    await sleep(step);
  }
};

// --- server / browser ---------------------------------------------------------------------------
let server = null;
const startServer = async () => {
  server = await createServer({ configFile: false, root: PROJ, logLevel: 'warn', cacheDir: join(HERE, '.vite-cache-gate'), plugins: [pix3()], server: { port: PORT, strictPort: true, host: '127.0.0.1' } });
  await server.listen();
};
// A fresh fixture, Vite cache and profile every run: the gate starts from the recipe's bytes with
// the node at the press point. A `proj/` an earlier run left behind (the node moved, Board renamed)
// made the first press miss the node — no drag, then NaN coordinates ("Invalid parameters").
// The checkout under test: `--core <dir>` or $PIX3_CORE (default ../../pix3-core); plugin and
// editor come from its dist/.
const coreFlag = process.argv.indexOf('--core');
const CORE = coreFlag >= 0 ? resolve(process.argv[coreFlag + 1]) : (process.env.PIX3_CORE ?? join(HERE, '../../pix3-core'));
const { pix3 } = await import(pathToFileURL(join(CORE, 'packages/vite-plugin/dist/index.js')).href);
for (const dir of [PROJ, join(HERE, '.vite-cache-gate'), join(HERE, 'profile-gate')]) rmSync(dir, { recursive: true, force: true });
cpSync(join(CORE, 'packages/runtime/fixtures/scene-corpus/recipe-tapper-2d/files'), PROJ, { recursive: true });
symlinkSync(join(CORE, 'node_modules'), join(PROJ, 'node_modules'));
writeFileSync(join(PROJ, 'index.html'), '<!doctype html><html><body><div id="app"></div></body></html>\n');
mkdirSync(join(HERE, 'profile-gate'), { recursive: true });
await startServer();
const { chrome, browser } = await launchChrome(join(HERE, 'profile-gate'), ['--window-size=1600,1000']);

/** An editor tab with its write log: every PUT/changeset request and every 412 answer. */
const openEditor = async name => {
  const page = await browser.newPage(name);
  page.writes = [];
  page.refused = [];
  page.reqs = new Map();
  await page.send('Network.enable');
  const onEvent = page.onEvent.bind(page);
  page.onEvent = (method, params) => {
    onEvent(method, params);
    if (method === 'Network.requestWillBeSent') {
      const { url, method: verb } = params.request;
      if ((verb === 'PUT' && /\/__pix3\/api\/file/.test(url)) || (verb === 'POST' && /\/__pix3\/api\/changeset/.test(url))) page.writes.push({ at: Date.now(), verb, url });
    }
    if (method === 'Network.responseReceived' && params.response.status === 412) page.refused.push(params.response.url);
    if (method === 'Network.requestWillBeSent' && /__pix3\/api\/(file|changeset)/.test(params.request.url) && params.request.method !== 'GET' && params.request.method !== 'HEAD') page.reqs.set(params.requestId, { at: Date.now(), verb: params.request.method, status: null });
    if (method === 'Network.responseReceived' && page.reqs.has(params.requestId)) page.reqs.get(params.requestId).status = params.response.status;
    if (method === 'Network.loadingFailed' && page.reqs.has(params.requestId)) page.reqs.get(params.requestId).status = 'failed:' + params.errorText;
  };
  await page.navigate(`${BASE}/__pix3/`);
  await page.waitFor(`(async () => (!!window.__PIX3_DEBUG__ && !!(await window.__PIX3_DEBUG__.status()).activeScene))()`, 60000);
  await sleep(800);
  return page;
};
const closePage = page => browser.send('Target.closeTarget', { targetId: page.targetId });

// --- input --------------------------------------------------------------------------------------
const click = async (page, selector) => {
  const rect = await page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(selector)})[0]; if (!el) return null; el.scrollIntoView?.({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
};
const key = async (page, keyName, code, vk, modifiers = 0) => {
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
};
const blur = page => page.evaluate(`(() => { ${DEEP} for (const el of deep(document, 'input, textarea')) el.blur(); document.activeElement?.blur?.(); return true; })()`);
const ctrl = (page, letter) => key(page, letter, `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0), 2);
const canvasRect = page => page.evaluate(`(() => { ${DEEP} const c = deep(document, 'canvas.viewport-canvas')[0]; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const pos = async (page, id) => (await page.evaluate(`(async () => ((await window.__PIX3_DEBUG__.node(${JSON.stringify(id)}))?.transform?.position ?? null))()`));
const NODE = 'board-floor';
/** Screen px per world unit, measured on the first drag (the move follows the pointer 1:1). */
let pxPerWorld = null;
let origin = null; // the node's position when the press point was chosen

/** Select NODE in the tree, then press on it in the viewport and drag. Returns the press/release times. */
const drag = async (page, { dx = 80, dy = -40, steps = 30, stepMs = 50, escape = false } = {}) => {
  await click(page, `[data-node-id="${NODE}"]`);
  await sleep(250);
  await blur(page);
  const c = await canvasRect(page);
  // The press must land on the node wherever earlier drags left it (Y is up in the world).
  const p = await pos(page, NODE);
  origin ??= p;
  const shiftX = pxPerWorld ? (p.x - origin.x) * pxPerWorld : 0;
  const shiftY = pxPerWorld ? -(p.y - origin.y) * pxPerWorld : 0;
  const x0 = c.x + c.w * 0.3 + shiftX, y0 = c.y + c.h * 0.7 + shiftY;
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
  // The drag (and the gesture the write model waits out) starts once the pointer has moved past
  // the editor's 5 px threshold; before that a press is a click.
  let t0 = null;
  for (let i = 1; i <= steps; i++) {
    const mx = (dx * i) / steps, my = (dy * i) / steps;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + mx, y: y0 + my, button: 'left', buttons: 1 });
    if (t0 === null && Math.hypot(mx, my) > 5) t0 = Date.now();
    await sleep(stepMs);
  }
  t0 ??= Date.now();
  if (escape) await key(page, 'Escape', 'Escape', 27);
  const t1 = Date.now();
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + dx, y: y0 + dy, button: 'left', buttons: 0, clickCount: 1 });
  return { t0, t1 };
};
const rename = async (page, nodeId, text) => {
  await click(page, `[data-node-id="${nodeId}"]`);
  await sleep(250);
  const input = `(() => { ${DEEP} return deep(document, 'pix3-inspector-panel input[type=text]')[0]; })()`;
  await page.evaluate(`${input}.focus(), ${input}.select()`);
  await page.send('Input.insertText', { text });
  await key(page, 'Enter', 'Enter', 13);
  await blur(page);
};
const writesBetween = (page, a, b) => page.writes.filter(w => w.at >= a && w.at <= b);
const notices = page => page.evaluate(`(() => { ${DEEP} return deep(document, '[data-notice-id]').map(n => n.textContent.replace(/\\s+/g, ' ').trim()); })()`);
const journal = () => {
  const index = join(PROJ, '.pix3/history/scenes/main.pix3scene/index.jsonl');
  return existsSync(index) ? readFileSync(index, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
};
/** An agent edits the file the way a coding agent does: read, replace, write. */
const agentEdit = (from, to) => {
  const text = disk();
  if (!text.includes(from)) throw new Error(`agent edit: ${from} not in the file`);
  writeFileSync(SCENE, text.replace(from, to));
};

let ORIGINAL = disk();
let pageA, pageB, pageC, pageD;
try {
  pageA = await openEditor('A');
  check('A is the writer', (await pageA.evaluate(`(async () => ((await window.__PIX3_DEBUG__.status()).writer))()`)) === 'self');

  // --- W21 warm-up: the fixture is a pre-W21 file (anchored rects, no margins); the editor's first
  // write converts its anchored nodes to the margin form, once. The rows below measure diffs
  // against the converted file, which is what every later write is made on.
  const legacy = disk();
  check('W21: the fixture is a legacy file (anchors, no margins)', /horizontalAlign: (left|right|stretch)/.test(legacy) && !/^\s+(left|right|top|bottom): -?\d/m.test(legacy));
  await rename(pageA, 'board', 'Board W21');
  const converted = await waitUntil(() => disk() !== legacy, 4000);
  check('W21: the first write converts the legacy file (margins in, every comment intact, in order)', converted.v && /^\s+(left|right|top|bottom): -?\d/m.test(disk()) && JSON.stringify(comments(legacy)) === JSON.stringify(comments(disk())), { ms: converted.ms, lines: changedLines(legacy, disk()) });
  await waitUntil(async () => (await pageA.evaluate(`(async () => ((await window.__PIX3_DEBUG__.status()).dirty.length))()`)) === 0, 4000);
  ORIGINAL = disk();

  // --- Drag + idle ------------------------------------------------------------------------------
  const p0 = await pos(pageA, NODE);
  const g1 = await drag(pageA, { stepMs: 80 });
  const p1 = await pos(pageA, NODE);
  check('drag moves the node in memory', p1 && (p1.x !== p0.x || p1.y !== p0.y), { p0, p1 });
  if (!p1 || p1.x === p0.x) throw new Error('the first drag did not move the node — nothing to measure the gate against');
  pxPerWorld = 80 / (p1.x - p0.x);
  check('Drag: no PUT during the drag', writesBetween(pageA, g1.t0, g1.t1).length === 0, { dragMs: g1.t1 - g1.t0, writes: pageA.writes.length });
  const idle = await waitUntil(() => disk() !== ORIGINAL, 4000, 20);
  const idleMs = Date.now() - g1.t1;
  check('idle after drag: on disk within 2 s of the release', idle.v && idleMs <= 2000, { msAfterRelease: idleMs });
  const afterDrag = disk();
  check('idle after drag: diff ≤ 3 lines', changedLines(ORIGINAL, afterDrag) <= 3, { lines: changedLines(ORIGINAL, afterDrag) });
  check('idle after drag: every comment intact, in order', JSON.stringify(comments(ORIGINAL)) === JSON.stringify(comments(afterDrag)), { before: comments(ORIGINAL).length, after: comments(afterDrag).length });

  // --- Ctrl+Z after flush ---------------------------------------------------------------------------
  await blur(pageA);
  await ctrl(pageA, 'z');
  const undone = await waitUntil(async () => { const p = await pos(pageA, NODE); return p && p.x === p0.x && p.y === p0.y; }, 2000);
  check('Ctrl+Z after flush: undone in memory', undone.v);
  check('Ctrl+Z after flush: the scene is dirty again', (await pageA.evaluate(`(async () => ((await window.__PIX3_DEBUG__.status()).dirty.length))()`)) === 1);
  const back = await waitUntil(() => disk() === ORIGINAL, 4000);
  check('Ctrl+Z after flush: the next flush writes it (file back to the original bytes)', back.v, { ms: back.ms });

  // --- Esc during drag ----------------------------------------------------------------------------
  const before = disk();
  const writes0 = pageA.writes.length;
  await drag(pageA, { escape: true });
  await sleep(2500);
  const pe = await pos(pageA, NODE);
  check('Esc during drag: the node is back', pe && pe.x === p0.x && pe.y === p0.y, pe);
  check('Esc during drag: no write', pageA.writes.length === writes0 && disk() === before, { writes: pageA.writes.length - writes0 });

  // --- N8: flush x=1 → Ctrl+Z → the agent renames a node ------------------------------------------
  await drag(pageA);
  await waitUntil(() => disk() !== before, 4000);
  await sleep(200);
  await blur(pageA);
  await ctrl(pageA, 'z');
  await waitUntil(async () => { const p = await pos(pageA, NODE); return p && p.x === p0.x; }, 2000);
  agentEdit('name: Game Background', 'name: Game Background (agent)'); // read the flushed file
  const lit = await waitUntil(async () => (await pageA.evaluate(`(() => { ${DEEP} return deep(document, '.tree-node__content--external-change').map(e => e.textContent.trim()); })()`)).some(t => /Game Background/.test(t)), 3000);
  check('the node the agent changed is highlighted in the scene tree', lit.v, { ms: lit.ms });
  const n8 = await waitUntil(() => { const t = disk(); return t.includes('Game Background (agent)') && changedLines(ORIGINAL, t) === 2; }, 8000);
  check('N8: on disk x=0 (the undo) and the agent rename', n8.v, { ms: n8.ms, diff: changedLines(ORIGINAL, disk()) });
  const graphName = await pageA.evaluate(`(async () => (await window.__PIX3_DEBUG__.node('game-background'))?.name)()`);
  check('N8: the editor graph has the agent rename', graphName === 'Game Background (agent)', graphName);

  // --- N10: designer edit, the agent syncs at once and reads ----------------------------------------
  await rename(pageA, 'board', 'Board N10');
  const sync = await pageA.evaluate(`window.__PIX3_DEBUG__.sync({ timeoutMs: 8000 })`);
  check('N10: sync right after the edit is ok', sync.ok === true, sync);
  check('N10: the file read after sync has the edit', disk().includes('name: Board N10'));

  // --- External write of the same key while dirty ---------------------------------------------------
  await rename(pageA, 'board', 'Board Designer');
  agentEdit('name: Board N10', 'name: Board Agent');
  const merged = await waitUntil(async () => (await pageA.evaluate(`(async () => (await window.__PIX3_DEBUG__.node('board'))?.name)()`)) === 'Board Agent', 6000);
  check('same key: the agent value wins in the editor', merged.v, { ms: merged.ms });
  const shown = await notices(pageA);
  check('same key: a notice names the dropped key', shown.some(n => /dropped/.test(n) && /Board/.test(n)), shown);
  check('same key: the editor state is journaled as rejected-draft', journal().some(e => e.author === 'rejected-draft'), journal().map(e => e.author));
  await sleep(2000);
  check('same key: the disk keeps the agent value', disk().includes('name: Board Agent') && !disk().includes('Board Designer'));

  // --- Continuous edits for 15 s ---------------------------------------------------------------------
  const cStart = pageA.writes.length;
  const gestures = [];
  const tFirst = Date.now();
  const moved = [];
  const trace = [];
  while (Date.now() - tFirst < 15000) {
    const before = await pos(pageA, NODE);
    // One direction: alternating would bring the node back to the baseline on every second
    // gesture, and a flush at such a moment rightly writes nothing.
    const g = await drag(pageA, { dx: 8, dy: 0, steps: 8, stepMs: 60 });
    gestures.push(g);
    moved.push((await pos(pageA, NODE)).x !== before.x);
    trace.push({ t: g.t1 - tFirst, st: await pageA.evaluate('(async () => ((({ dirty, writer, flushing, gestureInProgress }) => ({ dirty: dirty.length, writer, flushing, g: gestureInProgress }))((await window.__PIX3_DEBUG__.status()))))()') });
    await sleep(400); // never 1.5 s of idle
  }
  await sleep(300);
  check('continuous edits: every gesture moved the node', moved.every(Boolean), { gestures: moved.length, moved: moved.filter(Boolean).length });
  const cWrites = pageA.writes.slice(cStart);
  const firstWrite = cWrites[0]?.at - gestures[0].t1;
  if (cWrites.length === 0) console.log('TRACE', JSON.stringify(trace), JSON.stringify([...pageA.reqs.values()].map(r => ({ ...r, at: r.at - tFirst }))), JSON.stringify(pageA.console.filter(c => /FLUSHDBG/.test(c.text) && c.at >= tFirst - 6000).map(c => (c.at - tFirst) + ' ' + c.text.slice(0, 120))));
  check('continuous edits: written within 10 s of the first edit', cWrites.length > 0 && firstWrite <= 10500, { firstWriteMs: firstWrite, writes: cWrites.map(w => w.at - gestures[0].t1) });
  const during = cWrites.filter(w => gestures.some(g => w.at > g.t0 && w.at < g.t1));
  check('continuous edits: no write during a gesture', during.length === 0, { during: during.length });
  await waitUntil(async () => (await pageA.evaluate(`(async () => ((await window.__PIX3_DEBUG__.status()).dirty.length))()`)) === 0, 4000);

  // --- Two tabs -----------------------------------------------------------------------------------------
  pageB = await openEditor('B');
  check('second tab is read-only', (await pageB.evaluate(`(async () => ((await window.__PIX3_DEBUG__.status()).writer))()`)) === 'other');
  await drag(pageA, { dx: -60, dy: 20 });
  const pA = await pos(pageA, NODE);
  await waitUntil(() => disk().includes(String(Math.round(pA.x * 1000) / 1000).slice(0, 5)), 4000);
  const follows = await waitUntil(async () => { const pb = await pos(pageB, NODE); return pb && Math.abs(pb.x - pA.x) < 1e-6 && Math.abs(pb.y - pA.y) < 1e-6; }, 6000);
  check('read-only tab follows the writer tab (same position)', follows.v, { ms: follows.ms });
  check('two tabs: no 412 anywhere', pageA.refused.length === 0 && pageB.refused.length === 0, [...pageA.refused, ...pageB.refused]);
  await pageB.evaluate(`window.dispatchEvent(new CustomEvent('pix3-take-over'))`);
  const took = await waitUntil(async () => (await pageB.evaluate(`(async () => ((await window.__PIX3_DEBUG__.status()).writer))()`)) === 'self' && (await pageA.evaluate(`(async () => ((await window.__PIX3_DEBUG__.status()).writer))()`)) === 'other', 5000);
  check('take over: B writes, A read-only', took.v, { ms: took.ms });
  await rename(pageB, 'board', 'Board From B');
  const bWrote = await waitUntil(() => disk().includes('name: Board From B'), 5000);
  check('take over: an edit in B reaches the disk', bWrote.v, { ms: bWrote.ms });

  // --- Close the writer tab → a new tab writes at once ---------------------------------------------------
  await closePage(pageA); pageA = null;
  await closePage(pageB); pageB = null;
  pageC = await openEditor('C');
  check('new tab after closing is the writer', (await pageC.evaluate(`(async () => ((await window.__PIX3_DEBUG__.status()).writer))()`)) === 'self');
  await rename(pageC, 'board', 'Board From C');
  const tSave = Date.now();
  await ctrl(pageC, 's');
  const cWrote = await waitUntil(() => disk().includes('name: Board From C'), 3000, 20);
  check('closed tab → new tab: first edit on disk ≤ 1 s after Ctrl+S', cWrote.v && Date.now() - tSave <= 1000 + 100, { ms: cWrote.ms });
  check('new tab: no 412', pageC.refused.length === 0, pageC.refused);

  // --- N9: dev server dies, edits stay in a draft, the tab closes, the editor comes back ---------------
  await server.close();
  await sleep(500);
  const beforeDraft = disk();
  await rename(pageC, 'board', 'Board Draft');
  await sleep(3000); // ≥ one 2 s checkpoint
  const draftShas = await pageC.evaluate(`new Promise(r => { const q = indexedDB.open('pix3-drafts'); q.onsuccess = () => { const tx = q.result.transaction('drafts', 'readonly'); const g = tx.objectStore('drafts').getAll(); g.onsuccess = () => r(g.result.map(d => d.baselineSha)); }; q.onerror = () => r(null); })`);
  const diskSha = (await import('node:crypto')).createHash('sha256').update(readFileSync(SCENE)).digest('hex');
  const draft = await pageC.evaluate(`new Promise(r => { const q = indexedDB.open('pix3-drafts'); q.onsuccess = () => { const tx = q.result.transaction('drafts', 'readonly'); const g = tx.objectStore('drafts').getAll(); g.onsuccess = () => r(g.result.map(d => ({ path: d.path, has: d.text.includes('Board Draft') }))); }; q.onerror = () => r(null); })`);
  check('N9: a confirmed draft checkpoint exists while the server is down', Array.isArray(draft) && draft.some(d => d.has), draft);
  check('N9: nothing reached the disk', disk() === beforeDraft);
  await closePage(pageC); pageC = null;
  await startServer();
  pageD = await openEditor('D');
  const offered = await waitUntil(async () => (await notices(pageD)).some(n => /Unsaved edits/.test(n)), 5000);
  check('N9: the reopened editor offers the draft', offered.v, await notices(pageD));
  if (!(await pageD.evaluate(`(() => { ${DEEP} return deep(document, '[data-notice-id] .host-banner__action').length; })()`))) console.log('NOTICES-D', JSON.stringify({ notices: await notices(pageD), draftShas, diskShaAtCheckpoint: diskSha, diskShaNow: (await import('node:crypto')).createHash('sha256').update(readFileSync(SCENE)).digest('hex'), journal: journal().slice(-6), writesC: [...(pageC?.reqs?.values?.() ?? [])] }));
  await click(pageD, '[data-notice-id] .host-banner__action');
  const restored = await waitUntil(() => disk().includes('name: Board Draft'), 5000);
  check('N9: "Restore" writes the draft to disk', restored.v, { ms: restored.ms });

  const all = [pageD];
  check('no page errors', all.every(p => p.errors.length === 0), all.flatMap(p => p.errors).slice(0, 4));
  check('no captured editor errors', (await pageD.evaluate(`window.__PIX3_DEBUG__.errors().length`)) === 0, await pageD.evaluate(`window.__PIX3_DEBUG__.errors().slice(0, 3)`));
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
