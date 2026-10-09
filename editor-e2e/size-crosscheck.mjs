// Cross-check of .plans/write-model.md W1/W2: the size an un-sized Sprite2D gets in the EDITOR
// (the browser decodes the image) must equal what Node reads from the image header
// (`readImageHeaderSize`, used by NodeAssetLoader for `pix3 validate` / the plugin) — else the same
// scene normalises differently on the two sides. Images are made by Chrome itself.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { pix3 } from '/data/igor.gritsenko/projects/pix3-stuff/pix3-core/packages/vite-plugin/dist/index.js';
import { readImageHeaderSize } from '/data/igor.gritsenko/projects/pix3-stuff/pix3-core/packages/runtime/src/core/image-header-size.ts';
import { Browser } from './cdp.mjs';

const HERE = import.meta.dirname;
const PROJ = join(HERE, 'proj');
const PORT = 5297;
const results = [];
const check = (name, pass, detail) => { results.push(!!pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${JSON.stringify(detail)}`); };

mkdirSync(join(HERE, 'profile-size'), { recursive: true });
const chrome = spawn('/data/igor.gritsenko/projects/pix3-stuff/pix3-core-spikes/chrome.sh', ['--remote-debugging-port=9367', `--user-data-dir=${join(HERE, 'profile-size')}`, 'about:blank'], { stdio: 'ignore' });
const browser = await Browser.connect(9367);
let server;
try {
  // 1. Raster images from Chrome's own encoders.
  const maker = await browser.newPage('maker');
  const raster = await maker.evaluate(`(async () => {
    const out = {};
    for (const [name, type, w, h] of [['png', 'image/png', 37, 21], ['jpg', 'image/jpeg', 53, 29], ['webp', 'image/webp', 61, 17]]) {
      const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, w, h);
      const b = await c.convertToBlob({ type, quality: 0.9 });
      out[name] = { type: b.type, b64: btoa(String.fromCharCode(...new Uint8Array(await b.arrayBuffer()))) };
    }
    return out;
  })()`);
  const files = {};
  for (const [ext, { b64 }] of Object.entries(raster)) files[`xcheck.${ext}`] = Buffer.from(b64, 'base64');
  files['xcheck-attrs.svg'] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="44" height="22"><rect width="44" height="22" fill="#3c3"/></svg>');
  files['xcheck-px.svg'] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="30px" height="12px"><rect width="30" height="12"/></svg>');
  files['xcheck-viewbox.svg'] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40"/></svg>');
  files['xcheck-width-only.svg'] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="50"><rect width="50" height="10"/></svg>');
  files['xcheck-percent.svg'] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="10" height="10"/></svg>');
  files['xcheck-bare.svg'] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  files['xcheck-height-viewbox.svg'] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 0 100 40"><rect width="100" height="40"/></svg>');
  files['xcheck-width-viewbox.svg'] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="50" viewBox="0 0 100 40"><rect width="100" height="40"/></svg>');
  mkdirSync(join(PROJ, 'sprites'), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(PROJ, 'sprites', name), bytes);

  // 2. A scene of un-sized sprites, opened in the editor as the entry scene.
  const names = Object.keys(files);
  const scene = ['version: 1.0.0', 'root:', ...names.flatMap((name, i) => [
    `  - id: s${i}`, '    type: Sprite2D', `    name: ${name}`, '    properties:',
    `      texture: { type: texture, url: res://sprites/${name} }`,
  ])].join('\n') + '\n';
  const scenePath = join(PROJ, 'scenes/main.pix3scene');
  const original = readFileSync(scenePath, 'utf8');
  writeFileSync(scenePath, scene);
  server = await createServer({ configFile: false, root: PROJ, logLevel: 'warn', cacheDir: join(HERE, '.vite-cache-size'), plugins: [pix3()], server: { port: PORT, strictPort: true, host: '127.0.0.1' } });
  await server.listen();
  const page = await browser.newPage('editor');
  await page.navigate(`http://127.0.0.1:${PORT}/__pix3/`);
  await page.waitFor(`!!window.__PIX3_DEBUG__ && !!window.__PIX3_DEBUG__.status().activeScene && !!window.__PIX3_DEBUG__.node('s0')`, 60000);
  await new Promise(r => setTimeout(r, 1500));

  // 3. Editor (decoded) vs Node (header).
  for (const [i, name] of names.entries()) {
    const node = await page.evaluate(`window.__PIX3_DEBUG__.node('s${i}')?.saved?.properties ?? null`);
    const header = readImageHeaderSize(new Uint8Array(files[name]));
    const editor = node ? { width: node.width, height: node.height } : null;
    const same = header && editor && header.width === editor.width && header.height === editor.height;
    check(`${name}: editor size == header size`, same, { editor, header });
  }
  check('the scene file was not written by opening it', readFileSync(scenePath, 'utf8') === scene);
  check('nothing pending after opening (baseline = graph)', JSON.stringify(await page.evaluate('window.__PIX3_DEBUG__.pending()')) === '{}', await page.evaluate('window.__PIX3_DEBUG__.pending()'));
  console.log('ERRORS', JSON.stringify(await page.evaluate('window.__PIX3_DEBUG__.errors().slice(0,4)')).slice(0, 1500), JSON.stringify(page.console.filter(c => /svg|texture|Texture/i.test(c.text)).slice(0, 5).map(c => c.type + ' ' + c.text.slice(0, 300))));
  writeFileSync(scenePath, original);
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  browser.close();
  chrome.kill();
  await server?.close();
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
