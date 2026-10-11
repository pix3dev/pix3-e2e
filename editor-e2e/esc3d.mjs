// Esc during a real 3D gizmo drag (write-model W11): the node is back, nothing is recorded or
// written; a no-Esc control drag is written. Async bridge v2, free ports, a fresh `proj3d/` from
// the corpus (`recipe-grid-3d`). `--core <checkout>`; exit 1 on any failed check.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bridge, click, DEEP, HERE, key, makeChecks, makeProject, openEditor, resolveCore, sleep, startChrome, startServer } from './harness.mjs';

const CORE = resolveCore();
const PROJ = makeProject(CORE, 'recipe-grid-3d', join(HERE, 'proj3d'));
const SCENE = join(PROJ, 'scenes/main.pix3scene');
const { check, finish } = makeChecks();
const { server, base } = await startServer(CORE, PROJ, join(HERE, '.vite-cache-3d'));
const { chrome, browser } = await startChrome(join(HERE, 'profile-3d'));
const before = readFileSync(SCENE, 'utf8');
try {
  const page = await openEditor(browser, base, 'e');
  const b = bridge(page);
  await sleep(1500);
  const c = await page.evaluate(`(() => { ${DEEP} const r = deep(document, 'canvas.viewport-canvas')[0].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const p0 = (await b.node('board-anchor')).transform.position;
  const writes0 = readFileSync(SCENE, 'utf8');
  const position = async () => (await b.node('board-anchor')).transform.position;
  const drag = async () => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, button: 'left', buttons: 0 });
    await sleep(100);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 15; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + i * 4, y: c.y + i * 2, button: 'left', buttons: 1 }); await sleep(40); }
  };
  const release = () => page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x + 60, y: c.y + 30, button: 'left', buttons: 0, clickCount: 1 });
  // Try as-is, then after toggling the navigation mode to 3D (N); translate tool (W); framed (F).
  let reached = null;
  for (const toggleNav of [false, true]) {
    await click(page, '[data-node-id="board-anchor"]');
    await sleep(300);
    await page.evaluate(`document.activeElement?.blur?.()`);
    if (toggleNav) { await key(page, 'n', 'KeyN', 78); await sleep(500); }
    const tools = await page.evaluate(`(() => { ${DEEP} return deep(document, 'button').map(b => (b.getAttribute('title') || b.getAttribute('aria-label') || '')).filter(t => /move|translate/i.test(t)); })()`);
    const moveTitle = tools[0];
    if (moveTitle) await click(page, `button[title="${moveTitle}"], button[aria-label="${moveTitle}"]`);
    await sleep(300);
    await key(page, 'f', 'KeyF', 70);
    await sleep(1200);
    const at = (await b.screen('board-anchor')) ?? c;
    c.x = at.x; c.y = at.y;
    await drag();
    const mid = await position();
    const gestureMid = (await b.status()).gestureInProgress;
    if (JSON.stringify(mid) !== JSON.stringify(p0) && gestureMid) { reached = { mid, toggleNav, at }; break; }
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(HERE, `esc3d-attempt-${toggleNav}.png`), Buffer.from(shot.data, 'base64'));
    console.log('attempt', JSON.stringify({ moveTitle, toggleNav, at, mid, gestureMid }));
    await release();
    await sleep(300);
  }
  check('the gizmo drag moves the node (harness reached the handle)', reached, reached);
  await key(page, 'Escape', 'Escape', 27);
  const after = await position();
  check('Esc: the node is back at its start', JSON.stringify(after) === JSON.stringify(p0), { after });
  check('Esc: the gesture ended', (await b.status()).gestureInProgress === false);
  await release();
  await sleep(2500);
  const pending = await b.pending();
  check('after the release: still at the start, nothing pending', JSON.stringify(await position()) === JSON.stringify(p0) && JSON.stringify(pending) === '{}', pending);
  check('nothing written', readFileSync(SCENE, 'utf8') === writes0 && writes0 === before);
  // Negative control: the same drag without Esc is recorded and written.
  await drag();
  await release();
  await sleep(2500);
  check('control: without Esc the drag is written', readFileSync(SCENE, 'utf8') !== before);
  check('no page errors', page.errors.length === 0, page.errors.slice(0, 3));
} catch (e) {
  check('run', false, String(e?.stack ?? e));
} finally {
  browser.close();
  chrome.kill();
  await server.close();
  finish();
}
