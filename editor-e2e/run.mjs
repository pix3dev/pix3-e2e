// M2 check of the editor port: the prebuilt editor mounts on /__pix3/ of a real project.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as fs from 'node:fs';
globalThis.__fs = fs;
import { createServer } from 'vite';
import { pix3 } from '/data/igor.gritsenko/projects/pix3-stuff/pix3-core/packages/vite-plugin/dist/index.js';
import { Browser } from './cdp.mjs';

const HERE = import.meta.dirname;
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); };
const server = await createServer({ configFile: false, root: join(HERE, 'proj'), logLevel: 'warn', cacheDir: join(HERE, '.vite-cache'), plugins: [pix3()], server: { port: 5293, strictPort: true, host: '127.0.0.1' } });
await server.listen();
mkdirSync(join(HERE, 'profile'), { recursive: true });
const chrome = spawn('/data/igor.gritsenko/projects/pix3-stuff/pix3-core-spikes/chrome.sh', ['--remote-debugging-port=9363', `--user-data-dir=${join(HERE, 'profile')}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
let browser;
try {
  browser = await Browser.connect(9363);
  const page = await browser.newPage('editor');
  await page.send('Network.enable');
  const requests = [];
  const origOnEvent = page.onEvent.bind(page);
  page.onEvent = (method, params) => { if (method === 'Network.requestWillBeSent') requests.push(params.request.url); origOnEvent(method, params); };
  const t0 = Date.now();
  await page.navigate('http://127.0.0.1:5293/__pix3/');
  await page.waitFor(`!!window.__PIX3_DEBUG__`, 60000);
  check('editor mounted, bridge installed', true, { ms: Date.now() - t0 });
  await page.waitFor(`window.__PIX3_DEBUG__.status().activeScene`, 30000).catch(() => {});
  const status = await page.evaluate(`window.__PIX3_DEBUG__.status()`);
  check('entry scene is open', status.activeScene === 'res://scenes/main.pix3scene', status);
  check('this tab is the writer', status.writer === 'self', status.writer);
  const scene = await page.evaluate(`window.__PIX3_DEBUG__.scene(2)`);
  check('scene graph has nodes', (scene?.children?.length ?? 0) > 0, scene?.children?.map(c => c.name));
  const layout = await page.evaluate(`(() => { const shell = document.querySelector('pix3-editor'); const all = []; const walk = r => { for (const el of r.querySelectorAll('*')) { if (el.tagName === 'CANVAS') all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); const canvas = all.sort((a,b) => b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0]; return { shell: !!shell, canvasCount: all.length, canvas: canvas ? [canvas.clientWidth, canvas.clientHeight] : null, viewportHosts: [...document.querySelectorAll('pix3-editor-tab, pix3-viewport, [class*=viewport]')].slice(0,5).map(e => e.tagName + '.' + e.className), tabs: [...document.querySelectorAll('.lm_tab .lm_title')].map(t => t.textContent) }; })()`);
  check('layout with a viewport canvas', layout.shell && layout.canvas && layout.canvas[0] > 100, layout);
  const viteClient = requests.filter(url => url.includes('/@vite/client'));
  check('no /@vite/client', viteClient.length === 0, viteClient);
  const outside = requests.filter(url => { const u = new URL(url); return u.host === '127.0.0.1:5293' && !/^\/(__pix3\/|@id\/|@fs\/|node_modules\/|scenes\/|sprites\/|scripts\/|design\/|@vite\/env)/.test(u.pathname) && u.protocol.startsWith('http'); });
  check('no editor request into the project root outside known paths', outside.length === 0, outside.slice(0, 10));
  const errors = await page.evaluate(`window.__PIX3_DEBUG__.errors()`);
  check('no captured errors', errors.length === 0 && page.errors.length === 0, { captured: errors.slice(0, 5), page: page.errors.slice(0, 5) });
  await page.send('Page.captureScreenshot', { format: 'png' }).then(r => require_fs().writeFileSync(join(HERE, 'm2.png'), Buffer.from(r.data, 'base64')));
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  browser?.close(); chrome.kill(); await server.close();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
function require_fs() { return globalThis.__fs; }
