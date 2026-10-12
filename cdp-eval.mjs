// node cdp-eval.mjs <cdpPort> <urlSubstring> <expression>  — evaluate in the first matching page.
const [port, match, expression] = process.argv.slice(2);
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(p => p.type === 'page' && p.url.includes(match));
if (!page) { console.error('no page matching', match, pages.map(p => p.url)); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
ws.addEventListener('message', ({ data }) => { const m = JSON.parse(data); if (m.id === 1) { console.log(JSON.stringify(m.result.exceptionDetails ?? m.result.result.value, null, 2)); process.exit(0); } });
