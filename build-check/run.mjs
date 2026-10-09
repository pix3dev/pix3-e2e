// P1 artifact check (plan §B.6 «Проверка артефакта»): build a real template project with the
// plugin from a pix3-core checkout's dist/, then open the single-file html in headless Chrome
// three ways — `vite preview`, `file://`, and inside `<iframe sandbox="allow-scripts">` (opaque
// origin, like an ad container) — and judge by `window.__PIX3_PLAYER__`: status 'running',
// frames > 0 and still counting, no errors, no page exceptions.
//
//   node build-check/run.mjs [--core <pix3-core checkout>] [--template recipe-blank-2d] [--keep]
//
// The project is generated into build-check/proj/ from the template's files (never inside
// pix3-core); `node_modules` links to the checkout's. Chrome comes from pix3-core-spikes/chrome.sh.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Browser } from './cdp.mjs';

const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const CORE = resolve(option('--core', join(HERE, '../../pix3-core')));
const CHROME = option('--chrome', join(HERE, '../chrome.sh'));
const TEMPLATE = option('--template', 'recipe-blank-2d');
const KEEP = args.includes('--keep');
const PROJ = join(HERE, 'proj');
const PORT = Number(option('--port', '5301'));
const CDP_PORT = Number(option('--cdp', '9366'));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
};

// --- 1. a real template project, outside pix3-core ---------------------------------------------
const templateDir = join(CORE, 'packages/create-pix3/templates', TEMPLATE);
const templateMeta = readFileSync(join(templateDir, 'template.yaml'), 'utf8');
const viewport = /viewport:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/.exec(templateMeta);
const entry = /entryScene:\s*(\S+)/.exec(templateMeta)?.[1];
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(PROJ, { recursive: true });
cpSync(join(templateDir, 'files'), PROJ, { recursive: true });
writeFileSync(
  join(PROJ, 'pix3project.yaml'),
  [
    'version: 1.0.0',
    ...(entry ? [`defaultExportScenePath: ${entry}`] : []),
    `viewportBaseSize: { width: ${viewport?.[1] ?? 1920}, height: ${viewport?.[2] ?? 1080} }`,
    'projectType: 2d',
    'targetPlatform: universal',
    `metadata: { projectName: ${JSON.stringify(TEMPLATE)} }`,
    'autoloads: []',
    '',
  ].join('\n')
);
writeFileSync(
  join(PROJ, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>Pix3</title><style>html,body,#app{margin:0;height:100%;background:#000}</style></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>\n'
);
mkdirSync(join(PROJ, 'src'), { recursive: true });
writeFileSync(join(PROJ, 'src/main.ts'), "import { startGame } from '@pix3/vite-plugin/player';\n\nvoid startGame('#app');\n");
writeFileSync(
  join(PROJ, 'vite.config.mjs'),
  `import { pix3 } from ${JSON.stringify(join(CORE, 'packages/vite-plugin/dist/index.js'))};\nexport default { plugins: [pix3()] };\n`
);
symlinkSync(join(CORE, 'node_modules'), join(PROJ, 'node_modules'), 'dir');

// --- 2. vite build through the project's own config, as `npm run build` would -------------------
const vite = await import(pathToFileURL(join(CORE, 'node_modules/vite/dist/node/index.js')).href);
const t0 = Date.now();
await vite.build({ root: PROJ, configFile: join(PROJ, 'vite.config.mjs'), logLevel: 'warn' });
const record = JSON.parse(readFileSync(join(PROJ, '.pix3/build.json'), 'utf8'));
check('vite build wrote dist/index.html and .pix3/build.json', existsSync(record.path), {
  ms: Date.now() - t0,
  kib: Math.round(record.bytes / 1024),
  entry: record.entryScene,
  assets: record.assets,
  stripped: record.stripped.length,
  warnings: record.warnings,
});
const html = readFileSync(record.path, 'utf8');
check('classic script, no ESM residue', !/type="module"|crossorigin|import\.meta/.test(html));
check('only index.html in dist/', existsSync(join(PROJ, 'dist/index.html')) && !existsSync(join(PROJ, 'dist/assets')));

// The sandbox wrapper: an opaque-origin frame around the artifact (no allow-same-origin).
writeFileSync(
  join(PROJ, 'dist/sandbox.html'),
  '<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" src="index.html" style="width:100vw;height:100vh;border:0"></iframe></body></html>\n'
);

// --- 3. headless Chrome: preview, file://, sandboxed iframe -------------------------------------
const preview = await vite.preview({ root: PROJ, configFile: false, build: { outDir: 'dist' }, preview: { port: PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'warn' });
mkdirSync(join(HERE, 'profile'), { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(HERE, 'profile')}`, '--window-size=600,1000', 'about:blank'], { stdio: 'ignore' });
let browser;

const PLAYER = `(() => { const p = window.__PIX3_PLAYER__; return p ? { status: p.status, frames: p.frames, errors: p.errors, scene: p.scene } : null; })()`;

const judge = async (name, page) => {
  try {
    await page.waitFor(`(${PLAYER})?.frames > 0`, 30000, 100);
  } catch {
    // reported below
  }
  const first = await page.evaluate(PLAYER);
  await new Promise(r => setTimeout(r, 1000));
  const second = await page.evaluate(PLAYER);
  const alive = !!first && !!second && second.frames > first.frames;
  check(`${name}: status running, frames > 0 and counting`, first?.status === 'running' && alive, { first, second });
  check(`${name}: no player errors, no page exceptions`, second?.errors?.length === 0 && page.errors.length === 0, { errors: second?.errors, page: page.errors.slice(0, 5), console: page.console.filter(c => c.type === 'error').slice(0, 5) });
};

try {
  browser = await Browser.connect(CDP_PORT);

  const previewPage = await browser.newPage('preview');
  await previewPage.navigate(`http://127.0.0.1:${PORT}/`);
  await judge('vite preview', previewPage);
  await previewPage.screenshot(join(HERE, 'preview.png'));

  const filePage = await browser.newPage('file');
  await filePage.navigate(pathToFileURL(record.path).href);
  await judge('file://', filePage);
  await filePage.screenshot(join(HERE, 'file.png'));

  // The sandboxed frame is its own target: auto-attach and evaluate in the child session.
  const sandboxPage = await browser.newPage('sandbox');
  const child = sandboxPage.autoAttach();
  await sandboxPage.navigate(pathToFileURL(join(PROJ, 'dist/sandbox.html')).href);
  // Chrome 155 keeps a sandboxed file:// frame in-process; a child target appears only under
  // site isolation. Take whichever shows up.
  const frame = (await child(5000)) ?? (await sandboxPage.frameContext(15000));
  check('sandboxed iframe found (child target or in-process context)', frame !== null, frame?.info);
  if (frame) {
    // Opaque origin, measured from inside: without allow-same-origin the parent is unreachable.
    const isolation = await frame.evaluate(`(() => { try { void window.parent.document; return 'same-origin'; } catch (e) { return 'opaque:' + e.name; } })()`);
    check('iframe is an opaque origin (parent.document throws)', isolation.startsWith('opaque'), { isolation, origin: await frame.evaluate('location.origin') });
    await judge('<iframe sandbox="allow-scripts">', frame);
    await sandboxPage.screenshot(join(HERE, 'sandbox.png'));
  }
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  browser?.close();
  chrome.kill();
  await new Promise(resolve => preview.httpServer.close(resolve));
  if (!KEEP) rmSync(join(HERE, 'profile'), { recursive: true, force: true });
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
