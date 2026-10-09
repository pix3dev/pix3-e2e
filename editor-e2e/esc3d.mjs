// Esc during a 3D gizmo drag (write-model W11): the node is back, nothing is recorded or written.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { pix3 } from '/data/igor.gritsenko/projects/pix3-stuff/pix3-core/packages/vite-plugin/dist/index.js';
import { Browser } from './cdp.mjs';

const HERE = import.meta.dirname, PROJ = join(HERE, 'proj3d'), PORT = 5298;
const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => { results.push(!!pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); };
mkdirSync(join(HERE, 'profile-3d'), { recursive: true });
const server = await createServer({ configFile: false, root: PROJ, logLevel: 'warn', cacheDir: join(HERE, '.vite-cache-3d'), plugins: [pix3()], server: { port: PORT, strictPort: true, host: '127.0.0.1' } });
await server.listen();
const chrome = spawn('/data/igor.gritsenko/projects/pix3-stuff/pix3-core-spikes/chrome.sh', ['--remote-debugging-port=9368', `--user-data-dir=${join(HERE, 'profile-3d')}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
const browser = await Browser.connect(9368);
const SCENE = join(PROJ, 'scenes/main.pix3scene');
const before = readFileSync(SCENE, 'utf8');
try {
  const page = await browser.newPage('e');
  await page.navigate(`http://127.0.0.1:${PORT}/__pix3/`);
  await page.waitFor(`!!window.__PIX3_DEBUG__ && !!window.__PIX3_DEBUG__.status().activeScene`, 60000);
  await sleep(1500);
  const clickSel = async sel => { const r = await page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(sel)})[0]; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`); for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); };
  const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); };
  const c = await page.evaluate(`(() => { ${DEEP} const r = deep(document, 'canvas.viewport-canvas')[0].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const p0 = await page.evaluate(`window.__PIX3_DEBUG__.node('board-anchor').transform.position`);
  const writes0 = readFileSync(SCENE, 'utf8');
  // Try as-is, then after toggling the navigation mode to 3D (N); translate tool (W); framed (F).
  let reached = null;
  for (const toggleNav of [false, true]) {
    await clickSel('[data-node-id="board-anchor"]');
    await sleep(300);
    await page.evaluate(`document.activeElement?.blur?.()`);
    if (toggleNav) { await key('n', 'KeyN', 78); await sleep(500); }
    const tools = await page.evaluate(`(() => { ${DEEP} return deep(document, 'button').map(b => (b.getAttribute('title') || b.getAttribute('aria-label') || '')).filter(t => /move|translate/i.test(t)); })()`);
    const moveTitle = tools[0];
    if (moveTitle) await clickSel(`button[title="${moveTitle}"], button[aria-label="${moveTitle}"]`);
    await sleep(300);
    await key('f', 'KeyF', 70);
    await sleep(1200);
    const at = (await page.evaluate(`window.__PIX3_DEBUG__.screen('board-anchor')`)) ?? c;
    c.x = at.x; c.y = at.y;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, button: 'left', buttons: 0 });
    await sleep(100);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 15; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + i * 4, y: c.y + i * 2, button: 'left', buttons: 1 }); await sleep(40); }
    const mid = await page.evaluate(`window.__PIX3_DEBUG__.node('board-anchor').transform.position`);
    const gestureMid = await page.evaluate(`window.__PIX3_DEBUG__.status().gestureInProgress`);
    if (JSON.stringify(mid) !== JSON.stringify(p0) && gestureMid) { reached = { mid, toggleNav, at }; break; }
    { const shot = await page.send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(`/tmp/claude-1001/-data-igor-gritsenko-projects-pix3-stuff/76364e5c-179e-4f40-9902-20e5eb429f33/scratchpad/esc3d-${toggleNav}.png`, Buffer.from(shot.data, 'base64')); }
    console.log('attempt', JSON.stringify({ moveTitle, toggleNav, at, mid, gestureMid }));
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x + 60, y: c.y + 30, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
  }
  check('the gizmo drag moves the node (harness reached the handle)', reached, reached);
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const after = await page.evaluate(`window.__PIX3_DEBUG__.node('board-anchor').transform.position`);
  check('Esc: the node is back at its start', JSON.stringify(after) === JSON.stringify(p0), { after });
  check('Esc: the gesture ended', (await page.evaluate(`window.__PIX3_DEBUG__.status().gestureInProgress`)) === false);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x + 60, y: c.y + 30, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(2500);
  check('after the release: still at the start, nothing pending', JSON.stringify(await page.evaluate(`window.__PIX3_DEBUG__.node('board-anchor').transform.position`)) === JSON.stringify(p0) && JSON.stringify(await page.evaluate('window.__PIX3_DEBUG__.pending()')) === '{}', await page.evaluate('window.__PIX3_DEBUG__.pending()'));
  check('nothing written', readFileSync(SCENE, 'utf8') === writes0 && writes0 === before);
  // Negative control: the same drag without Esc is recorded and written.
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, button: 'left', buttons: 0 });
  await sleep(100);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 15; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + i * 4, y: c.y + i * 2, button: 'left', buttons: 1 }); await sleep(40); }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x + 60, y: c.y + 30, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(2500);
  check('control: without Esc the drag is written', readFileSync(SCENE, 'utf8') !== before);
  check('no page errors', page.errors.length === 0, page.errors.slice(0, 3));
} catch (e) { check('run', false, String(e?.stack ?? e)); } finally { browser.close(); chrome.kill(); await server.close(); console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(0); }
