// Minimal stdio MCP client for chrome-devtools-mcp (the same as ../mcp-call.mjs, as a module):
// spawns the server from a {command, args} launch (what `pix3 agent-setup` wrote), speaks
// JSON-RPC over newline-delimited stdio, and exposes `call(name, args)` returning the text
// content. `pageId` is added automatically to tools whose schema has it (chrome-devtools-mcp's
// page routing) once `page` is set.
import { spawn } from 'node:child_process';

export class McpClient {
  constructor(launch, { env = process.env } = {}) {
    this.child = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.stderr = '';
    this.child.stderr.on('data', d => {
      this.stderr += d;
    });
    this.buf = '';
    this.id = 0;
    this.waiters = new Map();
    this.page = null;
    this.tools = new Map();
    this.child.stdout.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== undefined && this.waiters.has(m.id)) {
          this.waiters.get(m.id)(m);
          this.waiters.delete(m.id);
        }
      }
    });
  }

  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`MCP ${method} timed out\n${this.stderr.slice(-2000)}`));
      }, 120_000);
      this.waiters.set(id, m => {
        clearTimeout(timer);
        resolve(m);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async start() {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pix3-bridge-e2e', version: '0' },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await this.rpc('tools/list', {});
    for (const tool of list.result.tools) this.tools.set(tool.name, tool);
    return [...this.tools.keys()];
  }

  /** Call a tool; returns {text, isError, ms}. `pageId` is filled in when the tool takes it. */
  async call(name, args = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`no MCP tool ${name}`);
    const takesPage = Boolean(tool.inputSchema?.properties?.pageId);
    const withPage = takesPage && this.page !== null && args.pageId === undefined ? { ...args, pageId: this.page } : args;
    const t = Date.now();
    const res = await this.rpc('tools/call', { name, arguments: withPage });
    if (res.error) throw new Error(`${name}: ${JSON.stringify(res.error)}`);
    const text = (res.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    return { text, isError: Boolean(res.result?.isError), ms: Date.now() - t, content: res.result?.content ?? [] };
  }

  /** execute_3p_developer_tool with params as the JSON string the model would send; parsed answer. */
  async pix3(toolName, params = {}) {
    const res = await this.call('execute_3p_developer_tool', { toolName, params: JSON.stringify(params) });
    return { ...res, value: parseAnswer(res.text) };
  }

  /** evaluate_script of `fn` (a function source) with waitForStableDom:false; parsed answer. */
  async evaluate(fn) {
    const res = await this.call('evaluate_script', { function: fn, waitForStableDom: false });
    return { ...res, value: parseAnswer(res.text) };
  }

  close() {
    this.child.kill();
  }
}

/** chrome-devtools-mcp wraps tool output in prose; the JSON is the first fenced block or the last {...}. */
export function parseAnswer(text) {
  const fenced = /```(?:json)?\n([\s\S]*?)\n```/.exec(text);
  const candidates = fenced ? [fenced[1]] : [];
  const start = text.indexOf('{');
  if (start >= 0) candidates.push(text.slice(start, text.lastIndexOf('}') + 1));
  const arr = text.indexOf('[');
  if (arr >= 0) candidates.push(text.slice(arr, text.lastIndexOf(']') + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // next
    }
  }
  return text;
}
