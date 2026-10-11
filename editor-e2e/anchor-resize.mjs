// W21 (pix3-core `.plans/write-model.md`): a container resized by its viewport handle writes the
// container alone — its anchored children live in their `layout:` margins — and a legacy file
// (anchored rects, no margins) is converted by the editor's first write of it. Headless Chrome,
// real input over CDP, judged by the bytes on disk, the bridge and the inspector DOM.
//
//   A. a scene in the margin form: drag `panel`'s east handle → the diff is the one `width:` line,
//      the children's lines are byte-identical, a fresh tab lays the children out where the live
//      graph had them; the inspector shows the knob's `Right` margin and no `Left` row. A
//      `Checkbox2D` stretched across (W23) takes its side from the span: it grows with the panel
//      and writes no `size:` line.
//   B. the same scene in the legacy form: the first write converts it (margins in, positions of
//      the anchored axes `0`, the stretched bar's `width` gone, the panel's width) with every
//      comment kept; a fresh tab agrees with the live graph; a second resize is one line again.
//
// Usage: node anchor-resize.mjs   (PIX3_CDP_PROXY=1 to run through the CDP token proxy)
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
const PROJ = join(HERE, 'proj-anchor');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : ''}`);
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
const changed = (a, b) => {
  const x = a.split('\n'), y = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push({ line: i + 1, from: x[i], to: y[i] });
  return out;
};
const comments = text => text.split('\n').filter(l => /(^|\s)#/.test(l)).map(l => l.slice(l.indexOf('#')).trim());

// --- the scenes ------------------------------------------------------------------------------------
const MARGINS = `# A panel with anchored children, in the margin form (W21).
version: 1.0.0
root:
  - id: game-root
    type: Group2D
    name: Game Root
    properties:
      width: 1920
      height: 1080
      layout: { enabled: true, horizontalAlign: stretch, verticalAlign: stretch }
    children:
      - id: panel
        type: Group2D
        name: Panel # the container the designer resizes
        properties:
          width: 600
          height: 400
          transform: { position: [0, 0], scale: [1, 1], rotation: 0 }
        children:
          - id: title
            type: ColorRect2D
            name: Title
            properties:
              width: 200
              height: 40
              color: "#f5ae39"
              transform: { position: [0, 0], scale: [1, 1], rotation: 0 }
              layout: { enabled: true, horizontalAlign: left, verticalAlign: top, left: 20, top: 20 } # top-left corner
          - id: bar
            type: ColorRect2D
            name: Bar
            properties:
              height: 30
              color: "#1ebde3"
              transform: { position: [0, 0], scale: [1, 1], rotation: 0 }
              layout: { enabled: true, horizontalAlign: stretch, verticalAlign: bottom, left: 20, right: 20, bottom: 20 }
          - id: knob
            type: ColorRect2D
            name: Knob
            properties:
              width: 40
              height: 40
              color: "#ffffff"
              transform: { position: [0, 50], scale: [1, 1], rotation: 0 } # y authored (centre axis)
              layout: { enabled: true, horizontalAlign: right, right: 10 }
          - id: check
            type: Checkbox2D
            name: Check # a square stretched across: its side is the span (W23), no size: line
            properties:
              transform: { position: [0, 0], scale: [1, 1], rotation: 0 }
              layout: { enabled: true, horizontalAlign: stretch, verticalAlign: top, left: 250, right: 250, top: 80 }
`;
// The same panel as every scene before W21 wrote it: rects against the parent's authored size.
const LEGACY = MARGINS.replace('in the margin form (W21)', 'in the legacy form')
  .replace("transform: { position: [0, 0], scale: [1, 1], rotation: 0 }\n              layout: { enabled: true, horizontalAlign: left, verticalAlign: top, left: 20, top: 20 } # top-left corner",
    "transform: { position: [-180, 160], scale: [1, 1], rotation: 0 }\n              layout: { enabled: true, horizontalAlign: left, verticalAlign: top } # top-left corner")
  .replace("height: 30\n              color: \"#1ebde3\"\n              transform: { position: [0, 0], scale: [1, 1], rotation: 0 }\n              layout: { enabled: true, horizontalAlign: stretch, verticalAlign: bottom, left: 20, right: 20, bottom: 20 }",
    "width: 560\n              height: 30\n              color: \"#1ebde3\"\n              transform: { position: [0, -165], scale: [1, 1], rotation: 0 }\n              layout: { enabled: true, horizontalAlign: stretch, verticalAlign: bottom }")
  .replace("transform: { position: [0, 50], scale: [1, 1], rotation: 0 } # y authored (centre axis)\n              layout: { enabled: true, horizontalAlign: right, right: 10 }",
    "transform: { position: [270, 50], scale: [1, 1], rotation: 0 } # y authored (centre axis)\n              layout: { enabled: true, horizontalAlign: right }");
if (LEGACY === MARGINS || /left: 20|right: 10/.test(LEGACY)) throw new Error('legacy twin not derived');

// --- project / server / browser ------------------------------------------------------------------
for (const dir of [PROJ, join(HERE, '.vite-cache-anchor'), join(HERE, 'profile-anchor')]) rmSync(dir, { recursive: true, force: true });
mkdirSync(join(PROJ, 'scenes'), { recursive: true });
writeFileSync(join(PROJ, 'index.html'), '<!doctype html><html><body><div id="app"></div></body></html>\n');
writeFileSync(join(PROJ, 'scenes/margins.pix3scene'), MARGINS);
writeFileSync(join(PROJ, 'scenes/legacy.pix3scene'), LEGACY);
writeFileSync(join(PROJ, 'pix3project.yaml'), 'version: 1.0.0\nprojectType: 2d\nviewportBaseSize:\n  width: 1920\n  height: 1080\ndefaultExportScenePath: scenes/margins.pix3scene\nmetadata:\n  projectId: anchor-e2e\n');
symlinkSync(join(CORE, 'node_modules'), join(PROJ, 'node_modules'));
mkdirSync(join(HERE, 'profile-anchor'), { recursive: true });
const server = await createServer({ configFile: false, root: PROJ, logLevel: 'warn', cacheDir: join(HERE, '.vite-cache-anchor'), plugins: [pix3()], server: { port: PORT, strictPort: true, host: '127.0.0.1' } });
await server.listen();
const { chrome, browser } = await launchChrome(join(HERE, 'profile-anchor'), ['--window-size=1600,1000']);

const disk = file => readFileSync(join(PROJ, 'scenes', file), 'utf8');
const manifest = scene => `version: 1.0.0\nprojectType: 2d\nviewportBaseSize:\n  width: 1920\n  height: 1080\ndefaultExportScenePath: scenes/${scene}\nmetadata:\n  projectId: anchor-e2e\n`;
/** A tab on `scene`: the editor opens the manifest's entry scene, so the manifest names it. */
const openEditor = async (name, scene, { freshSession = false } = {}) => {
  writeFileSync(join(PROJ, 'pix3project.yaml'), manifest(scene));
  const page = await browser.newPage(name);
  if (freshSession) {
    // The shell reopens the tabs the last session of this project left open; forget them so the
    // manifest's entry scene is what opens.
    await page.navigate(`${BASE}/`);
    await page.evaluate(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return true; })()`);
  }
  await page.navigate(`${BASE}/__pix3/`);
  await page.waitFor(`(async () => (!!window.__PIX3_DEBUG__ && !!(await window.__PIX3_DEBUG__.status()).activeScene))()`, 60000);
  await sleep(800);
  return page;
};
const closePage = page => browser.send('Target.closeTarget', { targetId: page.targetId });
const click = async (page, selector) => {
  const rect = await page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(selector)})[0]; if (!el) return null; el.scrollIntoView?.({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
};
const blur = page => page.evaluate(`(() => { ${DEEP} for (const el of deep(document, 'input, textarea')) el.blur(); document.activeElement?.blur?.(); return true; })()`);
const node = (page, id) => page.evaluate(`window.__PIX3_DEBUG__.node(${JSON.stringify(id)})`);
const live = async (page, id) => {
  const n = await node(page, id);
  const p = n?.transform?.position ?? n?.node?.transform?.position;
  return p ? { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 } : null;
};
const screen = (page, id) => page.evaluate(`window.__PIX3_DEBUG__.screen(${JSON.stringify(id)})`);
const status = page => page.evaluate(`window.__PIX3_DEBUG__.status()`);
const rects = async (page, ids) => Object.fromEntries(await Promise.all(ids.map(async id => [id, { ...(await live(page, id)), screen: await screen(page, id) }])));

/** Select `panel` and drag its east scale handle by `dx` CSS px. Returns the handle point used. */
const dragEastHandle = async (page, dx) => {
  await click(page, '[data-node-id="panel"]');
  await sleep(300);
  await blur(page);
  const p = await screen(page, 'panel');
  const k = await screen(page, 'knob');
  const kx = (await live(page, 'knob')).x; // knob.x in panel space = pxPerWorld's yardstick
  const pxPerWorld = (k.x - p.x) / kx;
  const width = (await node(page, 'panel'))?.properties?.width ?? (await node(page, 'panel'))?.node?.properties?.width;
  const handle = { x: p.x + (width / 2) * pxPerWorld, y: p.y };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y, button: 'none' });
  await sleep(100);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 20; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + (dx * i) / 20, y: handle.y, button: 'left', buttons: 1 });
    await sleep(40);
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + dx, y: handle.y, button: 'left', buttons: 0, clickCount: 1 });
  return { pxPerWorld, handle, width };
};
const anchorRows = page => page.evaluate(`(() => { ${DEEP} return deep(document, '[data-subsection="Anchors"] .property-label').map(el => el.textContent.trim()); })()`);
const CHILDREN = ['title', 'bar', 'knob'];

let page = null, pageB = null;
try {
  // --- A. the margin form ------------------------------------------------------------------------
  page = await openEditor('A', 'margins.pix3scene');
  check('A: the scene opened', String(await page.evaluate(`(async () => (await window.__PIX3_DEBUG__.status()).activeScene)()`)).includes('margins'));
  const before = await rects(page, CHILDREN);
  check('A: the children are laid out from their margins', before.title.x === -180 && before.title.y === 160 && before.bar.y === -165 && before.knob.x === 270 && before.knob.y === 50, before);
  const nothingPending = await page.evaluate(`window.__PIX3_DEBUG__.pending()`);
  check('A: nothing is pending on open', Object.values(nothingPending).every(keys => keys.length === 0), nothingPending);
  const originalA = disk('margins.pix3scene');
  const dragA = await dragEastHandle(page, 80);
  const widthA = await waitUntil(async () => { const n = await node(page, 'panel'); const w = n?.properties?.width ?? n?.node?.properties?.width; return w && w !== 600 ? w : null; }, 3000);
  check('A: the east handle resized the panel in memory', widthA.v && widthA.v > 600, { width: widthA.v, ...dragA });
  if (!widthA.v) throw new Error('the handle drag did not resize the panel — nothing to measure');
  const after = await rects(page, CHILDREN);
  const grew = widthA.v - 600;
  // The DTO's properties are what the file gets (no derived size), so the side is read from the
  // placement: a top-anchored square's centre sits `top + side / 2` below the panel's top edge.
  const sideOf = async (pg, id) => 2 * (400 / 2 - 80 - (await live(pg, id)).y);
  const squareA = await sideOf(page, 'check');
  check('A: the stretched Checkbox2D took the new span as its side (W23)', Math.abs(squareA - (100 + grew)) < 1e-2, { side: squareA, grew });
  check('A: the children followed their margins in memory', Math.abs(after.title.x - (-180 - grew / 2)) < 1e-2 && Math.abs(after.knob.x - (270 + grew / 2)) < 1e-2 && after.title.y === 160 && after.knob.y === 50, { grew, after });
  const flushedA = await waitUntil(() => disk('margins.pix3scene') !== originalA, 4000);
  check('A: the flush reached the disk', flushedA.v, { ms: flushedA.ms });
  const diffA = changed(originalA, disk('margins.pix3scene'));
  // The east handle keeps the west edge where it is, so the panel's centre moves with its width:
  // two lines, both the panel's own (10-space indent); nothing of the children.
  const panelLine = l => /^ {10}(width: |transform: )/.test(l ?? '');
  check('A: the diff is the panel’s width (and centre) and nothing else', diffA.length >= 1 && diffA.length <= 2 && diffA.every(d => panelLine(d.from) && panelLine(d.to)) && diffA.some(d => new RegExp(`width: ${widthA.v}`).test(d.to)), diffA);
  const childrenBlock = text => text.slice(text.indexOf('- id: title'));
  check('A: every child line is byte-identical', childrenBlock(disk('margins.pix3scene')) === childrenBlock(originalA));
  check('A: no 412, no errors', (await page.evaluate(`window.__PIX3_DEBUG__.errors().length`)) === 0, await page.evaluate(`window.__PIX3_DEBUG__.errors().slice(0, 3)`));
  // The inspector: the knob's anchors show its Right margin, no Left row.
  await click(page, '[data-node-id="knob"]');
  await sleep(400);
  const rows = await anchorRows(page);
  check('A: the inspector shows the knob’s Right margin and no Left/Top/Bottom row', rows.includes('Right') && !rows.includes('Left') && !rows.includes('Top') && !rows.includes('Bottom'), rows);
  // A fresh tab lays the children out exactly where the live graph had them.
  await closePage(page); page = null;
  pageB = await openEditor('A2', 'margins.pix3scene');
  const reloaded = await rects(pageB, CHILDREN);
  check('A: a fresh tab lays the children out as the live graph had them', CHILDREN.every(id => reloaded[id].x === after[id].x && reloaded[id].y === after[id].y), { reloaded, after });
  const squareReloaded = await sideOf(pageB, 'check');
  check('A: …and the Checkbox2D at the same side, from the file with no size: line', Math.abs(squareReloaded - squareA) < 1e-2 && !/^\s+size:/m.test(disk('margins.pix3scene')), { squareReloaded, squareA });
  await closePage(pageB); pageB = null;

  // --- B. the legacy form: the first write converts the file ---------------------------------------
  page = await openEditor('B', 'legacy.pix3scene', { freshSession: true });
  check('B: the legacy scene is the one open', String(await page.evaluate(`(async () => (await window.__PIX3_DEBUG__.status()).activeScene)()`)).includes('legacy'));
  const beforeB = await rects(page, CHILDREN);
  check('B: the legacy scene lays out like the margin one', beforeB.title.x === -180 && beforeB.title.y === 160 && beforeB.bar.y === -165 && beforeB.knob.x === 270, beforeB);
  const pendingB = await page.evaluate(`window.__PIX3_DEBUG__.pending()`);
  check('B: nothing is pending on open (the margins are derived, not an edit)', Object.values(pendingB).every(keys => keys.length === 0), pendingB);
  const originalB = disk('legacy.pix3scene');
  const dragB = await dragEastHandle(page, 80);
  const widthB = await waitUntil(async () => { const n = await node(page, 'panel'); const w = n?.properties?.width ?? n?.node?.properties?.width; return w && w !== 600 ? w : null; }, 3000);
  check('B: the handle resized the panel', widthB.v > 600, { width: widthB.v, ...dragB });
  const afterB = await rects(page, CHILDREN);
  const flushedB = await waitUntil(() => disk('legacy.pix3scene') !== originalB, 4000);
  check('B: the flush reached the disk', flushedB.v);
  const textB = disk('legacy.pix3scene');
  check('B: the first write converted the file: margins in', /left: 20/.test(textB) && /top: 20/.test(textB) && /right: 20/.test(textB) && /bottom: 20/.test(textB) && /right: 10/.test(textB), changed(originalB, textB));
  check('B: …the anchored position components are 0, the stretched bar has no width', /position: \[0, 0\]/.test(textB) && !/width: 560/.test(textB) && /position: \[0, 50\]/.test(textB) && !/position: \[270, 50\]/.test(textB));
  check('B: …the panel’s new width is in', new RegExp(`width: ${widthB.v}`).test(textB));
  check('B: …every comment intact, in order', JSON.stringify(comments(originalB)) === JSON.stringify(comments(textB)), { before: comments(originalB), after: comments(textB) });
  await closePage(page); page = null;
  pageB = await openEditor('B2', 'legacy.pix3scene');
  check('B2: the legacy scene is the one open', String(await pageB.evaluate(`(async () => (await window.__PIX3_DEBUG__.status()).activeScene)()`)).includes('legacy'));
  const reloadedB = await rects(pageB, CHILDREN);
  check('B: a fresh tab lays the children out as the live graph had them', CHILDREN.every(id => reloadedB[id].x === afterB[id].x && reloadedB[id].y === afterB[id].y), { reloadedB, afterB });
  check('B: …and nothing is pending', Object.values(await pageB.evaluate(`window.__PIX3_DEBUG__.pending()`)).every(keys => keys.length === 0));
  // A second resize is one line again.
  const originalB2 = disk('legacy.pix3scene');
  await dragEastHandle(pageB, 60);
  const flushedB2 = await waitUntil(() => disk('legacy.pix3scene') !== originalB2, 4000);
  const diffB2 = changed(originalB2, disk('legacy.pix3scene'));
  check('B: the second resize is the panel’s width (and centre) alone', flushedB2.v && diffB2.length >= 1 && diffB2.length <= 2 && diffB2.every(d => /^ {10}(width: |transform: )/.test(d.from ?? '')) && diffB2.some(d => /width:/.test(d.to)), diffB2);
  check('B: no errors', (await pageB.evaluate(`window.__PIX3_DEBUG__.errors().length`)) === 0, await pageB.evaluate(`window.__PIX3_DEBUG__.errors().slice(0, 3)`));
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  browser.close();
  chrome.kill();
  await server.close();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
