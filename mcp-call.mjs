// Minimal stdio MCP client: node mcp-call.mjs '<json array of {name, arguments}>' — spawns
// chrome-devtools-mcp@1.10.1 against $CDP (default http://127.0.0.1:9351) and runs the calls in order.
import { spawn } from 'node:child_process';
const calls = JSON.parse(process.argv[2]);
const cdp = process.env.CDP ?? 'http://127.0.0.1:9351';
const child = spawn('npx', ['-y', 'chrome-devtools-mcp@1.10.1', `--browserUrl=${cdp}`, '--categoryExperimentalThirdParty=true', '--no-usage-statistics', '--no-performance-crux'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; let id = 0; const waiters = new Map();
child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
const rpc = (method, params) => new Promise(r => { const mid = ++id; waiters.set(mid, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n'); });
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pix3-spike', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await rpc('tools/list', {});
console.log('tools/list:', list.result.tools.map(t => t.name).filter(n => /3p|evaluate|page|screenshot/.test(n)).join(', '));
for (const call of calls) {
  const t = Date.now();
  const res = await rpc('tools/call', call);
  const text = (res.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  console.log(`\n=== ${call.name} ${JSON.stringify(call.arguments ?? {})} (${Date.now() - t} ms) isError=${!!res.result?.isError}${res.error ? ' rpcError=' + JSON.stringify(res.error) : ''}\n${text.slice(0, 1500)}`);
}
child.kill(); process.exit(0);
