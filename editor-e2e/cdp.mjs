// Minimal raw-CDP client over `ws` (no playwright): browser connection + per-target sessions.
import WebSocket from 'ws';

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

  static async connect(port) {
    let info;
    for (let i = 0; i < 100; i++) {
      try {
        info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (!info) throw new Error('chrome did not come up');
    const ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false });
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
