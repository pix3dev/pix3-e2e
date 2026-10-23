// Remote SSH end to end (pix3-core plan §E.3, §D.5; pix3-core/.plans/done/agent-bridge.md A20–A23),
// both machines simulated on this box:
//
//   "remote" = HOME remote-e2e/home-remote, SSH_CONNECTION set, the project, Vite, the agent
//   "local"  = HOME remote-e2e/home-local, no project, headless Chrome behind the token proxy
//   two TCP forwarders stand in for SSH, neither 1:1:
//     VS Code's forward of the dev server   local  127.0.0.1:VL → remote localhost:VR
//     RemoteForward of the CDP proxy        remote 127.0.0.1:CR → local  127.0.0.1:CL
//
// Steps: remote `pix3 editor` (Vite, no Chrome, prints what to run locally) → local
// `pix3 editor --chrome-only --url http://localhost:VL/` (Chrome + proxy, prints the token copy
// line) → the line run with `ssh` replaced by `sh -c` under the remote HOME → remote
// `pix3 editor` sees the forward live → `pix3 agent-setup --remote` → chrome-devtools-mcp 1.10.1
// started exactly as the remote `.mcp.json` says reaches the tab through CR, finds it by
// dev.json's publicEditorUrl and runs pix3_status / pix3_sync; without the token (raw, and
// chrome-devtools-mcp with a wrong token) it is refused; the token is in no command line, no
// project file and no output. Everything started here is stopped at the end.
//
// Plus (A28): one configured forward port (--cdp-port stored remotely, --remote-port locally) and a
// relay squatter on another port — Host kept or rewritten — that never proves the token and never
// sees an Authorization header; agent-setup --remote writes nothing for it.
//
// Usage: node remote-e2e/run.mjs [--core <pix3-core checkout>]   (after remote-e2e/setup.sh)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { McpClient } from '../bridge-e2e/mcp.mjs';

const HERE = import.meta.dirname;
const coreFlag = process.argv.indexOf('--core');
const CORE = resolve(coreFlag >= 0 ? process.argv[coreFlag + 1] : join(HERE, '..', '..', 'pix3-core'));
const CLI = join(CORE, 'packages', 'cli', 'src', 'index.ts');
const { default: WebSocket } = await import(pathToFileURL(join(CORE, 'node_modules', 'ws', 'wrapper.mjs')).href);
const PROJ = join(HERE, 'proj');
const LOCAL_HOME = join(HERE, 'home-local');
const REMOTE_HOME = join(HERE, 'home-remote');
const LOCAL_CWD = join(LOCAL_HOME, 'somewhere'); // no project on the human's machine
const CHROME_SH = join(HERE, '..', 'chrome.sh');
const PID_FILE = join(LOCAL_HOME, 'chrome.pid');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''}`);
};
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

// Two environments: nothing of the real ~/.pix3, no SSH_CONNECTION on the local side, and the
// npm cache of this user so npx does not download chrome-devtools-mcp into a scratch HOME.
const base = { ...process.env, FORCE_COLOR: '0', npm_config_cache: join(homedir(), '.npm') };
for (const key of ['PIX3_HOME', 'PIX3_CHROME', 'PIX3_CHROME_PROFILE', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'PIX3_PUBLIC_URL']) delete base[key];
const localEnv = { ...base, HOME: LOCAL_HOME, PIX3_CHROME: join(LOCAL_HOME, 'chrome-wrapper.sh') };
const remoteEnv = { ...base, HOME: REMOTE_HOME, SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' };
const cli = (env, cwd, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const local = (...args) => cli(localEnv, LOCAL_CWD, ...args);
const remote = (...args) => cli(remoteEnv, PROJ, ...args);

/** The forwards ssh / VS Code would hold: a child process (`forward.mjs`), killed at the end. */
let forwarder = null;
const startForwards = specs =>
  new Promise((res, rej) => {
    forwarder = spawn(process.execPath, [join(HERE, 'forward.mjs'), ...specs], { stdio: ['ignore', 'pipe', 'inherit'] });
    forwarder.stdout.once('data', () => res());
    forwarder.once('exit', code => rej(new Error(`forward.mjs exited ${code}`)));
  });

/** Every process's command line that mentions `needle` (what any user of a host can read). */
const commandLinesWith = needle => {
  const hits = [];
  for (const pid of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (cmdline.includes(needle)) hits.push(`${pid}: ${cmdline.slice(0, 120)}`);
    } catch {
      // gone, or not ours to read
    }
  }
  return hits;
};

const rawCdp = (port, headers) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pix3`, { headers, perMessageDeflate: false });
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
    ws.once('open', () => {
      ws.close();
      resolve('open');
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

let mcp = null;
let badMcp = null;
try {
  if (!existsSync(join(PROJ, 'pix3project.yaml'))) throw new Error('run remote-e2e/setup.sh first');
  for (const dir of [LOCAL_HOME, REMOTE_HOME]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(LOCAL_CWD, { recursive: true });
  mkdirSync(REMOTE_HOME, { recursive: true });
  rmSync(join(PROJ, '.mcp.json'), { force: true });
  rmSync(join(PROJ, '.pix3', 'dev.json'), { force: true });
  writeFileSync(join(LOCAL_HOME, 'chrome-wrapper.sh'), `#!/usr/bin/env bash\necho $$ >> ${PID_FILE}\nexec ${CHROME_SH} "$@"\n`, { mode: 0o755 });
  process.once('exit', killChrome);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => process.exit(130));

  const [VR, VL, CL, CR] = [await freePort(), await freePort(), await freePort(), await freePort()];
  console.log(`ports: vite remote ${VR} → local ${VL}; cdp local ${CL} → remote ${CR}`);

  // 1. Remote: the dev server, no Chrome, what to run on the other machine.
  const r1 = remote('editor', '--port', String(VR), '--cdp-port', String(CR));
  check('remote pix3 editor exits 0 and launches no Chrome', r1.status === 0 && /SSH session/.test(r1.out) && !existsSync(join(REMOTE_HOME, '.pix3', 'chrome.json')) && !existsSync(PID_FILE), { out: r1.out, err: r1.err });
  check('remote pix3 editor prints the RemoteForward lines (its port) and the local command', r1.out.includes(`RemoteForward 127.0.0.1:${CR} 127.0.0.1:9333`) && r1.out.includes('ExitOnForwardFailure yes') && new RegExp(`editor --chrome-only --url http://localhost:\\d+/__pix3/ --remote-port ${CR}`).test(r1.out));
  check('remote pix3 editor: no token here yet', /no token here yet/.test(r1.out));
  const devInfo = JSON.parse(readFileSync(join(PROJ, '.pix3', 'dev.json'), 'utf8'));
  check('dev.json: the server on the remote port, no publicUrl yet', devInfo.port === VR && devInfo.publicUrl === undefined, devInfo.editorUrl);

  // 2. The forwards (VS Code: the dev server; ssh RemoteForward: the proxy). Not 1:1.
  await startForwards([`${VL}:localhost:${VR}`, `${CR}:127.0.0.1:${CL}`]);

  // 3. Local: Chrome + proxy for the forwarded editor, no project.
  const publicEditorUrl = `http://localhost:${VL}/__pix3/`;
  const l1 = local('editor', '--chrome-only', '--url', `http://localhost:${VL}/`, '--ssh', 'devbox', '--cdp-port', String(CL), '--remote-port', String(CR), '--headless');
  check('local pix3 editor --chrome-only --url (no project) exits 0', l1.status === 0 && l1.out.includes(`Editor:     ${publicEditorUrl}`), { out: l1.out, err: l1.err });
  const localToken = readFileSync(join(LOCAL_HOME, '.pix3', 'cdp-token'), 'utf8').trim();
  const copyLine = l1.out.split('\n').map(l => l.trim()).find(l => l.startsWith('ssh devbox '));
  check('local prints the token copy line and the RemoteForward line (remote CR → local CL), never the token', Boolean(copyLine) && l1.out.includes(`RemoteForward 127.0.0.1:${CR} 127.0.0.1:${CL}`) && !l1.out.includes(localToken), copyLine);
  check('local records CR as the proxy\'s forward port', JSON.parse(readFileSync(join(LOCAL_HOME, '.pix3', 'cdp-forward-ports.json'), 'utf8')).ports.includes(CR));
  check('local prints the editor tab it checked through the proxy', /Editor tab: http:\/\/localhost:\d+\/__pix3\//.test(l1.out), l1.out.split('\n').filter(l => l.startsWith('Editor tab')));

  // dev.json learns the address the browser used (the editor tab connects through VL).
  let info = null;
  for (let i = 0; i < 60; i++) {
    info = JSON.parse(readFileSync(join(PROJ, '.pix3', 'dev.json'), 'utf8'));
    if (info.publicEditorUrl) break;
    await sleep(500);
  }
  check('dev.json publicEditorUrl = the forwarded address the tab reached', info.publicEditorUrl === publicEditorUrl && info.editorUrl === `http://localhost:${VR}/__pix3/`, { publicEditorUrl: info.publicEditorUrl, editorUrl: info.editorUrl });

  // 4. The copy line, with `ssh devbox '<cmd>'` played by `sh -c '<cmd>'` under the remote HOME.
  const m = /^ssh devbox '(.+)' < (.+)$/.exec(copyLine ?? '');
  const copied = m && spawnSync('sh', ['-c', m[1]], { env: remoteEnv, stdio: [openSync(m[2], 'r'), 'pipe', 'pipe'] });
  const remoteTokenFile = join(REMOTE_HOME, '.pix3', 'remote-cdp-token');
  check('the copy line puts the token on the remote, 0600', copied?.status === 0 && readFileSync(remoteTokenFile, 'utf8').trim() === localToken && (statSync(remoteTokenFile).mode & 0o777) === 0o600, m?.[2]);

  // 5. Remote again: the forward proves the token (without receiving it); the browser address.
  const r2 = remote('editor'); // the port stored by step 1: one configured port, never a scan
  check('remote pix3 editor: the forward is live and proven', r2.status === 0 && r2.out.includes(`CDP forward: live on 127.0.0.1:${CR}`) && r2.out.includes(`Browser:    ${publicEditorUrl}`) && r2.out.includes(`--url ${publicEditorUrl} --remote-port ${CR}`), r2.out.split('\n').filter(l => /forward|Browser|--url/.test(l)));

  // 6. Remote agent-setup.
  const s1 = remote('agent-setup', 'claude', '--remote', '--cdp-port', String(CR));
  const configPath = join(REMOTE_HOME, '.pix3', 'remote-cdp.json');
  const projectFile = readFileSync(join(PROJ, '.mcp.json'), 'utf8');
  const launch = JSON.parse(projectFile).mcpServers['pix3-browser'];
  check('agent-setup --remote writes .mcp.json naming the --config file', s1.status === 0 && launch.args.includes(`--config=${configPath}`) && launch.args.some(a => a === 'chrome-devtools-mcp@1.10.1'), { out: s1.out, err: s1.err, args: launch.args });
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  check('remote-cdp.json (0600) holds the forwarded endpoint and the token', config.wsEndpoint === `ws://127.0.0.1:${CR}/pix3` && config.wsHeaders === JSON.stringify({ Authorization: `Bearer ${localToken}` }) && (statSync(configPath).mode & 0o777) === 0o600);
  check('the token is in neither the project file nor the output', !projectFile.includes(localToken) && !s1.out.includes(localToken) && !r2.out.includes(localToken));

  // 7. chrome-devtools-mcp exactly as configured, on the "remote" side, through the forward.
  mcp = new McpClient({ command: launch.command, args: [...launch.args, '--no-usage-statistics', '--no-performance-crux'] }, { env: remoteEnv });
  const tools = await mcp.start();
  check('chrome-devtools-mcp starts from the remote config', tools.includes('list_3p_developer_tools'), tools.length);
  let pageId = null;
  for (let i = 0; i < 60 && pageId === null; i++) {
    const pages = await mcp.call('list_pages');
    const line = pages.text.split('\n').find(l => l.includes(info.publicEditorUrl));
    const id = line && /(\d+):/.exec(line)?.[1];
    if (id) pageId = Number(id);
    else await sleep(500);
  }
  check('list_pages through the forward shows the tab at publicEditorUrl', pageId !== null, pageId);
  check('the token is on no command line', commandLinesWith(localToken).length === 0, commandLinesWith(localToken));
  mcp.page = pageId;
  await mcp.call('select_page', { pageId });
  let status = null;
  for (let i = 0; i < 120; i++) {
    const r = await mcp.evaluate(`async () => (window.__PIX3_DEBUG__ ? await window.__PIX3_DEBUG__.call('pix3_status') : null)`);
    if (r.value?.activeScene && r.value.scriptsStatus === 'ready') {
      status = r.value;
      break;
    }
    await sleep(500);
  }
  check('the editor mounted through the forwarded dev server', typeof status?.activeScene === 'string' && status.writer === 'self', status && { activeScene: status.activeScene, writer: status.writer });
  const listed = await mcp.call('list_3p_developer_tools');
  check('list_3p_developer_tools lists the pix3 group', /pix3_status/.test(listed.text) && /pix3_sync/.test(listed.text));
  const s3p = await mcp.pix3('pix3_status');
  check('pix3_status through execute_3p_developer_tool', s3p.value?.ok === true, { ms: s3p.ms });
  // An edit on the remote disk reaches the local tab: the sync barrier through both forwards.
  const scenePath = join(PROJ, status.activeScene.replace(/^res:\/\//, ''));
  const before = readFileSync(scenePath, 'utf8');
  writeFileSync(scenePath, `${before.trimEnd()}\n`);
  const sync = await mcp.pix3('pix3_sync', { timeoutMs: 15000 });
  check('pix3_sync ok through the forwards', sync.value?.ok === true, { ms: sync.ms, reason: sync.value?.reason });
  writeFileSync(scenePath, before);

  // 8. Refusals at the forwarded port: no token, a wrong one, a page.
  const refusals = [];
  for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: `Bearer ${localToken}`, Origin: 'http://evil.example' }]) {
    try {
      refusals.push(await rawCdp(CR, headers));
    } catch (error) {
      refusals.push(error.message);
    }
  }
  check('the forwarded port refuses a CDP WebSocket without the token, with a wrong one, from a page', JSON.stringify(refusals) === JSON.stringify(['HTTP 401', 'HTTP 401', 'HTTP 403']), refusals);
  const list401 = await fetch(`http://127.0.0.1:${CR}/json/list`);
  check('/json/list through the forward without the token is 401', list401.status === 401, list401.status);
  // chrome-devtools-mcp with another token: no pages, an error.
  const badConfig = join(REMOTE_HOME, '.pix3', 'bad-cdp.json');
  writeFileSync(badConfig, JSON.stringify({ wsEndpoint: `ws://127.0.0.1:${CR}/pix3`, wsHeaders: JSON.stringify({ Authorization: 'Bearer wrong-token-wrong-token-wrong-token' }) }), { mode: 0o600 });
  badMcp = new McpClient({ command: launch.command, args: [...launch.args.filter(a => !a.startsWith('--config=')), `--config=${badConfig}`, '--no-usage-statistics', '--no-performance-crux'] }, { env: remoteEnv });
  await badMcp.start();
  const badPages = await badMcp.call('list_pages');
  check('chrome-devtools-mcp with a wrong token is refused', badPages.isError || !badPages.text.includes('/__pix3/'), badPages.text.slice(0, 200));
  const unchanged = remote('agent-setup', 'claude', '--remote', '--cdp-port', String(CR));
  check('agent-setup --remote again: up to date', unchanged.status === 0 && /up to date/.test(unchanged.out));

  // 9. The relay squatter (A28): another user of the remote host holds S and relays every request
  // to the real forward CR (Host kept, or rewritten to CR). It must never get the token.
  const seen = [];
  for (const rewriteHost of [false, true]) {
    const S = await freePort();
    const squatter = createHttpServer((req, res) => {
      seen.push(req.headers);
      const headers = { ...req.headers, ...(rewriteHost ? { host: `127.0.0.1:${CR}` } : {}) };
      const up = httpRequest({ host: '127.0.0.1', port: CR, path: req.url, method: req.method, headers }, answer => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      up.on('error', () => res.destroy());
      req.pipe(up);
    });
    await new Promise(r => squatter.listen(S, '127.0.0.1', r));
    const home = join(REMOTE_HOME, `squatter-${rewriteHost}`);
    mkdirSync(join(home, '.pix3'), { recursive: true });
    writeFileSync(join(home, '.pix3', 'remote-cdp-token'), `${localToken}\n`, { mode: 0o600 });
    const env = { ...remoteEnv, HOME: home };
    const before = readFileSync(join(PROJ, '.mcp.json'), 'utf8');
    // Separate processes: the squatter lives in this event loop, so the CLI must not block it.
    const runAsync = (...args) => new Promise(res => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: PROJ, env });
      let out = '', err = '';
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', d => (err += d));
      child.on('exit', status => res({ status, out, err }));
    });
    const ed = await runAsync('editor', '--cdp-port', String(S));
    check(`relay squatter (Host ${rewriteHost ? 'rewritten' : 'kept'}): remote pix3 editor says port S is held`, ed.status === 0 && ed.out.includes(`port ${S} on this host is held by something that does not prove the token`), ed.out.split('\n').filter(l => /CDP forward|held/.test(l)));
    const as = await runAsync('agent-setup', 'claude', '--remote', '--cdp-port', String(S), '--repair');
    check(`relay squatter (Host ${rewriteHost ? 'rewritten' : 'kept'}): agent-setup --remote writes nothing, exit 1`, as.status === 1 && /nothing written/.test(as.err) && !existsSync(join(home, '.pix3', 'remote-cdp.json')) && readFileSync(join(PROJ, '.mcp.json'), 'utf8') === before, { status: as.status, err: as.err.split('\n')[0] });
    await new Promise(r => squatter.close(r));
  }
  check('the squatter saw requests but never an Authorization header', seen.length > 0 && seen.every(h => h.authorization === undefined), seen.length);
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  mcp?.close();
  badMcp?.close();
  const stop = remote('editor', '--stop');
  console.log(stop.out.trim());
  const stopChrome = local('editor', '--stop-chrome');
  console.log(stopChrome.out.trim());
  forwarder?.kill();
  await sleep(300);
  const chromePids = existsSync(PID_FILE) ? readFileSync(PID_FILE, 'utf8').trim().split('\n').map(Number) : [];
  const alive = chromePids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  check('Chrome stopped, chrome.json removed', alive.length === 0 && !existsSync(join(LOCAL_HOME, '.pix3', 'chrome.json')), { alive });
  killChrome();
  rmSync(join(PROJ, '.mcp.json'), { force: true });
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
