// M2 check of the editor port: the prebuilt editor mounts on /__pix3/ of a real project — the
// entry scene open, this tab the writer, a viewport canvas, no /@vite/client and no editor request
// into the project outside the known paths, no errors. Judged by state, no screenshot (AGENTS.md
// rule 10). Shared harness: `--core <checkout>` (or `$PIX3_CORE`), a fresh `proj-m2/` from the
// corpus, Vite and Chrome on free ports, non-zero exit on a failed check.
import { join } from 'node:path';

import { bridge, HERE, makeChecks, makeProject, resolveCore, startChrome, startServer } from './harness.mjs';

const CORE = resolveCore();
const PROJ = makeProject(CORE, 'recipe-tapper-2d', join(HERE, 'proj-m2'));
const { check, finish } = makeChecks();

const { server, base } = await startServer(CORE, PROJ, join(HERE, '.vite-cache-m2'));
const { chrome, browser } = await startChrome(join(HERE, 'profile-m2'), ['--window-size=1600,1000']);
try {
  const page = await browser.newPage('editor');
  // Every request the page makes, from before the navigation on.
  await page.send('Network.enable');
  const requests = [];
  const onEvent = page.onEvent.bind(page);
  page.onEvent = (method, params) => {
    if (method === 'Network.requestWillBeSent') requests.push(params.request.url);
    onEvent(method, params);
  };
  const t0 = Date.now();
  await page.navigate(`${base}/__pix3/`);
  await page.waitFor(`!!window.__PIX3_DEBUG__`, 60000);
  check('editor mounted, bridge installed', true, { ms: Date.now() - t0 });
  await page.waitFor(`(async () => !!(await window.__PIX3_DEBUG__.status()).activeScene)()`, 30000).catch(() => {});
  const a = bridge(page);
  const status = await a.status();
  check('entry scene is open', status.activeScene === 'res://scenes/main.pix3scene', status.activeScene);
  check('this tab is the writer', status.writer === 'self', status.writer);
  const scene = await a.call('pix3_scene', { maxDepth: 2 });
  const roots = scene?.scene?.children ?? scene?.scene ?? [];
  const names = (Array.isArray(roots) ? roots : [roots]).flatMap(n => [n?.name, ...(n?.children ?? []).map(c => c?.name)]).filter(Boolean);
  check('scene graph has nodes', scene?.ok === true && names.length > 1, names.slice(0, 8));
  const layout = await page.evaluate(`(() => { const all = []; const walk = r => { for (const el of r.querySelectorAll('*')) { if (el.tagName === 'CANVAS') all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); const canvas = all.sort((x, y) => y.clientWidth * y.clientHeight - x.clientWidth * x.clientHeight)[0]; return { shell: !!document.querySelector('pix3-editor'), canvasCount: all.length, canvas: canvas ? [canvas.clientWidth, canvas.clientHeight] : null }; })()`);
  check('layout with a viewport canvas', layout.shell && layout.canvas && layout.canvas[0] > 100, layout);
  const viteClient = requests.filter(url => url.includes('/@vite/client'));
  // Non-vacuous: the page's own module requests were seen.
  check('no /@vite/client', requests.length > 20 && viteClient.length === 0, { requests: requests.length, viteClient });
  const host = new URL(base).host;
  const outside = requests.filter(url => {
    const u = new URL(url);
    return u.protocol.startsWith('http') && u.host === host && !/^\/(__pix3\/|@id\/|@fs\/|node_modules\/|scenes\/|sprites\/|scripts\/|design\/|@vite\/env)/.test(u.pathname);
  });
  check('no editor request into the project root outside known paths', outside.length === 0, outside.slice(0, 10));
  const errors = await a.errors();
  check('no captured errors', errors.length === 0 && page.errors.length === 0, { captured: errors.slice(0, 5), page: page.errors.slice(0, 5) });
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  browser.close();
  chrome.kill();
  await server.close();
  finish();
}
