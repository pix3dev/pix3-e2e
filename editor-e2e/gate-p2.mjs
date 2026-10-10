// Gate P2 of ../pix3/.plans/pix3-core.md §G.3 («Браузерный гейт P2»), the rows that are not
// about the build (that half is another work item's):
//
//   CDP without the token / with a wrong one   → refused (HTTP and WebSocket; a page's Origin too),
//                                                Chrome has no debugging port at all
//   the window minimized → pix3_game_run        → an outcome with frames > 0
//   kill the dev server                         → banner, edits go on, a draft in IndexedDB;
//                                                `pix3 editor` again (= `npm run editor`) → flushed
//   a second tab with a stale If-Match          → 412, the bytes on disk untouched
//
// Everything runs the way a user's machine does since P2: `pix3 editor --headless` (detached Vite
// + the Chrome owner: headless Chrome over --remote-debugging-pipe behind the token proxy, on
// FREE ports — another agent runs Chrome here too), `pix3 agent-setup claude` → chrome-devtools-mcp
// 1.10.1 started exactly as .mcp.json says (client 1), and this script's raw CDP probe through the
// same proxy with the token (client 2) for what an agent cannot do (minimize a window, read
// IndexedDB, type into the inspector). Judged by state (AGENTS.md rule 10): the bridge, the DOM,
// bytes on disk. Everything started here is stopped at the end.
//
// Usage: node editor-e2e/gate-p2.mjs [--core <pix3-core checkout>]
//   (build the checkout's editor-core and vite-plugin dist first — see README.md)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { McpClient } from '../bridge-e2e/mcp.mjs';
import { Browser, Page, freePort } from './cdp.mjs';

const HERE = import.meta.dirname;
const coreFlag = process.argv.indexOf('--core');
const CORE = resolve(coreFlag >= 0 ? process.argv[coreFlag + 1] : join(HERE, '..', '..', 'pix3-core'));
const CLI = join(CORE, 'packages', 'cli', 'src', 'index.ts');
const PROJ = join(HERE, 'proj-p2');
const HOME = join(HERE, 'home-p2');
const CHROME_SH = join(HERE, '..', 'chrome.sh');
const PID_FILE = join(HOME, 'chrome.pid');
const { default: WebSocket } = await import(pathToFileURL(join(CORE, 'node_modules', 'ws', 'wrapper.mjs')).href);

const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const waitUntil = async (fn, timeoutMs = 8000, step = 100) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { v, ms: -1 };
    await sleep(step);
  }
};

const env = { ...process.env, PIX3_HOME: HOME, PIX3_CHROME: join(HOME, 'chrome-wrapper.sh'), FORCE_COLOR: '0' };
const cli = (...args) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
};

/** TCP ports a process listens on (Linux: its socket inodes in /proc/net/tcp{,6}). */
const listeningPorts = pid => {
  const inodes = new Set();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (m) inodes.add(m[1]);
    } catch {
      // closed meanwhile
    }
  }
  const ports = [];
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[3] === '0A' && inodes.has(f[9])) ports.push(parseInt(f[1].split(':')[1], 16));
    }
  }
  return ports;
};

/** A WebSocket upgrade to the proxy: 'open' or the HTTP status that refused it. */
const tryWs = (port, headers) =>
  new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pix3`, { headers });
    ws.once('unexpected-response', (_req, r) => res(`HTTP ${r.statusCode}`));
    ws.once('error', e => res(`error ${e.message}`));
    ws.once('open', () => {
      ws.close();
      res('open');
    });
  });

const pids = () => (existsSync(PID_FILE) ? readFileSync(PID_FILE, 'utf8').trim().split('\n').map(Number).filter(Boolean) : []);
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// --- project ------------------------------------------------------------------------------------
rmSync(PROJ, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
{
  const made = spawnSync(process.execPath, [CLI, 'new', 'recipe-tapper-2d', PROJ, '--name', 'gate-p2'], {
    cwd: HERE,
    env: { ...process.env, PIX3_TEMPLATES_DIR: join(CORE, 'packages', 'runtime', 'fixtures', 'scene-corpus') },
    encoding: 'utf8',
  });
  if (made.status !== 0) throw new Error(`pix3 new failed: ${made.stderr}`);
  symlinkSync(join(CORE, 'node_modules'), join(PROJ, 'node_modules'));
  writeFileSync(join(PROJ, 'index.html'), '<!doctype html><html><body><div id="app"></div></body></html>\n');
  writeFileSync(
    join(PROJ, 'vite.config.ts'),
    "import { defineConfig } from 'vite';\nimport { pix3 } from '@pix3/vite-plugin';\n\nexport default defineConfig({ plugins: [pix3()], server: { host: '127.0.0.1' }, cacheDir: '.vite-cache' });\n"
  );
  writeFileSync(join(PROJ, 'package.json'), '{ "name": "gate-p2-proj", "private": true, "type": "module" }\n');
}
writeFileSync(join(HOME, 'chrome-wrapper.sh'), `#!/usr/bin/env bash\necho $$ >> ${PID_FILE}\nprintf '%s\\n' "$@" > ${join(HOME, 'chrome-args.txt')}\nexec ${CHROME_SH} --window-size=1400,900 "$@"\n`, { mode: 0o755 });
const killAll = () => {
  for (const pid of pids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
};
process.once('exit', killAll);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => process.exit(130));

let mcp = null;
let probe = null;
const cdpPort = await freePort();
const devPort = await freePort();
try {
  // --- launch -----------------------------------------------------------------------------------
  const editor = cli('editor', '--headless', '--cdp-port', String(cdpPort), '--port', String(devPort));
  check('pix3 editor: dev server + Chrome behind the proxy', editor.status === 0 && /launched behind the CDP proxy/.test(editor.out), { ms: editor.ms, out: editor.out.trim().split('\n') });
  const devInfo = JSON.parse(readFileSync(join(PROJ, '.pix3', 'dev.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(HOME, 'chrome.json'), 'utf8'));
  const token = readFileSync(join(HOME, 'cdp-token'), 'utf8').trim();
  const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${state.ownerPid}/status`, 'utf8'))?.[1];
  console.log(`MEASURE pix3 editor ${editor.ms} ms (Vite start included); owner pid ${state.ownerPid} RSS ${Math.round(Number(rss) / 1024)} MiB`);
  const auth = { Authorization: `Bearer ${token}` };

  // --- CDP without the token ----------------------------------------------------------------------
  const chromeArgs = readFileSync(join(HOME, 'chrome-args.txt'), 'utf8').split('\n');
  const chromePid = pids()[0];
  check('Chrome runs on --remote-debugging-pipe, no debugging port flag', chromeArgs.includes('--remote-debugging-pipe') && !chromeArgs.some(a => a.startsWith('--remote-debugging-port')), chromeArgs.filter(a => a.startsWith('--remote')));
  check('Chrome listens on no TCP port at all', listeningPorts(chromePid).length === 0, listeningPorts(chromePid));
  check('the token file is 0600', (statSync(join(HOME, 'cdp-token')).mode & 0o777) === 0o600);
  const httpNone = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const httpWrong = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } });
  const httpRight = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { headers: auth });
  check('CDP discovery without a token / with a wrong one: 401; with the token: the tabs', httpNone.status === 401 && httpWrong.status === 401 && httpRight.status === 200, [httpNone.status, httpWrong.status, httpRight.status]);
  const wsNone = await tryWs(cdpPort, {});
  const wsWrong = await tryWs(cdpPort, { Authorization: 'Bearer ' + token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a') });
  const wsPage = await tryWs(cdpPort, { ...auth, Origin: devInfo.url.replace(/\/$/, '') });
  const wsRight = await tryWs(cdpPort, auth);
  check('CDP WebSocket without a token / with a wrong one: refused (401); from a page: refused (403)', wsNone === 'HTTP 401' && wsWrong === 'HTTP 401' && wsPage === 'HTTP 403' && wsRight === 'open', { wsNone, wsWrong, wsPage, wsRight });

  // --- the window minimized → pix3_game_run (before chrome-devtools-mcp attaches: it emulates a
  // focused page on the tab it selects, and a focused page stays visible — measured below) --------
  probe = await Browser.connect(cdpPort, token);
  const { targetInfos } = await probe.send('Target.getTargets');
  const editorTarget = targetInfos.find(t => t.type === 'page' && t.url === devInfo.editorUrl);
  const { sessionId } = await probe.send('Target.attachToTarget', { targetId: editorTarget.targetId, flatten: true });
  const pageA = new Page(probe, sessionId, editorTarget.targetId, 'A');
  probe.sessions.set(sessionId, pageA);
  await pageA.send('Runtime.enable');
  await pageA.waitFor(`(async () => { const s = window.__PIX3_DEBUG__ && (await window.__PIX3_DEBUG__.call('pix3_status')); return s && s.activeScene && s.scriptsStatus === 'ready'; })()`, 60000);
  const call = (name, params = {}) => pageA.evaluate(`window.__PIX3_DEBUG__.call(${JSON.stringify(name)}, ${JSON.stringify(params)})`);
  const { windowId } = await probe.send('Browser.getWindowForTarget', { targetId: editorTarget.targetId });
  await probe.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await sleep(300);
  const minimized = await pageA.evaluate(`({ visibility: document.visibilityState, focus: document.hasFocus() })`);
  const bounds = await probe.send('Browser.getWindowBounds', { windowId });
  check('the editor window is minimized: hidden, unfocused', minimized.visibility === 'hidden' && minimized.focus === false && bounds.bounds.windowState === 'minimized', { ...minimized, windowState: bounds.bounds.windowState });
  const rafProbe = `new Promise(r => { let n = 0; const f = () => { n++; requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(() => r(n), 600); })`;
  const rafFrames = await pageA.evaluate(rafProbe);
  check('control: requestAnimationFrame does not run in the minimized window', rafFrames === 0, { rafFramesIn600ms: rafFrames });
  const start = await call('pix3_play', { action: 'start' });
  const t0 = Date.now();
  const run = await call('pix3_game_run', { until: [{ kind: 'frames', n: 30 }], maxFrames: 120 });
  check('minimized: pix3_game_run gives an outcome with frames > 0', start?.ok === true && run?.ok === true && typeof run.verdict === 'string' && run.metrics?.frames > 0, { start: start?.ok ?? start, verdict: run?.verdict ?? run, frames: run?.metrics?.frames, ms: Date.now() - t0 });
  const stopPlay = await call('pix3_play', { action: 'stop' });
  check('minimized: the agent stops its play', stopPlay?.ok === true && stopPlay.playing === false, stopPlay);
  const stillHidden = await pageA.evaluate(`document.visibilityState`);

  // --- the two clients ------------------------------------------------------------------------------
  const setup = cli('agent-setup', 'claude');
  check('agent-setup writes the proxy launch', setup.status === 0, setup.out.split('\n')[0]);
  const launch = JSON.parse(readFileSync(join(PROJ, '.mcp.json'), 'utf8')).mcpServers['pix3-browser'];
  mcp = new McpClient({ command: launch.command, args: [...launch.args, '--no-usage-statistics', '--no-performance-crux'] });
  await mcp.start();
  let pageId = null;
  for (let i = 0; i < 60 && pageId === null; i++) {
    const line = (await mcp.call('list_pages')).text.split('\n').find(l => l.includes('/__pix3/'));
    const id = line && /(\d+):/.exec(line)?.[1];
    if (id) pageId = Number(id);
    else await sleep(500);
  }
  mcp.page = pageId;
  await mcp.call('select_page', { pageId });
  let status = null;
  for (let i = 0; i < 120 && !status; i++) {
    const r = await mcp.evaluate(`async () => (window.__PIX3_DEBUG__ ? await window.__PIX3_DEBUG__.call('pix3_status') : null)`);
    if (r.value?.activeScene && r.value.scriptsStatus === 'ready') status = r.value;
    else await sleep(500);
  }
  check('chrome-devtools-mcp (client 1) reaches the editor through the proxy', status?.writer === 'self', status && { activeScene: status.activeScene });
  const SCENE_REL = status.activeScene.replace(/^res:\/\//, '');
  const SCENE = join(PROJ, SCENE_REL);
  const disk = () => readFileSync(SCENE, 'utf8');

  check('the raw probe (client 2) reads the same tab at the same time', (await pageA.evaluate(`window.__PIX3_DEBUG__.call('pix3_status').then(s => s.activeScene)`)) === status.activeScene);
  await mcp.call('list_3p_developer_tools');
  // Still minimized, now with chrome-devtools-mcp attached: the 3p tool runs too.
  const withMcp = await pageA.evaluate(`({ visibility: document.visibilityState, focus: document.hasFocus() })`);
  const start3p = await mcp.pix3('pix3_play', { action: 'start' });
  const run3p = await mcp.pix3('pix3_game_run', { until: [{ kind: 'frames', n: 30 }], maxFrames: 120 });
  await mcp.pix3('pix3_play', { action: 'stop' });
  check('minimized, through chrome-devtools-mcp: pix3_game_run frames > 0', start3p.value?.ok === true && run3p.value?.ok === true && run3p.value.metrics?.frames > 0, { before: stillHidden, withMcp, verdict: run3p.value?.verdict ?? run3p.text.slice(0, 200), frames: run3p.value?.metrics?.frames });
  await probe.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  const ownerLog = readFileSync(join(HOME, 'chrome-owner.log'), 'utf8');
  check('the owner served both clients at once', /client connected \(browser; 2 now\)/.test(ownerLog), ownerLog.split('\n').filter(l => /client/.test(l)).slice(-3));

  // --- kill the dev server → banner, edits go on, a draft; pix3 editor → flush ---------------------
  const before = disk();
  process.kill(devInfo.pid, 'SIGKILL');
  const banner = await waitUntil(async () => (await pageA.evaluate(`(() => { ${DEEP} return deep(document, '.host-banner--error').map(e => e.textContent.replace(/\\s+/g, ' ').trim()); })()`)).some(t => /Dev server disconnected/.test(t)), 8000);
  check('dev server killed: the banner says so', banner.v, { ms: banner.ms });
  // A designer's edit while it is down: rename the subtitle label in the inspector.
  const rect = await pageA.evaluate(`(() => { ${DEEP} const el = deep(document, '[data-node-id="subtitle-label"]')[0]; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await pageA.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(300);
  const input = `(() => { ${DEEP} return deep(document, 'pix3-inspector-panel input[type=text]')[0]; })()`;
  await pageA.evaluate(`${input}.focus(), ${input}.select()`);
  await pageA.send('Input.insertText', { text: 'Subtitle While Down' });
  for (const type of ['keyDown', 'keyUp']) await pageA.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await pageA.evaluate(`(() => { ${DEEP} for (const el of deep(document, 'input')) el.blur(); return true; })()`);
  const inMemory = await waitUntil(async () => (await pageA.evaluate(`window.__PIX3_DEBUG__.node('subtitle-label').then(n => n?.name)`)) === 'Subtitle While Down', 3000);
  const dirty = await pageA.evaluate(`window.__PIX3_DEBUG__.status().then(s => s.dirty.length)`);
  check('dev server down: the edit goes on in memory (scene dirty)', inMemory.v && dirty === 1, { dirty });
  await sleep(3000); // ≥ one 2 s draft checkpoint
  const draft = await pageA.evaluate(`new Promise(r => { const q = indexedDB.open('pix3-drafts'); q.onsuccess = () => { const tx = q.result.transaction('drafts', 'readonly'); const g = tx.objectStore('drafts').getAll(); g.onsuccess = () => r(g.result.map(d => ({ path: d.path, has: d.text.includes('Subtitle While Down') }))); }; q.onerror = () => r(null); })`);
  check('dev server down: a draft of the edit is in IndexedDB', Array.isArray(draft) && draft.some(d => d.path === SCENE_REL && d.has), draft);
  check('dev server down: nothing reached the disk', disk() === before);
  const restart = cli('editor', '--headless', '--cdp-port', String(cdpPort), '--port', String(devPort));
  check('pix3 editor again (npm run editor): a new dev server, the same Chrome and tab', restart.status === 0 && /starting a new one/.test(restart.out) && /the editor tab is open there/.test(restart.out), { ms: restart.ms, out: restart.out.trim().split('\n') });
  const flushed = await waitUntil(() => disk().includes('Subtitle While Down'), 15000, 100);
  check('after pix3 editor: the edit is flushed to disk', flushed.v, { ms: flushed.ms });
  const bannerGone = await waitUntil(async () => !(await pageA.evaluate(`(() => { ${DEEP} return deep(document, '.host-banner--error').length > 0; })()`)), 5000);
  check('after pix3 editor: the banner is gone, the scene clean', bannerGone.v && (await pageA.evaluate(`window.__PIX3_DEBUG__.status().then(s => s.dirty.length)`)) === 0);
  const syncAfter = await mcp.pix3('pix3_sync', { expect: { [SCENE_REL]: sha256(disk()) }, timeoutMs: 15000 });
  check('after pix3 editor: pix3_sync through MCP is ok with the flushed bytes', syncAfter.value?.ok === true && syncAfter.value.expectMismatch?.length === 0, { ok: syncAfter.value?.ok, reason: syncAfter.value?.reason, text: syncAfter.value ? undefined : syncAfter.text.slice(0, 300) });

  // --- a second tab with a stale If-Match → 412 ------------------------------------------------------
  const pageB = await probe.newPage('B');
  await pageB.navigate(devInfo.editorUrl);
  await pageB.waitFor(`(async () => !!window.__PIX3_DEBUG__ && !!(await window.__PIX3_DEBUG__.status()).activeScene)()`, 60000);
  check('second tab opens read-only', (await pageB.evaluate(`window.__PIX3_DEBUG__.status().then(s => s.writer)`)) === 'other');
  await pageB.evaluate(`window.dispatchEvent(new CustomEvent('pix3-take-over'))`);
  const tookOver = await waitUntil(async () => (await pageB.evaluate(`window.__PIX3_DEBUG__.status().then(s => s.writer)`)) === 'self', 5000);
  const tabB = (await pageB.evaluate(`window.__PIX3_DEBUG__.sync({ timeoutMs: 8000 })`)).tabId;
  check('second tab takes over the writer', tookOver.v && typeof tabB === 'string', { tabB });
  const fileUrl = `/__pix3/api/file?path=${encodeURIComponent(SCENE_REL)}`;
  const staleTag = await pageB.evaluate(`fetch(${JSON.stringify(fileUrl)}).then(r => r.headers.get('etag'))`);
  // The agent edits the file after tab B read it.
  writeFileSync(SCENE, disk().replace('Subtitle While Down', 'Subtitle By Agent'));
  const agentBytes = disk();
  await mcp.pix3('pix3_sync', { timeoutMs: 15000 });
  const refused = await pageB.evaluate(`fetch(${JSON.stringify(fileUrl)}, { method: 'PUT', headers: { 'If-Match': ${JSON.stringify(staleTag)}, 'X-Pix3': '1', 'X-Pix3-Writer': ${JSON.stringify(tabB)}, 'Content-Type': 'application/octet-stream' }, body: 'stale bytes from tab B\\n' }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
  check('second tab, stale If-Match: 412 base_mismatch naming the current hash', refused.status === 412 && JSON.stringify(refused.body).includes('base_mismatch') && JSON.stringify(refused.body).includes(sha256(agentBytes)), refused);
  check('second tab, stale If-Match: the bytes on disk are not overwritten', disk() === agentBytes);
  // Control: the same PUT with the current tag goes through (it writes the same bytes back).
  const current = await pageB.evaluate(`fetch(${JSON.stringify(fileUrl)}, { method: 'PUT', headers: { 'If-Match': ${JSON.stringify(`"${sha256(agentBytes)}"`)}, 'X-Pix3': '1', 'X-Pix3-Writer': ${JSON.stringify(tabB)}, 'Content-Type': 'application/octet-stream' }, body: ${JSON.stringify(agentBytes)} }).then(r => r.status)`);
  check('control: the current If-Match is accepted', current === 200 && disk() === agentBytes, { status: current });
  await probe.send('Target.closeTarget', { targetId: pageB.targetId });

  const errors = await mcp.pix3('pix3_errors', {});
  check('pix3_errors answers (reported, not judged: the dev-server kill makes fetches fail)', errors.value?.ok === true, { count: errors.value?.count, first: errors.value?.errors?.slice(0, 2), text: errors.value ? undefined : errors.text.slice(0, 300) });
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  mcp?.close();
  probe?.close();
  const stop = cli('editor', '--stop');
  const stopChrome = cli('editor', '--stop-chrome');
  console.log(stop.out.trim(), '/', stopChrome.out.trim());
  await sleep(500);
  check('cleanup: no Chrome left, chrome.json removed', pids().every(pid => !alive(pid)) && !existsSync(join(HOME, 'chrome.json')), { alive: pids().filter(alive) });
  killAll();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
