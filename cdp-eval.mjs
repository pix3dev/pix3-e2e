// node cdp-eval.mjs <cdpPort> <urlSubstring> <expression>  — evaluate in the first matching page.
import WebSocket from '/data/igor.gritsenko/projects/pix3-stuff/pix3/node_modules/ws/wrapper.mjs';
const [port, match, expression] = process.argv.slice(2);
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(p => p.type === 'page' && p.url.includes(match));
if (!page) { console.error('no page matching', match, pages.map(p => p.url)); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id === 1) { console.log(JSON.stringify(m.result.exceptionDetails ?? m.result.result.value, null, 2)); process.exit(0); } });
