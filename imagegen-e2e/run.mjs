// Image-gen key proxy (plan §B.1 «Ключи генерации картинок»), end to end in headless Chrome.
//
//   a `pix3 new 2d` starter outside pix3-core, its own `npm run dev` (Vite + the plugin from the
//   checkout's dist), PIX3_HOME = a temp dir, the providers' origins pointed at a local mock
//   (PIX3_PROXY_GEMINI_URL / PIX3_PROXY_OPENAI_URL) — nothing reaches Google or OpenAI.
//
//   1. a Gemini key an earlier editor stored in the browser (IndexedDB `pix3-secrets`, the 1.x
//      SecretStorageService format) moves to $PIX3_HOME/keys.json (0600) once the Generate panel
//      asks, and the browser database is gone;
//   2. Generate from the panel → the mock gets POST /v1beta/models/<m>:generateContent with
//      `x-goog-api-key: <key>`; the panel shows the image;
//   3. an OpenAI key typed into the panel's quick settings lands in keys.json, the field empties,
//      the status says "Set (…last4)";
//   4. the page never sees a key: no response body / response header the editor page received,
//      no DOM (shadow roots included), no Web Storage, no IndexedDB holds it; the dev server's log
//      neither;
//   5. the game page (`/`, same origin) cannot use the proxy: plain fetch, a forged `referrer`,
//      the editor page fetched by script (no token in it), the editor framed (its host has no
//      token), the editor opened with window.open (no handle into it, COOP).
//
// Usage: node imagegen-e2e/run.mjs [--core <pix3-core checkout>]
//   (build the checkout's editor-core and vite-plugin dist first — see editor-e2e/README.md)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

import { launchChrome, freePort } from '../editor-e2e/cdp.mjs';

const HERE = import.meta.dirname;
const coreFlag = process.argv.indexOf('--core');
const CORE = resolve(coreFlag >= 0 ? process.argv[coreFlag + 1] : join(HERE, '..', '..', 'pix3-core'));
const WORK = join(HERE, 'work');
const PROJ = join(WORK, 'proj');
const HOME = join(WORK, 'home');
const PROFILE = join(WORK, 'profile');

const LEGACY_GEMINI_KEY = 'AIzaSy-LEGACY-browser-key-0123456789AB';
const OPENAI_KEY = 'sk-proj-E2E-openai-key-ZYXWVUTSRQPONMLK';
// 2×2 opaque PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8DwnwEJMOKSIF4BAIGqBf8pM1HfAAAAAElFTkSuQmCC';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- project ---------------------------------------------------------------------------------
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true }); // HOME is left to the plugin to create
const created = spawnSync(process.execPath, [join(CORE, 'packages/cli/src/index.ts'), 'new', '2d', PROJ], { encoding: 'utf8' });
if (created.status !== 0) throw new Error(created.stderr);
symlinkSync(join(CORE, 'node_modules'), join(PROJ, 'node_modules'));
const projectId = /projectId:\s*["']?([\w-]+)/.exec(readFileSync(join(PROJ, 'pix3project.yaml'), 'utf8'))[1];

// --- the providers' stand-in -------------------------------------------------------------------
const upstreamSeen = [];
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    upstreamSeen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      req.url.includes('generateContent')
        ? JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] })
        : JSON.stringify({ data: [{ b64_json: PNG_B64 }] })
    );
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;

// --- dev server ----------------------------------------------------------------------------------
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
let devLog = '';
const dev = spawn(process.execPath, [join(PROJ, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
  cwd: PROJ,
  env: { ...process.env, PIX3_HOME: HOME, PIX3_PROXY_GEMINI_URL: UPSTREAM, PIX3_PROXY_OPENAI_URL: UPSTREAM, FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
dev.stdout.on('data', d => (devLog += d));
dev.stderr.on('data', d => (devLog += d));
process.once('exit', () => dev.kill());
for (let i = 0; i < 200 && !devLog.includes('Pix3 editor'); i++) await sleep(100);

const { chrome, browser } = await launchChrome(PROFILE, ['--window-size=1600,1000']);
const stopAll = async () => {
  browser.close();
  chrome.kill();
  dev.kill();
  upstream.close();
};

try {
  // --- 1. a key the old editor stored in this browser --------------------------------------------
  const game = await browser.newPage('game');
  await game.navigate(`${BASE}/`);
  await game.waitFor(`document.readyState === 'complete'`);
  await game.evaluate(`(async () => {
    const db = await new Promise((ok, ko) => { const r = indexedDB.open('pix3-secrets', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('secrets', { keyPath: 'id' });
      r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(${JSON.stringify(LEGACY_GEMINI_KEY)}));
    await new Promise((ok, ko) => { const tx = db.transaction('secrets', 'readwrite'); const s = tx.objectStore('secrets');
      s.put({ id: '__pix3_master_key__', key }); s.put({ id: 'project:${projectId}:ai-provider:gemini:api-key', iv, data });
      tx.oncomplete = ok; tx.onerror = () => ko(tx.error); });
    db.close();
  })()`);
  check('seeded a 1.x browser-stored Gemini key', (await game.evaluate(`indexedDB.databases().then(l => l.map(d => d.name))`)).includes('pix3-secrets'));

  // --- the editor tab, every response it gets recorded -------------------------------------------
  const editor = await browser.newPage('editor');
  const requests = new Map();
  const editorOnEvent = editor.onEvent.bind(editor);
  editor.onEvent = (method, params) => {
    editorOnEvent(method, params);
    if (method === 'Network.requestWillBeSent') requests.set(params.requestId, { url: params.request.url, method: params.request.method, headers: params.request.headers, postData: params.request.postData ?? '' });
    if (method === 'Network.responseReceived') Object.assign(requests.get(params.requestId) ?? {}, { status: params.response.status, responseHeaders: params.response.headers });
    if (method === 'Network.loadingFinished') {
      const entry = requests.get(params.requestId);
      if (entry) entry.done = editor.send('Network.getResponseBody', { requestId: params.requestId }).then(b => (entry.body = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('latin1') : b.body)).catch(() => {});
    }
  };
  await editor.send('Network.enable', { maxPostDataSize: 1 << 20 });
  await editor.navigate(`${BASE}/__pix3/`);
  await editor.waitFor(`!!window.__PIX3_DEBUG__`, 60000);
  await sleep(1500);

  const DEEP = `const deep = (root, sel, acc = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, acc); } return acc; };`;
  const click = async (selector, text) =>
    editor.evaluate(`(() => { ${DEEP} const el = deep(document, ${JSON.stringify(selector)}).find(e => ${text ? `e.textContent.trim().includes(${JSON.stringify(text)})` : 'true'}); if (!el) return false; el.click(); return true; })()`);

  // Window → Asset Generator.
  check('Window menu opens', await click('.menu-section-button', 'Window'));
  await sleep(200);
  check('Window → Asset Generator', await click('.menu-item', 'Asset Generator'));
  await editor.waitFor(`(() => { ${DEEP} return deep(document, 'pix3-generate-panel .gp-prompt').length > 0; })()`, 20000);

  // --- 1 (result). the panel asked → migration ------------------------------------------------------
  const keysFile = join(HOME, 'keys.json');
  for (let i = 0; i < 50 && !existsSync(keysFile); i++) await sleep(100);
  const keysAfterMigration = existsSync(keysFile) ? JSON.parse(readFileSync(keysFile, 'utf8')) : null;
  check('the browser-stored Gemini key moved to $PIX3_HOME/keys.json', keysAfterMigration?.gemini === LEGACY_GEMINI_KEY, Object.keys(keysAfterMigration ?? {}));
  check('keys.json is 0600, its directory 0700', existsSync(keysFile) && (statSync(keysFile).mode & 0o777) === 0o600 && (statSync(HOME).mode & 0o777) === 0o700, existsSync(keysFile) ? (statSync(keysFile).mode & 0o777).toString(8) : null);
  await sleep(300);
  const dbs = await editor.evaluate(`indexedDB.databases().then(l => l.map(d => d.name))`);
  check('the browser database pix3-secrets is deleted', !dbs.includes('pix3-secrets'), dbs);
  const statusText = await editor.evaluate(`(() => { ${DEEP} const b = deep(document, '.gp-key-button')[0]; return b ? b.className : null; })()`);
  check('the panel shows the key as connected', /is-connected/.test(statusText ?? ''), statusText);

  // --- 2. Generate ------------------------------------------------------------------------------------
  await editor.evaluate(`(() => { ${DEEP} const t = deep(document, 'pix3-generate-panel .gp-prompt')[0]; t.value = 'a red cube'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  check('Generate is enabled', await editor.evaluate(`(() => { ${DEEP} const b = deep(document, '.gp-generate-button')[0]; return !!b && !b.disabled; })()`));
  const t0 = Date.now();
  await click('.gp-generate-button');
  await editor.waitFor(`(() => { ${DEEP} return deep(document, 'pix3-generate-panel .gp-result img, pix3-generate-panel .gp-error').length > 0; })()`, 20000);
  const generated = upstreamSeen.find(r => r.url.includes('generateContent'));
  check('the request reached the mock: POST /v1beta/models/<m>:generateContent', generated?.method === 'POST' && /^\/v1beta\/models\/[\w.-]+:generateContent$/.test(generated.url), generated?.url);
  check('… with x-goog-api-key = the key, no other credential', generated?.headers['x-goog-api-key'] === LEGACY_GEMINI_KEY && !generated.headers.authorization && !generated.headers.cookie && !generated.headers['x-pix3-session']);
  check('… with the prompt in the body', generated?.body.includes('a red cube'));
  const panelError = await editor.evaluate(`(() => { ${DEEP} const e = deep(document, 'pix3-generate-panel .gp-error')[0]; return e ? e.textContent.trim() : null; })()`);
  const resultImg = await editor.evaluate(`(() => { ${DEEP} const i = deep(document, 'pix3-generate-panel .gp-result img')[0]; return i ? { w: i.naturalWidth, h: i.naturalHeight } : null; })()`);
  check('the panel shows the generated image', resultImg?.w === 2 && !panelError, { resultImg, panelError, ms: Date.now() - t0 });

  // --- 3. an OpenAI key through the panel's quick settings ----------------------------------------
  await click('.gp-key-button');
  await sleep(200);
  await editor.evaluate(`(() => { ${DEEP} const s = deep(document, '.gp-key-popover select')[0]; s.value = 'openai'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  await editor.evaluate(`(() => { ${DEEP} const i = deep(document, '.gp-key-row input')[0]; i.value = ${JSON.stringify(OPENAI_KEY)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(100);
  await click('.gp-key-save');
  await sleep(800);
  const keysNow = JSON.parse(readFileSync(keysFile, 'utf8'));
  check('the typed OpenAI key is in keys.json (Gemini kept)', keysNow.openai === OPENAI_KEY && keysNow.gemini === LEGACY_GEMINI_KEY);
  const keyUi = await editor.evaluate(`(() => { ${DEEP} const i = deep(document, '.gp-key-row input')[0]; const s = deep(document, '.gp-key-status')[0]; return { value: i?.value, status: s?.textContent.trim() }; })()`);
  check('the field is emptied and the status shows only the last four', keyUi.value === '' && keyUi.status === `Set (…${OPENAI_KEY.slice(-4)})`, keyUi);

  // --- 4. the page never saw a key ----------------------------------------------------------------
  await Promise.all([...requests.values()].map(r => r.done));
  const secrets = [LEGACY_GEMINI_KEY, OPENAI_KEY];
  const leaks = [];
  for (const r of requests.values()) {
    const received = `${r.body ?? ''}\n${JSON.stringify(r.responseHeaders ?? {})}`;
    for (const s of secrets) if (received.includes(s)) leaks.push({ url: r.url, in: 'response' });
    // The page sends a key exactly once: the PUT that sets it.
    const sent = `${r.postData}\n${JSON.stringify(r.headers)}`;
    const isSetKey = r.method === 'PUT' && r.url.endsWith('/__pix3/api/keys');
    for (const s of secrets) if (sent.includes(s) && !(isSetKey && s === OPENAI_KEY)) leaks.push({ url: r.url, in: 'request' });
  }
  const apiCalls = [...requests.values()].filter(r => /\/__pix3\/api\/(keys|proxy)/.test(r.url));
  check('no response the editor page received carries a key', leaks.filter(l => l.in === 'response').length === 0, leaks);
  check('the page sent a key only in the PUT that set it (the migrated one: once)', leaks.filter(l => l.in === 'request').length === 1 && leaks[0]?.url.endsWith('/api/keys'), { leaks, apiCalls: apiCalls.map(r => `${r.method} ${new URL(r.url).pathname} ${r.status}`) });
  const pageText = await editor.evaluate(`(() => { ${DEEP} const parts = [document.documentElement.outerHTML]; for (const el of deep(document, '*')) if (el.shadowRoot) parts.push(el.shadowRoot.innerHTML); for (const i of deep(document, 'input')) parts.push(i.value); for (const st of [localStorage, sessionStorage]) for (let k = 0; k < st.length; k++) parts.push(st.key(k), st.getItem(st.key(k))); return parts.join('\\n'); })()`);
  check('no DOM, input or Web Storage of the editor holds a key', !secrets.some(s => pageText.includes(s)));
  check('the session meta is gone from the editor DOM', !pageText.includes('pix3-session'));
  check("the dev server's log names the calls but no key", devLog.includes('image-gen: gemini') && !secrets.some(s => devLog.includes(s)), devLog.split('\n').filter(l => l.includes('image-gen')));

  // --- 5. the game page cannot use the proxy ------------------------------------------------------
  const before = upstreamSeen.length;
  const gameTry = async (label, expr) => {
    const r = await game.evaluate(expr);
    return r;
  };
  const plain = await gameTry('plain', `fetch('/__pix3/api/keys', { headers: { 'X-Pix3': '1' } }).then(async r => [r.status, (await r.json()).error])`);
  check('game: GET keys → 403 (its Referer is the game)', plain[0] === 403, plain);
  const forged = await gameTry('forged', `fetch('/__pix3/api/proxy/gemini/v1beta/models/m:generateContent', { method: 'POST', referrer: '/__pix3/', headers: { 'X-Pix3': '1', 'Content-Type': 'application/json' }, body: '{}' }).then(async r => [r.status, (await r.json()).error])`);
  check('game: the proxy with a forged referrer → 403 bad_session', forged[0] === 403 && forged[1] === 'bad_session', forged);
  const fetchedPage = await gameTry('page', `fetch('/__pix3/').then(r => r.text()).then(t => t.includes('pix3-session'))`);
  check('game: the editor page fetched by script carries no token', fetchedPage === false);
  const framed = await gameTry('iframe', `new Promise(ok => { const f = document.createElement('iframe'); f.src = '/__pix3/'; f.style.cssText = 'width:800px;height:600px'; document.body.append(f);
    const t0 = Date.now(); const poll = () => { const h = f.contentWindow && f.contentWindow.__PIX3_HOST__;
      if (h) h.imageGen.keys().then(() => ok('allowed'), e => ok('refused: ' + (e.failure ? e.failure.status + ' ' + e.message : e.message)));
      else if (Date.now() - t0 > 20000) ok('no host'); else setTimeout(poll, 100); }; poll(); })`);
  check('game: the editor framed has no token (its host is refused)', /^refused: 403/.test(framed), framed);
  const popup = await game.send('Runtime.evaluate', {
    expression: `(() => { const w = window.open('/__pix3/', 'pix3-e2e-popup'); return new Promise(ok => setTimeout(() => { let host = 'unreachable'; try { host = w && w.__PIX3_HOST__ ? 'reachable' : (w && !w.closed ? 'no host yet' : 'unreachable'); } catch (e) { host = 'unreachable: ' + e.name; } ok({ opened: !!w, host }); }, 4000)); })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  const popupValue = popup.result.value;
  const control = await game.send('Runtime.evaluate', {
    expression: `(() => { const w = window.open('/', 'pix3-e2e-control'); return new Promise(ok => setTimeout(() => { try { ok(w.document.readyState); } catch (e) { ok('unreachable: ' + e.name); } }, 2000)); })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  check('game: window.open on the editor gives no handle into it (COOP; control: a game window is reachable)', popupValue && /^unreachable/.test(popupValue.host) && control.result.value === 'complete', { popupValue, control: control.result.value });
  check('game: nothing reached the mock', upstreamSeen.length === before, upstreamSeen.length - before);
  // COOP same-origin-allow-popups keeps the editor's own pop-outs (the game window) scriptable.
  const own = await editor.send('Runtime.evaluate', {
    expression: `(() => { const w = window.open('', 'pix3-e2e-own-popup', 'popup=yes,width=400,height=300'); try { w.document.body.textContent = 'ok'; const t = w.document.body.textContent; w.close(); return t; } catch (e) { return 'unreachable: ' + e.name; } })()`,
    returnByValue: true,
    userGesture: true,
  });
  check("editor: its own pop-out window stays scriptable under COOP", own.result.value === 'ok', own.result.value);
  const errors = editor.errors.filter(e => !/favicon/.test(e.text));
  check('no page errors in the editor tab', errors.length === 0, errors);
} catch (error) {
  check('run completed', false, String(error?.stack ?? error));
} finally {
  await stopAll();
}
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
writeFileSync(join(WORK, 'result.json'), JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
