// M3 of .plans/editor-core-port.md in a real browser: edit → save, external change, scripts, sync,
// play, second tab. Edits go through the real UI (CDP input), judged by state (AGENTS.md rule 10).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { start, PROJ } from './harness.mjs';

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = text => createHash('sha256').update(text).digest('hex');
const SCENE = join(PROJ, 'scenes/main.pix3scene');
const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;

const click = async (page, selector) => {
  const rect = await page.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(selector)})[0]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
};
const waitUntil = async (fn, timeoutMs = 8000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return { v, ms: Date.now() - t0 }; if (Date.now() - t0 > timeoutMs) return { v, ms: -1 }; await sleep(100); }
};

const h = await start();
try {
  const page = await h.openEditor('editor-a');
  await page.evaluate(`window.__marker = 'a'`);

  // 1. Rename a node through the inspector, then let the idle save write it.
  await click(page, '[data-node-id="board"]');
  await sleep(300);
  const nameInput = `(() => { ${DEEP} return deep(document, 'pix3-inspector-panel input[type=text]')[0]; })()`;
  await page.evaluate(`${nameInput}.focus(), ${nameInput}.select()`);
  await page.send('Input.insertText', { text: 'Board Edited' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const renamed = await waitUntil(async () => (await page.evaluate(`window.__PIX3_DEBUG__.node('board')?.name`)) === 'Board Edited', 3000);
  check('inspector rename reaches the scene graph', renamed.v, renamed);
  const saved = await waitUntil(async () => readFileSync(SCENE, 'utf8').includes('Board Edited'), 6000);
  check('idle save writes the rename to disk', saved.v, { ms: saved.ms });

  // 2. An agent edits the clean scene on disk: the editor reloads it.
  const disk = readFileSync(SCENE, 'utf8');
  const agentText = disk.replace('name: Game Background', 'name: Game Background From Agent');
  check('agent edit target present in the file', agentText !== disk);
  writeFileSync(SCENE, agentText);
  const reloaded = await waitUntil(async () => (await page.evaluate(`JSON.stringify(window.__PIX3_DEBUG__.find('From Agent'))`)) !== '[]', 6000);
  check('external change reloads the clean scene', reloaded.v, { ms: reloaded.ms });
  check('the earlier rename survived the reload', (await page.evaluate(`window.__PIX3_DEBUG__.node('board')?.name`)) === 'Board Edited');

  // 3. A script edit reaches the editor without a reload (executed stamp = sha on disk).
  const scriptPath = join(PROJ, 'scripts/ScoreHud.ts');
  const scriptText = readFileSync(scriptPath, 'utf8') + '\n// edited by the agent\n';
  writeFileSync(scriptPath, scriptText);
  const stamped = await waitUntil(async () => (await page.evaluate(`globalThis.__pix3Executed?.['scripts/ScoreHud.ts']`)) === sha(scriptText), 6000);
  check('script edit executes in the editor', stamped.v, { ms: stamped.ms });

  // 4. Agent sync: barrier with the editor confirming.
  writeFileSync(scriptPath, scriptText + '// again\n');
  const sync = await page.evaluate(`window.__PIX3_DEBUG__.sync({ timeoutMs: 8000 })`);
  check('sync from the bridge is ok', sync.ok === true, sync);
  check('editor still on its first load', (await page.evaluate(`window.__marker`)) === 'a');

  // 5. Agent play, a change during play → stale with the owner; stop.
  const started = await page.evaluate(`window.__PIX3_DEBUG__.play.start()`);
  check('agent starts play', started.ok === true, started);
  const playStatus = await page.evaluate(`window.__PIX3_DEBUG__.play.status()`);
  check('play owner is the agent', playStatus.playing && playStatus.playOwner === 'agent', playStatus);
  writeFileSync(scriptPath, scriptText + '// during play\n');
  const staleSync = await page.evaluate(`window.__PIX3_DEBUG__.sync({ timeoutMs: 8000 })`);
  check('sync during agent play is stale with playing:agent', staleSync.ok === false && staleSync.reason === 'stale' && staleSync.playing === 'agent', staleSync);
  const stopped = await page.evaluate(`window.__PIX3_DEBUG__.play.stop()`);
  check('agent stops its own play', stopped.ok === true && (await page.evaluate(`window.__PIX3_DEBUG__.play.status().playing`)) === false, stopped);
  const syncAfter = await page.evaluate(`window.__PIX3_DEBUG__.sync({ timeoutMs: 8000 })`);
  check('sync after stop is ok', syncAfter.ok === true, syncAfter);

  // 6. A second tab is read-only; "Take over" moves the writer.
  const pageB = await h.openEditor('editor-b');
  check('second tab is read-only', (await pageB.evaluate(`window.__PIX3_DEBUG__.status().writer`)) === 'other');
  const bannerB = await pageB.evaluate(`(() => { ${DEEP} const b = deep(document, 'pix3-host-banner')[0]; return (b?.shadowRoot ?? b)?.textContent?.trim().replace(/\\s+/g, ' ') ?? ''; })()`);
  check('second tab shows the read-only banner', /read-only|another tab|take over/i.test(bannerB), bannerB);
  await pageB.evaluate(`window.dispatchEvent(new CustomEvent('pix3-take-over'))`);
  const took = await waitUntil(async () => (await pageB.evaluate(`window.__PIX3_DEBUG__.status().writer`)) === 'self' && (await page.evaluate(`window.__PIX3_DEBUG__.status().writer`)) === 'other', 5000);
  check('take over makes B the writer and A read-only', took.v, { ms: took.ms });

  const menus = await page.evaluate(`(() => { ${DEEP} const m = deep(document, 'pix3-main-menu')[0]; const root = m?.shadowRoot ?? m; return [...root.querySelectorAll('button, [role=menuitem]')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 12); })()`);
  check('menu sections have no File / Project', !menus.some(t => /^(File|Project)$/.test(t)), menus);
  check('no captured errors in A', (await page.evaluate(`window.__PIX3_DEBUG__.errors().length`)) === 0, await page.evaluate(`window.__PIX3_DEBUG__.errors().slice(0,3)`));
  check('no page errors', page.errors.length === 0 && pageB.errors.length === 0, [...page.errors, ...pageB.errors].slice(0, 4));
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  await h.stop();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
