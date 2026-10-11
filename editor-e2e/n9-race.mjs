// write-model debt "N9 flake" (W18): the reopened tab rejected the IndexedDB draft as "the file
// changed on disk since". Cause: the dev server is stopped right after a save landed on disk but
// before its HTTP answer reached the tab (Vite destroys open sockets on close; the plugin journals
// the version after the rename and only then answers). The tab saw a network failure, kept the
// old baseline, and its next draft was keyed to a sha the disk no longer had.
//
// Each round: open the editor, rename, Ctrl+S, stop the server THE MOMENT the bytes are on disk
// (tight poll — the gate's 20 ms poll + CDP round trips made this rare), rename again while the
// server is down, wait for a draft checkpoint, close the tab, restart, reopen: is the draft offered
// and restored? Green = offered and restored in every round (exit 1 otherwise).
//
//   node n9-race.mjs [rounds=5] [--core <checkout>]     (a fresh proj-race/ from the corpus)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bridge, click, DEEP, HERE, key, makeProject, openEditor, resolveCore, sleep, startChrome, startServer } from './harness.mjs';

const CORE = resolveCore();
const PROJ = makeProject(CORE, 'recipe-tapper-2d', join(HERE, 'proj-race'));
const SCENE = join(PROJ, 'scenes/main.pix3scene');
const ROUNDS = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 5);
const disk = () => readFileSync(SCENE, 'utf8');
const sha = () => createHash('sha256').update(readFileSync(SCENE)).digest('hex');

let server = null;
let base = '';
let port = null; // kept across restarts: the draft lives in the origin's IndexedDB
const startDevServer = async () => {
  ({ server, base, port } = await startServer(CORE, PROJ, join(HERE, '.vite-cache-race'), port));
};
const { chrome, browser } = await startChrome(join(HERE, 'profile-race'));

const openTab = async name => {
  const page = await browser.newPage(name);
  page.reqs = new Map();
  await page.send('Network.enable');
  const onEvent = page.onEvent.bind(page);
  page.onEvent = (method, params) => {
    onEvent(method, params);
    if (method === 'Network.requestWillBeSent' && /__pix3\/api\/(file|changeset)/.test(params.request.url) && !['GET', 'HEAD'].includes(params.request.method)) page.reqs.set(params.requestId, { verb: params.request.method, status: null });
    if (method === 'Network.responseReceived' && page.reqs.has(params.requestId)) page.reqs.get(params.requestId).status = params.response.status;
    if (method === 'Network.loadingFailed' && page.reqs.has(params.requestId)) page.reqs.get(params.requestId).status = 'failed:' + params.errorText;
  };
  await page.navigate(`${base}/__pix3/`);
  await page.waitFor(`(async () => !!window.__PIX3_DEBUG__ && !!(await window.__PIX3_DEBUG__.status()).activeScene)()`, 60000);
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
const drafts = page => page.evaluate(`new Promise(r => { const q = indexedDB.open('pix3-drafts'); q.onsuccess = () => { const tx = q.result.transaction('drafts', 'readonly'); const g = tx.objectStore('drafts').getAll(); g.onsuccess = () => r(g.result.map(d => ({ baselineSha: d.baselineSha, has: d.text.includes('Draft') }))); }; q.onerror = () => r(null); })`);

const tally = { offered: 0, restored: 0, rejected: 0, other: 0, lostAnswer: 0 };
try {
  await startDevServer();
  for (let round = 1; round <= ROUNDS; round++) {
    const page = await openTab(`r${round}`);
    const saved = `Board Saved ${round}`;
    await rename(page, 'board', saved);
    // Ctrl+S, then stop the server the moment the bytes are on disk.
    void key(page, 's', 'KeyS', 83, 2);
    const t0 = Date.now();
    while (!disk().includes(`name: ${saved}`) && Date.now() - t0 < 5000) await new Promise(r => setImmediate(r));
    const landed = disk().includes(`name: ${saved}`);
    await server.close();
    await sleep(300);
    const answers = [...page.reqs.values()].map(r => r.status);
    const lost = answers.some(s => typeof s === 'string' || s === null);
    if (lost) tally.lostAnswer++;
    const stateAfterSave = (await bridge(page).status()).dirty;
    await rename(page, 'board', `Board Draft ${round}`);
    await sleep(3000); // ≥ one 2 s checkpoint
    const d = await drafts(page);
    const diskSha = sha();
    await closePage(page);
    await startDevServer();
    const reopened = await openTab(`r${round}b`);
    const seen = await (async () => { for (let i = 0; i < 50; i++) { const n = await notices(reopened); if (n.some(t => /Unsaved edits/.test(t))) return n; await sleep(100); } return notices(reopened); })();
    const offered = seen.some(t => /Unsaved edits .* were found/.test(t));
    const rejected = seen.some(t => /were not restored: the file changed on disk since/.test(t));
    tally[offered ? 'offered' : rejected ? 'rejected' : 'other']++;
    console.log(JSON.stringify({ round, landed, answers, dirtyAfterSave: stateAfterSave, draftBaseline: d?.map(x => x.baselineSha.slice(0, 8)), diskSha: diskSha.slice(0, 8), offered, rejected, notices: seen.map(t => t.slice(0, 120)) }));
    // Restore the offered draft (it must reach the disk), then start the next round from a new tab.
    if (offered) {
      await click(reopened, '[data-notice-id] .host-banner__action');
      const t1 = Date.now();
      while (!disk().includes(`name: Board Draft ${round}`) && Date.now() - t1 < 5000) await sleep(50);
      if (disk().includes(`name: Board Draft ${round}`)) tally.restored++;
      else console.log('restore did not reach the disk');
    }
    await closePage(reopened);
    await sleep(300);
  }
} catch (error) {
  console.log('RUN FAILED', error?.stack ?? error);
  tally.other++;
} finally {
  browser.close();
  chrome.kill();
  await server?.close();
  const green = tally.offered === ROUNDS && tally.restored === ROUNDS && tally.rejected === 0 && tally.other === 0;
  console.log('TALLY', JSON.stringify(tally), green ? `\n${ROUNDS}/${ROUNDS} rounds offered and restored` : `\nFAIL: ${tally.offered}/${ROUNDS} offered, ${tally.restored}/${ROUNDS} restored`);
  process.exit(green ? 0 : 1);
}
