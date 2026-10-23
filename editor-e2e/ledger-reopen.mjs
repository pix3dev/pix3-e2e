// W26 (pix3-core `.plans/write-model.md`): the flush ledger outlives the tab, in IndexedDB
// (`pix3-flush-ledgers`). Headless Chrome, real input over CDP, judged by the bytes on disk,
// IndexedDB and the notices banner:
//   1. the editor flushes a rename → a ledger record with the sha of that write;
//   2. the tab closes, an agent writes the file it read before the flush → the next tab says
//      "An agent overwrote your edit" → "Restore my edit" writes it back;
//   3. a reload on the editor's own write adopts the record: a stale write while that tab is open
//      is caught (a tab without the ledger would follow it silently);
//   4. the tab closes, an agent edits the file it read after the flush → no notice, record spent.
//
// Usage: node ledger-reopen.mjs [--core <checkout>]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEEP,
  HERE,
  click,
  key,
  makeChecks,
  makeProject,
  openEditor as openTab,
  resolveCore,
  sleep,
  startChrome,
  startServer,
  waitUntil,
} from './harness.mjs';

const CORE = resolveCore();
const PROJ = makeProject(CORE, 'recipe-tapper-2d', join(HERE, 'proj-ledger'));
const SCENE = join(PROJ, 'scenes/main.pix3scene');
const SCENE_PATH = 'scenes/main.pix3scene';
const disk = () => readFileSync(SCENE, 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const { results, check, finish } = makeChecks();

const { server, base } = await startServer(CORE, PROJ, join(HERE, '.vite-cache-ledger'));
const { chrome, browser } = await startChrome(join(HERE, 'profile-ledger'));

const openEditor = async name => {
  const page = await openTab(browser, base, name);
  await sleep(800);
  return page;
};
const closePage = page => browser.send('Target.closeTarget', { targetId: page.targetId });
const blur = page => page.evaluate(`(() => { ${DEEP} for (const el of deep(document, 'input, textarea')) el.blur(); document.activeElement?.blur?.(); return true; })()`);
const rename = async (page, nodeId, text) => {
  await click(page, `[data-node-id="${nodeId}"]`);
  await sleep(250);
  const input = `(() => { ${DEEP} return deep(document, 'pix3-inspector-panel input[type=text]')[0]; })()`;
  await page.evaluate(`${input}.focus(), ${input}.select()`);
  await page.send('Input.insertText', { text });
  await key(page, 'Enter', 'Enter', 13);
  await blur(page);
};
const notices = page => page.evaluate(`(() => { ${DEEP} return deep(document, '[data-notice-id]').map(n => n.textContent.replace(/\\s+/g, ' ').trim()); })()`);
const clobberNotice = async page => (await notices(page)).find(n => n.includes(`An agent overwrote your edit in ${SCENE_PATH}`)) ?? null;
const restore = page => click(page, `[data-notice-id="clobber:${SCENE_PATH}"] .host-banner__action`);
/** The ledger records of this origin's `pix3-flush-ledgers`, by path. */
const ledgers = page => page.evaluate(`new Promise(r => { const q = indexedDB.open('pix3-flush-ledgers'); q.onsuccess = () => { try { const g = q.result.transaction('ledgers', 'readonly').objectStore('ledgers').getAll(); g.onsuccess = () => r(g.result.map(x => ({ path: x.path, sha: x.sha, keys: x.keys.length, nodes: x.nodes.length }))); g.onerror = () => r([]); } catch { r([]); } }; q.onerror = () => r(null); })`);
const record = async page => (await ledgers(page))?.find(x => x.path === SCENE_PATH) ?? null;
const writer = page => page.evaluate(`(async () => (await window.__PIX3_DEBUG__.status()).writer)()`);
const graphName = (page, id) => page.evaluate(`(async () => (await window.__PIX3_DEBUG__.node(${JSON.stringify(id)}))?.name ?? null)()`);

const pages = [];
try {
  // --- 1. a flush stores the ledger ---------------------------------------------------------------
  const A = await openEditor('A');
  pages.push(A);
  check('A is the writer', (await writer(A)) === 'self');
  // The fixture is a pre-W21 file: the first write converts it. Warm up, then measure on top.
  await rename(A, 'board', 'Board Warm');
  check('warm-up rename on disk', (await waitUntil(() => disk().includes('name: Board Warm'), 8000)).v);
  const beforeFlush = disk(); // what an agent that read now would hold
  await rename(A, 'board', 'Board Mine');
  check('the rename is on disk', (await waitUntil(() => disk().includes('name: Board Mine'), 8000)).v);
  const flushed = disk();
  const stored = await waitUntil(async () => { const r = await record(A); return r?.sha === sha(flushed) ? r : null; }, 5000);
  check('1. IndexedDB holds the ledger with the sha of that write', !!stored.v, { record: await record(A), disk: sha(flushed) });

  // --- 2. a stale write while no tab has the scene -------------------------------------------------
  await closePage(A);
  pages.length = 0;
  await sleep(500);
  writeFileSync(SCENE, beforeFlush); // the agent's write of a file it read before the flush
  await sleep(500);
  const B = await openEditor('B');
  pages.push(B);
  check('B is the writer', (await writer(B)) === 'self');
  const offered = await waitUntil(() => clobberNotice(B), 8000);
  check('2. reopened: "An agent overwrote your edit" names Board', !!offered.v && /Board/.test(offered.v), await notices(B));
  check('…the disk keeps the agent version until Restore', disk() === beforeFlush);
  check('…the graph shows the disk', (await graphName(B, 'board')) === 'Board Warm', await graphName(B, 'board'));
  await restore(B);
  const restored = await waitUntil(() => disk().includes('name: Board Mine'), 5000);
  check('"Restore my edit" writes the edit back', restored.v, { ms: restored.ms });
  const afterRestore = disk();
  const restoredRecord = await waitUntil(async () => (await record(B))?.sha === sha(afterRestore), 5000);
  check('…and the stored ledger follows that write', restoredRecord.v, { record: await record(B), disk: sha(afterRestore) });

  // --- 3. a reload on the own write adopts the ledger -----------------------------------------------
  await closePage(B);
  pages.length = 0;
  await sleep(500);
  const C = await openEditor('C');
  pages.push(C);
  await sleep(1500);
  check('3. reopened on its own write: no notice', (await clobberNotice(C)) === null, await notices(C));
  check('…the record is kept (adopted, not spent)', (await record(C))?.sha === sha(afterRestore), await record(C));
  writeFileSync(SCENE, beforeFlush); // the same stale read, now while C has the scene open
  const caught = await waitUntil(() => clobberNotice(C), 8000);
  check('…a stale write while C is open is caught (the adopted ledger)', !!caught.v, await notices(C));
  await restore(C);
  check('…Restore writes the edit back', (await waitUntil(() => disk().includes('name: Board Mine'), 5000)).v);
  const afterSecond = disk();
  await waitUntil(async () => (await record(C))?.sha === sha(afterSecond), 5000);

  // --- 4. an agent that read after the flush ---------------------------------------------------------
  await closePage(C);
  pages.length = 0;
  await sleep(500);
  const fresh = disk();
  if (!fresh.includes('name: HUD')) throw new Error('fixture: no HUD node');
  writeFileSync(SCENE, fresh.replace('name: HUD', 'name: HUD (agent)'));
  await sleep(500);
  const D = await openEditor('D');
  pages.push(D);
  await sleep(1500);
  check('4. an agent that read after the flush: no notice', (await clobberNotice(D)) === null, await notices(D));
  check('…the graph has both the edit and the agent rename', (await graphName(D, 'board')) === 'Board Mine' && /name: HUD \(agent\)/.test(disk()));
  const spent = await waitUntil(async () => (await record(D)) === null, 5000);
  check('…the record is spent', spent.v, await record(D));

  const errors = pages.flatMap(p => p.errors ?? []).filter(e => !/favicon/.test(e.text));
  check('no page errors', errors.length === 0, errors.slice(0, 3));
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  browser.close();
  chrome.kill();
  await server.close();
  void results;
  finish();
}
