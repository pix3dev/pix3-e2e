// Minimal raw-CDP client over `ws` (no playwright): browser connection + per-target sessions.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import WebSocket from 'ws';

const CHROME_SH = new URL('../chrome.sh', import.meta.url).pathname;
const CORE_CLI = new URL('../../pix3-core/packages/cli/src/index.ts', import.meta.url).pathname;

/** A TCP port nothing listens on now (the OS picks it). */
export const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/**
 * Headless Chrome on a port of its own, and the browser connected to it. A fixed port let a run
 * connect to another process's Chrome (a leftover from a killed run, another agent's) — the
 * gate's "Chrome did not come up" and a run that hung on someone else's tabs.
 */
export async function launchChrome(profileDir, args = []) {
  if (process.env.PIX3_CDP_PROXY) return launchBehindProxy(profileDir, args);
  const port = await freePort();
  const chrome = spawn(CHROME_SH, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, ...args, 'about:blank'], { stdio: 'ignore' });
  // A run killed from outside (`timeout`, Ctrl+C) must not leave its Chrome behind.
  process.once('exit', () => chrome.kill());
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => process.exit(130));
  const browser = await Browser.connect(port);
  return { chrome, browser, port };
}

/**
 * `PIX3_CDP_PROXY=1` (or the path of a pix3 CLI `src/index.ts`): Chrome the way `pix3 editor`
 * runs it since P2 — the CLI's Chrome owner launches it over --remote-debugging-pipe and serves
 * the token proxy on a free port; this harness connects as one more client with the token
 * (plan §D.5). Killing the owner closes the pipe, and Chrome exits with it.
 */
async function launchBehindProxy(profileDir, args) {
  const port = await freePort();
  const home = `${profileDir}-pix3-home`;
  mkdirSync(home, { recursive: true });
  const cli = process.env.PIX3_CDP_PROXY === '1' ? CORE_CLI : process.env.PIX3_CDP_PROXY;
  // Extra Chrome flags ride in a wrapper; `exec` hands the pipe fds 3/4 to Chrome.
  const wrapper = `${home}/chrome-wrapper.sh`;
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexec ${CHROME_SH} ${args.map(a => `'${a}'`).join(' ')} "$@"\n`, { mode: 0o755 });
  const options = { chrome: wrapper, port, profile: profileDir, url: 'about:blank', headless: true };
  const chrome = spawn(process.execPath, [cli, '__chrome-owner', JSON.stringify(options)], {
    env: { ...process.env, PIX3_HOME: home },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  process.once('exit', () => chrome.kill());
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => process.exit(130));
  let token = null;
  for (let i = 0; i < 100 && !token; i++) {
    try {
      token = readFileSync(`${home}/cdp-token`, 'utf8').trim();
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
  const browser = await Browser.connect(port, token);
  return { chrome, browser, port, token };
}

export class Browser {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessions = new Map();
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        return;
      }
      if (msg.sessionId) this.sessions.get(msg.sessionId)?.onEvent(msg.method, msg.params);
    });
  }

  static async connect(port, token = null) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let info;
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        info = await response.json();
        break;
      } catch {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (!info) throw new Error('chrome did not come up');
    const ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, headers });
    await new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej)));
    return new Browser(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async newPage(name) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId, name);
    this.sessions.set(sessionId, page);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    return page;
  }

  close() {
    this.ws.close();
  }
}

export class Page {
  constructor(browser, sessionId, targetId, name) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.name = name;
    this.navigations = [];
    this.console = [];
    this.errors = [];
  }

  onEvent(method, params) {
    const at = Date.now();
    if (method === 'Page.frameNavigated' && !params.frame.parentId) this.navigations.push({ at, url: params.frame.url });
    if (method === 'Runtime.consoleAPICalled') this.console.push({ at, type: params.type, text: params.args.map(a => a.value ?? a.description ?? '').join(' ') });
    if (method === 'Runtime.exceptionThrown') this.errors.push({ at, text: params.exceptionDetails.exception?.description ?? params.exceptionDetails.text });
    if (method === 'Log.entryAdded' && params.entry.level === 'error') this.errors.push({ at, text: params.entry.text + ' ' + (params.entry.url ?? '') });
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
  }

  async reload() {
    await this.send('Page.reload');
  }

  /** Evaluate an expression (awaits promises) and return its JSON value. */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('evaluate failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  }

  /** Poll until `expression` is truthy; returns { value, waitedMs }. */
  async waitFor(expression, timeoutMs = 20000, intervalMs = 25) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try {
        v = await this.evaluate(expression);
      } catch {
        v = undefined; // page may be mid-navigation
      }
      if (v) return { value: v, waitedMs: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${expression} on ${this.name}`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
}
