// Bridge v1 end to end (pix3-core plan §D.1, §B.3, §D.4, §D.5, §D.6; .plans/agent-bridge.md):
//
//   pix3 editor  → the project's Vite dev server (detached, .pix3/dev.json) + headless Chrome
//                  owned through --remote-debugging-pipe behind the CDP token proxy on a FREE
//                  port (never a fixed one: another agent runs Chrome here too)
//   pix3 agent-setup → .mcp.json with the pinned chrome-devtools-mcp launch for that port
//                  (--wsEndpoint ws://127.0.0.1:<port>/pix3 + --wsHeaders with the token)
//   chrome-devtools-mcp (started exactly as .mcp.json says) → list_pages / select_page /
//                  list_3p_developer_tools / execute_3p_developer_tool
//
// Checks: the page tools are listed; a file edit + pix3_sync {expect} answers ok and the editor
// holds the new value; agent play → edit → sync is `stale, playing:'agent'` → restart → sync ok →
// new value live; designer play (F6 through press_key) → `stop force` is not_owner and sync is
// `stale, playing:'designer'`; the inline fallback (evaluate_script over __PIX3_DEBUG__) answers
// the same; `pix3 agent-setup` is idempotent and --repair migrates a P1 --browserUrl entry; the
// proxy refuses a missing or wrong token; a raw CDP probe shares the pipe with the MCP server.
// Everything started here is stopped at the end.
//
// Usage: node bridge-e2e/run.mjs [--core <pix3-core checkout>]   (after bridge-e2e/setup.sh)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

import { pathToFileURL } from 'node:url';

import { McpClient } from './mcp.mjs';

const HERE = import.meta.dirname;
const coreFlag = process.argv.indexOf('--core');
const CORE = resolve(coreFlag >= 0 ? process.argv[coreFlag + 1] : join(HERE, '..', '..', 'pix3-core-bridge'));
const CLI = join(CORE, 'packages', 'cli', 'src', 'index.ts');
// `ws` from the checkout under test (this folder has no node_modules of its own).
const { default: WebSocket } = await import(pathToFileURL(join(CORE, 'node_modules', 'ws', 'wrapper.mjs')).href);
const PROJ = join(HERE, 'proj');
const HOME = join(HERE, 'home');
const CHROME_SH = join(HERE, '..', 'chrome.sh');
const PID_FILE = join(HOME, 'chrome.pid');
// The scene the editor opens is the manifest's entry scene (menu.pix3scene in the tapper recipe);
// the edits below go to whichever scene is active, through its `subtitle-label` / `game-root`.
let SCENE = join(PROJ, 'scenes', 'menu.pix3scene');
const LABEL_LINE = /(id: subtitle-label[\s\S]*?label: )"([^"]*)"/;
const withLabel = (text, value) => text.replace(LABEL_LINE, (_, head) => `${head}"${value}"`);
const labelOf = answer => answer?.value?.saved?.properties?.label ?? answer?.value?.node?.properties?.label;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`);
};
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const env = { ...process.env, PIX3_HOME: HOME, PIX3_CHROME: join(HOME, 'chrome-wrapper.sh'), FORCE_COLOR: '0' };
const cli = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

/** TCP ports a process listens on (Linux: its socket inodes in /proc/net/tcp{,6}). */
const listeningPorts = pid => {
  const inodes = new Set();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m) inodes.add(m[1]);
      } catch {
        // closed meanwhile
      }
    }
  } catch {
    return null;
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

/** A raw CDP client through the proxy: resolves with {send, close} or rejects with the refusal. */
const rawCdp = (port, headers) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pix3`, { headers, perMessageDeflate: false });
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
    ws.once('open', () => {
      let id = 0;
      const pending = new Map();
      ws.on('message', raw => {
        const m = JSON.parse(String(raw));
        if (m.id !== undefined && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      });
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise(r => {
            const i = ++id;
            pending.set(i, r);
            ws.send(JSON.stringify({ id: i, method, params, sessionId }));
          }),
        close: () => ws.close(),
      });
    });
  });

const killChrome = () => {
  try {
    for (const line of readFileSync(PID_FILE, 'utf8').split('\n')) {
      const pid = Number(line.trim());
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
    }
  } catch {
    // never started
  }
};

let originalScene = readFileSync(SCENE, 'utf8');
let mcp = null;
let cdpPort = 0;
try {
  if (!existsSync(join(PROJ, 'pix3project.yaml'))) throw new Error('run bridge-e2e/setup.sh first');
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  // A "Chrome" that records its pid and execs the headless shell with the arguments pix3 editor gives.
  // The pipe is fds 3 and 4: `exec` hands them to Chrome as they are.
  writeFileSync(join(HOME, 'chrome-wrapper.sh'), `#!/usr/bin/env bash\necho $$ >> ${PID_FILE}\nprintf '%s\\n' "$@" > ${join(HOME, 'chrome-args.txt')}\nexec ${CHROME_SH} "$@"\n`, { mode: 0o755 });
  process.once('exit', killChrome);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => process.exit(130));

  // 1. pix3 editor: dev server + Chrome on a free port.
  cdpPort = await freePort();
  const t0 = Date.now();
  const editor = cli('editor', '--headless', '--cdp-port', String(cdpPort), '--port', String(await freePort()));
  check('pix3 editor exits 0', editor.status === 0, { out: editor.out, err: editor.err, ms: Date.now() - t0 });
  const devInfo = JSON.parse(readFileSync(join(PROJ, '.pix3', 'dev.json'), 'utf8'));
  check('dev.json written by the plugin', typeof devInfo.editorUrl === 'string' && devInfo.pid > 0, devInfo.editorUrl);
  const chromeState = JSON.parse(readFileSync(join(HOME, 'chrome.json'), 'utf8'));
  check('chrome.json records the free port, the owner and the proxy', chromeState.port === cdpPort && chromeState.ownerPid > 0 && chromeState.proxy === 1, chromeState);
  const token = readFileSync(join(HOME, 'cdp-token'), 'utf8').trim();
  const tokenMode = (await import('node:fs')).statSync(join(HOME, 'cdp-token')).mode & 0o777;
  check('~/.pix3/cdp-token exists, mode 0600', token.length >= 32 && tokenMode === 0o600, tokenMode.toString(8));
  const chromeArgs = readFileSync(join(HOME, 'chrome-args.txt'), 'utf8').split('\n');
  const chromePid = Number(readFileSync(PID_FILE, 'utf8').trim().split('\n')[0]);
  check('Chrome is launched with --remote-debugging-pipe and no debugging port', chromeArgs.includes('--remote-debugging-pipe') && !chromeArgs.some(a => a.startsWith('--remote-debugging-port')), chromeArgs.filter(a => a.startsWith('--remote')));
  check('Chrome listens on no TCP port', JSON.stringify(listeningPorts(chromePid)) === '[]', listeningPorts(chromePid));
  const auth = { Authorization: `Bearer ${token}` };
  const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { headers: auth })).json();
  check('the proxy answers /json/version to the token', Boolean(version?.Browser) && version.webSocketDebuggerUrl === `ws://127.0.0.1:${cdpPort}/pix3`, version);
  const noToken = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const wrongToken = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { headers: { Authorization: 'Bearer nope' } });
  check('/json/list without a token or with a wrong one is 401', noToken.status === 401 && wrongToken.status === 401, [noToken.status, wrongToken.status]);
  const wsRefusals = [];
  for (const headers of [{}, { Authorization: 'Bearer nope' }, { ...auth, Origin: 'http://example.com' }]) {
    try {
      (await rawCdp(cdpPort, headers)).close();
      wsRefusals.push('accepted');
    } catch (error) {
      wsRefusals.push(error.message);
    }
  }
  check('a CDP WebSocket without the token, with a wrong one or from a page (Origin) is refused', JSON.stringify(wsRefusals) === JSON.stringify(['HTTP 401', 'HTTP 401', 'HTTP 403']), wsRefusals);
  // Running it again reuses both.
  const again = cli('editor', '--headless', '--cdp-port', String(cdpPort));
  check('second pix3 editor reuses the server and the proxy', again.status === 0 && /reused/.test(again.out) && /already behind/.test(again.out) && /editor tab is open/.test(again.out), again.out);

  // 2. pix3 agent-setup: the config the agent would use, pointed at the recorded port. A config
  // from an earlier run (another port) is what --repair is for; the first write starts clean.
  // The P1 entry (open debugging port, no token) is what --repair migrates.
  const p1 = { mcpServers: { 'pix3-browser': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.10.1', '--categoryExperimentalThirdParty=true', '--experimentalVision=true', `--browserUrl=http://127.0.0.1:${cdpPort}`] } } };
  writeFileSync(join(PROJ, '.mcp.json'), JSON.stringify(p1, null, 2));
  const p1Drift = cli('agent-setup', 'claude');
  check('agent-setup names a P1 --browserUrl entry as drift (exit 1)', p1Drift.status === 1 && /P1 launch/.test(p1Drift.out), p1Drift.out.split('\n')[2]);
  const p1Editor = cli('editor', '--headless', '--cdp-port', String(cdpPort));
  check('pix3 editor says the project config does not reach this Chrome', p1Editor.status === 0 && /agent-setup --repair/.test(p1Editor.out), p1Editor.out.split('\n').at(-2));
  const migrated = cli('agent-setup', 'claude', '--repair');
  check('agent-setup --repair migrates it to --wsEndpoint/--wsHeaders', migrated.status === 0 && /repaired/.test(migrated.out), migrated.out.split('\n')[2]);
  check('agent-setup never prints the token', !migrated.out.includes(token) && !p1Drift.out.includes(token) && /<token of ~\/\.pix3\/cdp-token>/.test(migrated.out));
  rmSync(join(PROJ, '.mcp.json.bak'), { force: true });
  rmSync(join(PROJ, '.mcp.json'), { force: true });
  const setup = cli('agent-setup', 'claude');
  check('agent-setup writes .mcp.json for the recorded port', setup.status === 0 && setup.out.includes(`ws://127.0.0.1:${cdpPort}/pix3`), setup.out.split('\n')[0]);
  const setupAgain = cli('agent-setup', 'claude');
  check('agent-setup is idempotent', setupAgain.status === 0 && /up to date/.test(setupAgain.out), setupAgain.out.split('\n')[2]);
  const written = readFileSync(join(PROJ, '.mcp.json'), 'utf8');
  writeFileSync(join(PROJ, '.mcp.json'), written.replace(`127.0.0.1:${cdpPort}`, '127.0.0.1:9333'));
  const drift = cli('agent-setup', 'claude');
  check('agent-setup reports a drifted port and exits 1', drift.status === 1 && /--repair/.test(drift.out), drift.out.split('\n')[2]);
  const repair = cli('agent-setup', 'claude', '--repair');
  check('agent-setup --repair rewrites it (with a .bak) and exits 0', repair.status === 0 && /repaired/.test(repair.out) && readFileSync(join(PROJ, '.mcp.json'), 'utf8') === written && existsSync(join(PROJ, '.mcp.json.bak')), repair.out.split('\n')[2]);
  rmSync(join(PROJ, '.mcp.json.bak'), { force: true });
  const launch = JSON.parse(readFileSync(join(PROJ, '.mcp.json'), 'utf8')).mcpServers['pix3-browser'];
  check('.mcp.json pins chrome-devtools-mcp with the 3p flag', launch.args.some(a => /^chrome-devtools-mcp@\d/.test(a)) && launch.args.includes('--categoryExperimentalThirdParty=true'), launch.args.slice(0, 4));
  check('.mcp.json connects through the proxy with the token', launch.args.includes(`--wsEndpoint=ws://127.0.0.1:${cdpPort}/pix3`) && launch.args.includes(`--wsHeaders={"Authorization":"Bearer ${token}"}`) && !launch.args.some(a => a.startsWith('--browserUrl')));

  // 3. chrome-devtools-mcp, exactly as configured.
  mcp = new McpClient({ command: launch.command, args: [...launch.args, '--no-usage-statistics', '--no-performance-crux'] });
  const tools = await mcp.start();
  check('MCP lists the 3p tools', tools.includes('list_3p_developer_tools') && tools.includes('execute_3p_developer_tool'), tools.filter(t => /3p|evaluate|page|press/.test(t)));
  // The editor tab: wait for the bridge, then select it.
  let pageId = null;
  for (let i = 0; i < 60 && pageId === null; i++) {
    const pages = await mcp.call('list_pages');
    const m = pages.text.split('\n').find(line => line.includes('/__pix3/'));
    const id = m && /(\d+):/.exec(m)?.[1];
    if (id !== undefined && id !== null) pageId = Number(id);
    else await sleep(500);
  }
  check('list_pages shows the editor tab', pageId !== null, pageId);
  mcp.page = pageId;
  await mcp.call('select_page', { pageId });
  // The editor mounts asynchronously: poll status through the inline surface until the scene is open.
  let status = null;
  for (let i = 0; i < 120; i++) {
    const r = await mcp.evaluate(`async () => (window.__PIX3_DEBUG__ ? await window.__PIX3_DEBUG__.call('pix3_status') : null)`);
    if (r.value && r.value.activeScene && r.value.scriptsStatus === 'ready') {
      status = r.value;
      break;
    }
    await sleep(500);
  }
  check('editor mounted: entry scene active, scripts ready, this tab writes', typeof status?.activeScene === 'string' && status?.writer === 'self', status && { activeScene: status.activeScene, writer: status.writer, keepalive: status.keepalive });
  const activeRel = status.activeScene.replace(/^res:\/\//, '');
  SCENE = join(PROJ, activeRel);
  originalScene = readFileSync(SCENE, 'utf8');
  if (!LABEL_LINE.test(originalScene)) throw new Error(`${activeRel} has no subtitle-label; adjust the edit`);

  const listed = await mcp.call('list_3p_developer_tools');
  const names = [...listed.text.matchAll(/pix3_[a-z_]+/g)].map(m => m[0]);
  check('list_3p_developer_tools lists the pix3 group', ['pix3_status', 'pix3_sync', 'pix3_scene', 'pix3_play', 'pix3_game_run', 'pix3_screenshot', 'pix3_errors'].every(n => names.includes(n)), [...new Set(names)]);

  const status3p = await mcp.pix3('pix3_status');
  check('pix3_status through execute_3p_developer_tool', status3p.value?.ok === true && status3p.value.activeScene === status.activeScene, { ms: status3p.ms, play: status3p.value?.play });

  // Our own probe shares the pipe with the MCP server: its own browser session, its own ids.
  const probe = await rawCdp(cdpPort, auth);
  const targets = (await probe.send('Target.getTargets')).result.targetInfos;
  const editorTarget = targets.find(t => t.type === 'page' && /\/__pix3\//.test(t.url));
  const probeSession = (await probe.send('Target.attachToTarget', { targetId: editorTarget.targetId, flatten: true })).result.sessionId;
  const probeEval = (await probe.send('Runtime.evaluate', { expression: `window.__PIX3_DEBUG__.call('pix3_status').then(s => s.activeScene)`, awaitPromise: true, returnByValue: true }, probeSession)).result;
  const [mcpMeanwhile] = await Promise.all([mcp.pix3('pix3_status'), probe.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true }, probeSession)]);
  check('a raw CDP probe and the MCP server share the proxy at once', probeEval?.result?.value === status.activeScene && mcpMeanwhile.value?.ok === true, { probe: probeEval?.result?.value });
  probe.close();
  await sleep(200);
  const afterProbe = await mcp.pix3('pix3_status');
  check('the MCP server keeps working after the probe left', afterProbe.value?.ok === true);

  // 4. A file edit + sync with expect: ok, and the editor holds the new value.
  const edited = withLabel(originalScene, 'E2E ONE');
  if (edited === originalScene) throw new Error('template scene changed; adjust the edit');
  writeFileSync(SCENE, edited);
  const sync1 = await mcp.pix3('pix3_sync', { expect: { [activeRel]: sha256(SCENE) }, timeoutMs: 15000 });
  check('pix3_sync after a scene edit answers ok with the expected hash', sync1.value?.ok === true && Array.isArray(sync1.value.expectMismatch) && sync1.value.expectMismatch.length === 0, { ms: sync1.ms, changed: sync1.value?.changed, rev: sync1.value?.rev });
  const node1 = await mcp.pix3('pix3_scene', { nodeId: 'subtitle-label' });
  check('pix3_scene shows the new value in the editor', labelOf(node1) === 'E2E ONE', { label: labelOf(node1), screen: node1.value?.screen });
  const wrongExpect = await mcp.pix3('pix3_sync', { expect: { [activeRel]: '0'.repeat(64) } });
  check('a wrong expect hash is expect_mismatch', wrongExpect.value?.ok === false && wrongExpect.value.reason === 'expect_mismatch', wrongExpect.value?.expectMismatch);

  // 5. Agent play → edit → sync is stale (agent) → restart → sync ok → new value live.
  const start = await mcp.pix3('pix3_play', { action: 'start' });
  check('pix3_play start as the agent', start.value?.ok === true && start.value.playOwner === 'agent', start.value);
  writeFileSync(SCENE, withLabel(originalScene, 'E2E TWO'));
  const staleSync = await mcp.pix3('pix3_sync', { timeoutMs: 15000 });
  check("sync during agent play is stale, playing:'agent'", staleSync.value?.ok === false && staleSync.value.reason === 'stale' && staleSync.value.playing === 'agent', staleSync.value);
  const restart = await mcp.pix3('pix3_play', { action: 'restart' });
  check('pix3_play restart as the agent', restart.value?.ok === true && restart.value.playing === true && restart.value.playOwner === 'agent', restart.value);
  const sync2 = await mcp.pix3('pix3_sync', { expect: { [activeRel]: sha256(SCENE) }, timeoutMs: 15000 });
  // The restart took the deferred version in; with nothing left to apply the sync is a barrier
  // even while the game plays (plan §G.2 row «Play агента → правка файла → sync … restart → sync ok»).
  // (The plugin's ok answer carries only the barrier fields; whether the game still plays is
  // `pix3_status.play` / `pix3_play status`.)
  const stillPlaying = (await mcp.pix3('pix3_play', { action: 'status' })).value;
  check('sync after restart is ok while the agent’s game keeps playing', sync2.value?.ok === true && stillPlaying?.playing === true && stillPlaying.playOwner === 'agent', { ok: sync2.value?.ok, reason: sync2.value?.reason, pending: sync2.value?.pending, play: stillPlaying });
  const node2 = await mcp.pix3('pix3_scene', { nodeId: 'subtitle-label' });
  check('the editor holds the value written during play', labelOf(node2) === 'E2E TWO', { label: labelOf(node2) });
  const run = await mcp.pix3('pix3_game_run', { until: [{ kind: 'frames', n: 30 }], maxFrames: 120 });
  check('pix3_game_run steps the running game', run.value?.ok === true && typeof run.value.verdict === 'string' && run.value.metrics?.frames >= 30, { verdict: run.value?.verdict, frames: run.value?.metrics?.frames, ms: run.ms });
  const stop = await mcp.pix3('pix3_play', { action: 'stop' });
  check('agent stops its own play', stop.value?.ok === true && stop.value.playing === false, stop.value);
  const notPlaying = await mcp.pix3('pix3_game_run', { until: [{ kind: 'frames', n: 1 }] });
  check('pix3_game_run without play is not_playing', notPlaying.value?.ok === false && notPlaying.value.reason === 'not_playing', notPlaying.value?.reason);

  // 6. Designer play: F6 through the page's own keyboard → stop force is refused, sync is stale (designer).
  await mcp.call('press_key', { key: 'F6' });
  let designer = null;
  for (let i = 0; i < 20 && !designer?.playing; i++) {
    designer = (await mcp.pix3('pix3_play', { action: 'status' })).value;
    if (!designer?.playing) await sleep(250);
  }
  check('F6 starts a designer-owned session', designer?.playing === true && designer.playOwner === 'designer', designer);
  const writerNow = (await mcp.pix3('pix3_status')).value;
  check('this tab still writes (one editor tab in Chrome)', writerNow?.writer === 'self', { writer: writerNow?.writer, pages: (await mcp.call('list_pages')).text.split('\n').filter(l => /__pix3/.test(l)) });
  const forced = await mcp.pix3('pix3_play', { action: 'stop', force: true });
  check("stop with force on the designer's session is not_owner", forced.value?.ok === false && forced.value.reason === 'not_owner' && forced.value.playing === true, forced.value);
  const restartForced = await mcp.pix3('pix3_play', { action: 'restart' });
  check("restart on the designer's session is not_owner", restartForced.value?.ok === false && restartForced.value.reason === 'not_owner', restartForced.value?.reason);
  writeFileSync(SCENE, edited);
  const designerSync = await mcp.pix3('pix3_sync', { timeoutMs: 15000 });
  check("sync during designer play is stale, playing:'designer'", designerSync.value?.ok === false && designerSync.value.reason === 'stale' && designerSync.value.playing === 'designer', designerSync.value);
  await mcp.call('press_key', { key: 'F8' });
  let stopped = null;
  for (let i = 0; i < 20; i++) {
    stopped = (await mcp.pix3('pix3_play', { action: 'status' })).value;
    if (stopped && !stopped.playing) break;
    await sleep(250);
  }
  check('F8 stops the designer session', stopped?.playing === false, stopped);
  const syncAfter = await mcp.pix3('pix3_sync', { expect: { [activeRel]: sha256(SCENE) }, timeoutMs: 15000 });
  check('sync after the designer stopped is ok', syncAfter.value?.ok === true, syncAfter.value);

  // 7. Refusals say why; bad params are rejected before the tool runs.
  const bad = await mcp.call('execute_3p_developer_tool', { toolName: 'pix3_play', params: JSON.stringify({ action: 'fly' }) });
  check('ajv rejects a bad enum before the tool runs', bad.isError && /Invalid parameters|enum/.test(bad.text), bad.text.slice(0, 160));
  const unknownNode = await mcp.pix3('pix3_scene', { nodeId: 'no-such-node' });
  check('an unknown node is not_found with a detail', unknownNode.value?.ok === false && unknownNode.value.reason === 'not_found' && typeof unknownNode.value.detail === 'string', unknownNode.value);
  const shot = await mcp.pix3('pix3_screenshot', { target: 'viewport' });
  check('pix3_screenshot prepares the viewport and points at take_screenshot', shot.value?.ok === true && shot.value.next === 'take_screenshot', shot.value);
  const png = await mcp.call('take_screenshot', {});
  check('take_screenshot returns an image', png.content.some(c => c.type === 'image'), png.content.map(c => c.type));

  // 8. Inline fallback: the same calls through evaluate_script on __PIX3_DEBUG__.
  const inlineStatus = await mcp.evaluate(`async () => await window.__PIX3_DEBUG__.call('pix3_status')`);
  check('inline call(pix3_status) answers like the 3p tool', inlineStatus.value?.ok === true && inlineStatus.value.activeScene === status3p.value.activeScene, { ms: inlineStatus.ms });
  const inlineSync = await mcp.evaluate(`async () => await window.__PIX3_DEBUG__.sync({ timeoutMs: 15000 })`);
  check('inline sync() answers ok', inlineSync.value?.ok === true, { ms: inlineSync.ms, rev: inlineSync.value?.rev });
  const inlineBad = await mcp.evaluate(`async () => await window.__PIX3_DEBUG__.call('pix3_play', { action: 'fly' })`);
  check('inline path validates params the same way', inlineBad.value?.ok === false && inlineBad.value.reason === 'invalid_params', inlineBad.value);
  const inlineTools = await mcp.evaluate(`() => window.__PIX3_DEBUG__.tools().map(t => t.name)`);
  check('inline tools() is the 3p table', JSON.stringify([...inlineTools.value].sort()) === JSON.stringify([...new Set(names)].sort()), inlineTools.value);
  const errors = await mcp.pix3('pix3_errors', {});
  check('no captured errors at the end', errors.value?.ok === true && errors.value.count === 0, errors.value?.errors?.slice(0, 3));
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  mcp?.close();
  writeFileSync(SCENE, originalScene);
  const stop = cli('editor', '--stop');
  console.log(stop.out.trim());
  const stopChrome = cli('editor', '--stop-chrome');
  console.log(stopChrome.out.trim());
  await sleep(300);
  const chromePids = existsSync(PID_FILE) ? readFileSync(PID_FILE, 'utf8').trim().split('\n').map(Number) : [];
  const alive = chromePids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  check('pix3 editor --stop-chrome ends Chrome and removes chrome.json', /Stopped Chrome/.test(stopChrome.out) && alive.length === 0 && !existsSync(join(HOME, 'chrome.json')), { alive });
  killChrome();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
