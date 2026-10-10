// Minimal raw-CDP client (from pix3-core-spikes/editor-e2e/cdp.mjs) plus auto-attach to child
// targets, which a sandboxed opaque-origin iframe is in Chrome 155 (site isolation). Speaks over
// Node's own WebSocket (Node ≥ 22), so it needs no package and no checkout path.
import { writeFileSync } from 'node:fs';

export class Browser {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessions = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data));
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
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP websocket failed to open')), { once: true });
    });
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
    this.console = [];
    this.errors = [];
    this.children = [];
    this.childWaiters = [];
    this.contexts = [];
  }

  onEvent(method, params) {
    const at = Date.now();
    if (method === 'Runtime.consoleAPICalled') this.console.push({ at, type: params.type, text: params.args.map(a => a.value ?? a.description ?? '').join(' ') });
    if (method === 'Runtime.exceptionThrown') this.errors.push({ at, text: params.exceptionDetails.exception?.description ?? params.exceptionDetails.text });
    if (method === 'Log.entryAdded' && params.entry.level === 'error') this.errors.push({ at, text: params.entry.text + ' ' + (params.entry.url ?? '') });
    if (method === 'Runtime.executionContextCreated') this.contexts.push(params.context);
    if (method === 'Runtime.executionContextsCleared') this.contexts = [];
    if (method === 'Target.attachedToTarget') {
      const child = new Page(this.browser, params.sessionId, params.targetInfo.targetId, `${this.name}>${params.targetInfo.type}`);
      child.info = params.targetInfo;
      this.browser.sessions.set(params.sessionId, child);
      this.children.push(child);
      void child.send('Runtime.enable').catch(() => {});
      void child.send('Log.enable').catch(() => {});
      for (const w of this.childWaiters.splice(0)) w(child);
    }
  }

  /** Attach to child targets (iframes in their own process); returns a waiter for the first one. */
  autoAttach() {
    void this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    return (timeoutMs = 10000) =>
      new Promise(resolve => {
        if (this.children.length) return resolve(this.children[0]);
        const timer = setTimeout(() => resolve(null), timeoutMs);
        this.childWaiters.push(child => {
          clearTimeout(timer);
          resolve(child);
        });
      });
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  /**
   * A same-process child frame (no OOPIF): its execution context in this session. Resolves an
   * object with the Page's evaluate/waitFor API bound to that context, or null.
   */
  async frameContext(timeoutMs = 10000) {
    const t0 = Date.now();
    for (;;) {
      const { frameTree } = await this.send('Page.getFrameTree');
      const main = frameTree.frame.id;
      const ctx = this.contexts.find(c => c.auxData?.frameId && c.auxData.frameId !== main && c.auxData.isDefault);
      if (ctx) {
        const page = this;
        return {
          name: `${this.name}>frame`,
          info: { contextId: ctx.id, origin: ctx.origin, frameId: ctx.auxData.frameId },
          errors: page.errors,
          console: page.console,
          async evaluate(expression) {
            const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, contextId: ctx.id });
            if (r.exceptionDetails) throw new Error('evaluate failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
            return r.result.value;
          },
          waitFor(expression, t = 20000, interval = 50) {
            return Page.prototype.waitFor.call(this, expression, t, interval);
          },
        };
      }
      if (Date.now() - t0 > timeoutMs) return null;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('evaluate failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  }

  async waitFor(expression, timeoutMs = 20000, intervalMs = 50) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try {
        v = await this.evaluate(expression);
      } catch {
        v = undefined;
      }
      if (v) return { value: v, waitedMs: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${expression} on ${this.name}`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  async screenshot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
  }
}
