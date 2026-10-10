// Artifact check of the plugin's playable build (plan §B.6 «Проверка артефакта», P2 gate rows
// «npm run build» and N11): create a starter with the checkout's `npm create pix3`
// (create-pix3 → `pix3 new <2d|3d>`), add what the gate asks for — a second scene reached by
// `changeScene`, a nested prefab instanced in both, a local library that imports the runtime
// by name — build it with its own vite.config.ts (`pix3()` from the checkout's
// @pix3/vite-plugin dist/), then open the single-file html in headless Chrome three ways —
// `vite preview`, `file://`, and inside `<iframe sandbox="allow-scripts">` (opaque origin, like
// an ad container) — and judge by `window.__PIX3_PLAYER__` (status 'running', frames > 0 and
// still counting, no errors, no page exceptions) and `window.__PIX3_CHECK__` (the second scene
// started, the prefab's label found in it, the library's GeometryMesh constructed, the project's
// autoload counter ticking before and after the scene change as one instance).
//
//   node build-check/run.mjs [--core <pix3-core checkout>] [--template 2d|3d] [--compress]
//                            [--vite 7|8] [--lib named|namespace] [--keep]
//
// `--vite 7` builds with the Vite installed in build-check/vite7/ (rollup) — the plugin is
// copied beside it so it resolves that Vite too; the default is the checkout's Vite 8
// (rolldown). `--lib namespace` makes the library `import * as`: the build must turn strip off
// and say so. Ports are free ones, never fixed; Chrome is killed on every exit.
//
// The project is generated into build-check/proj/ (never inside pix3-core); its `node_modules`
// is a directory of links to the checkout's entries (workspace links: @pix3/* resolve to its
// packages) plus the local library. Chrome comes from pix3-core-spikes/chrome.sh.
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
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
const TEMPLATE = option('--template', '2d');
const COMPRESS = args.includes('--compress');
const VITE = option('--vite', '8');
const LIB = option('--lib', 'named');
const KEEP = args.includes('--keep');
const PROJ = join(HERE, 'proj');
const PROFILE = join(HERE, `profile-${process.pid}`);
const VITE7 = join(HERE, 'vite7');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
};
const freePort = () =>
  new Promise((res, rej) => {
    const server = createServer();
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => res(port));
    });
  });

let chrome = null;
const killChrome = () => {
  if (chrome && chrome.exitCode === null) chrome.kill('SIGKILL');
};
process.on('exit', killChrome);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    killChrome();
    process.exit(130);
  });
}

// --- 1. a starter, outside pix3-core, made the way `npm create pix3` makes it ------------------
rmSync(PROJ, { recursive: true, force: true });
const created = spawnSync(
  process.execPath,
  [join(CORE, 'packages/create-pix3/index.js'), PROJ, '--template', TEMPLATE, '--name', `build-check ${TEMPLATE}`, '--yes'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
);
check(`npm create pix3 --template ${TEMPLATE}`, created.status === 0 && existsSync(join(PROJ, 'vite.config.ts')), created.status === 0 ? undefined : created.stderr);

// --- 1a. the gate's additions: second scene, nested prefab, scripts, the N11 library -----------
const write = (rel, text) => {
  const abs = join(PROJ, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
};
const PREFAB = `version: 1.0.0
root:
  - id: badge
    type: Group2D
    name: Badge
    properties:
      width: 300
      height: 80
    children:
      - id: badge-label
        type: Label2D
        name: Badge Label
        properties:
          label: "badge"
          labelFontSize: 40
          labelColor: "#ffcf33"
        children: []
`;
const prefabInstance = (id) => `  - id: ${id}
    name: Badge Instance
    instance: res://prefabs/badge.pix3scene
    properties:
      visible: true
`;
// The entry scene: the starter's, plus the flow script on its root and the prefab beside it.
const mainPath = join(PROJ, 'scenes/main.pix3scene');
let main = readFileSync(mainPath, 'utf8');
main = main.replace(
  /^(root:\n  - id: game-root\n    type: \w+\n    name: Game Root\n)/m,
  `$1    components:\n      - id: flow\n        type: user:MainFlow\n        enabled: true\n        config: {}\n      - id: lib-box\n        type: user:LibBox\n        enabled: true\n        config: {}\n`
);
if (!main.includes('user:MainFlow')) throw new Error('could not place MainFlow on the starter root');
main += prefabInstance('badge-in-main');
writeFileSync(mainPath, main);
write(
  'scenes/second.pix3scene',
  `version: 1.0.0
root:
  - id: second-root
    type: Group2D
    name: Second Root
    properties:
      width: 1920
      height: 1080
    components:
      - id: second-flow
        type: user:SecondFlow
        enabled: true
        config: {}
    children:
      - id: second-background
        type: ColorRect2D
        name: Second Background
        properties:
          width: 1920
          height: 1080
          color: "#16213e"
        children: []
${prefabInstance('badge-in-second')}`
);
write('prefabs/badge.pix3scene', PREFAB);
write(
  'scripts/MainFlow.ts',
  `import { Script } from '@pix3/runtime';
import type { Counter } from './Counter';

declare global {
  interface Window {
    __PIX3_CHECK__?: {
      ticks: number;
      changed: boolean;
      second: boolean;
      prefabFound: boolean;
      libBox: boolean;
      counter: { attached: number; ticks: number; id: string } | null;
      counterAtChange: { ticks: number; id: string } | null;
      counterInSecond: { ticks: number; id: string } | null;
    };
  }
}

export const checkState = (): NonNullable<Window['__PIX3_CHECK__']> =>
  (window.__PIX3_CHECK__ ??= {
    ticks: 0,
    changed: false,
    second: false,
    prefabFound: false,
    libBox: false,
    counter: null,
    counterAtChange: null,
    counterInSecond: null,
  });

/** On the entry scene's root: after a few frames, change to the second scene. */
export class MainFlow extends Script {
  onUpdate(): void {
    const state = checkState();
    state.ticks++;
    if (state.ticks === 5 && !state.changed) {
      state.changed = true;
      const counter = this.scene?.getAutoload<Counter>('Counter');
      state.counterAtChange = counter ? { ticks: counter.ticks, id: counter.instanceId } : null;
      void this.scene?.changeScene('res://scenes/second.pix3scene');
    }
  }
}
`
);
write(
  'scripts/SecondFlow.ts',
  `import { Script, type NodeBase } from '@pix3/runtime';
import { Counter } from './Counter';
import { checkState } from './MainFlow';

/** On the second scene's root: the nested prefab's label must be in the running tree. */
export class SecondFlow extends Script {
  onStart(): void {
    const state = checkState();
    state.second = true;
    const roots = this.scene?.getRootNodes() ?? [];
    const found = (node: NodeBase): boolean =>
      (node as { label?: unknown }).label === 'badge' ||
      (node.children as NodeBase[]).some(child => found(child));
    state.prefabFound = roots.some(found);
    const counter = this.scene?.getAutoload(Counter);
    state.counterInSecond = counter ? { ticks: counter.ticks, id: counter.instanceId } : null;
  }
}
`
);
// The project's autoload: one counter for the whole session, declared in pix3project.yaml.
write(
  'scripts/Counter.ts',
  `import { Script } from '@pix3/runtime';
import { checkState } from './MainFlow';

/** Autoload: ticks every frame, outlives changeScene. */
export class Counter extends Script {
  ticks = 0;
  readonly instanceId = Math.random().toString(36).slice(2);
  onAttach(): void {
    const state = checkState();
    state.counter = { attached: (state.counter?.attached ?? 0) + 1, ticks: 0, id: this.instanceId };
  }
  onUpdate(): void {
    this.ticks++;
    const state = checkState();
    if (state.counter) state.counter.ticks = this.ticks;
  }
}
`
);
{
  const manifestPath = join(PROJ, 'pix3project.yaml');
  const manifest = readFileSync(manifestPath, 'utf8');
  const autoloads = 'autoloads:\n  - singleton: Counter\n    scriptPath: scripts/Counter.ts\n';
  writeFileSync(
    manifestPath,
    /^autoloads: \[\]$/m.test(manifest) ? manifest.replace(/^autoloads: \[\]\n?/m, autoloads) : `${manifest.trimEnd()}\n${autoloads}`
  );
}
write(
  'scripts/LibBox.ts',
  `import { Script } from '@pix3/runtime';
import { makeBox } from 'build-check-lib';
import { checkState } from './MainFlow';

/** The library constructs a GeometryMesh the project never names: a stub would throw here. */
export class LibBox extends Script {
  onStart(): void {
    const box = makeBox();
    checkState().libBox = typeof box === 'object' && box !== null;
  }
}
`
);
const pkg = JSON.parse(readFileSync(join(PROJ, 'package.json'), 'utf8'));
pkg.dependencies['build-check-lib'] = 'file:./lib';
writeFileSync(join(PROJ, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// node_modules: links to the checkout's entries (+ Vite 7 and a plugin copy for --vite 7),
// plus the local library.
const coreModules = join(CORE, 'node_modules');
const nm = join(PROJ, 'node_modules');
mkdirSync(nm);
const link = (from, to) => symlinkSync(from, to, 'dir');
for (const entry of readdirSync(coreModules)) {
  if (entry === '.bin' || entry === '.package-lock.json') continue;
  if (entry === 'vite' && VITE === '7') {
    link(join(VITE7, 'node_modules/vite'), join(nm, 'vite'));
    continue;
  }
  if (entry === '@pix3') {
    mkdirSync(join(nm, '@pix3'));
    for (const sub of readdirSync(join(coreModules, '@pix3'))) {
      if (sub === 'vite-plugin' && VITE === '7') {
        // A copy, so the plugin's own `import 'vite'` resolves the project's Vite 7, not the
        // checkout's Vite 8 next to packages/vite-plugin.
        const src = join(coreModules, '@pix3/vite-plugin');
        const dst = join(nm, '@pix3/vite-plugin');
        mkdirSync(dst);
        cpSync(join(src, 'package.json'), join(dst, 'package.json'));
        cpSync(join(src, 'dist'), join(dst, 'dist'), { recursive: true });
        continue;
      }
      link(join(coreModules, '@pix3', sub), join(nm, '@pix3', sub));
    }
    continue;
  }
  link(join(coreModules, entry), join(nm, entry));
}
if (VITE === '7' && !existsSync(join(VITE7, 'node_modules/vite/package.json'))) {
  throw new Error(`--vite 7 needs a Vite 7 install in ${VITE7} (cd there and npm install)`);
}
mkdirSync(join(nm, 'build-check-lib'));
writeFileSync(
  join(nm, 'build-check-lib/package.json'),
  JSON.stringify({ name: 'build-check-lib', version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@pix3/runtime': '*' } })
);
writeFileSync(
  join(nm, 'build-check-lib/index.js'),
  LIB === 'namespace'
    ? "import * as pix3 from '@pix3/runtime';\nexport const makeBox = () => new pix3.GeometryMesh({ id: 'lib-box', name: 'Lib Box', geometry: 'box' });\n"
    : "import { GeometryMesh } from '@pix3/runtime';\nexport const makeBox = () => new GeometryMesh({ id: 'lib-box', name: 'Lib Box', geometry: 'box' });\n"
);
if (COMPRESS) {
  writeFileSync(
    join(PROJ, 'vite.config.ts'),
    "import { defineConfig } from 'vite';\nimport { pix3 } from '@pix3/vite-plugin';\n\nexport default defineConfig({ plugins: [pix3({ compress: true })] });\n"
  );
}

// --- 2. vite build through the project's own config, as `npm run build` would -------------------
const viteDir = VITE === '7' ? join(VITE7, 'node_modules/vite') : join(CORE, 'node_modules/vite');
const vite = await import(pathToFileURL(join(viteDir, 'dist/node/index.js')).href);
const viteVersion = JSON.parse(readFileSync(join(viteDir, 'package.json'), 'utf8')).version;
console.log(`vite ${viteVersion}, template ${TEMPLATE}, compress ${COMPRESS}, lib ${LIB}`);
check(`vite ${VITE}.x in use`, viteVersion.startsWith(`${VITE}.`), viteVersion);
const t0 = Date.now();
process.env.PIX3_NO_SYNC = '1';
let buildError = null;
try {
  await vite.build({ root: PROJ, configFile: join(PROJ, 'vite.config.ts'), logLevel: 'warn' });
} catch (error) {
  buildError = error;
}
check('vite build succeeded', buildError === null, buildError ? String(buildError?.message ?? buildError).slice(0, 400) : undefined);
if (buildError) {
  console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`);
  process.exit(1);
}
const record = JSON.parse(readFileSync(join(PROJ, '.pix3/build.json'), 'utf8'));
const report = JSON.parse(readFileSync(record.report, 'utf8'));
check('vite build wrote dist/index.html, .pix3/build.json and the report', existsSync(record.path) && existsSync(record.report), {
  ms: Date.now() - t0,
  kib: Math.round(record.bytes / 1024),
  gzipKib: Math.round(report.gzipBytes / 1024),
  entry: record.entryScene,
  scenes: report.scenes,
  assets: record.assets,
  stripped: record.stripped.length,
  libraries: report.libraries,
  compress: report.compress,
  groups: Object.fromEntries(Object.entries(report.code.groups).map(([g, v]) => [g, v.estimatedMinifiedBytes])),
  warnings: record.warnings,
});
const html = readFileSync(record.path, 'utf8');
check('classic script, no ESM residue', !/type="module"|crossorigin|import\.meta/.test(html));
check('only index.html and its report in dist/', readdirSync(join(PROJ, 'dist')).sort().join(',') === 'index.html,index.report.json');
if (report.strip.enabled) {
  check('no yaml parser in the bundle (scenes ship as JSON)', !/YAMLParseError|LineCounter/.test(html) && /^stub/.test(report.libraries.yaml));
  check('GLTFLoader stubbed (no model in the project)', /^stub/.test(report.libraries.GLTFLoader));
} else {
  check('strip off: yaml and GLTFLoader bundled', /YAMLParseError/.test(html) && /KHR_materials/.test(html) && report.libraries.yaml === 'bundled' && report.libraries.GLTFLoader === 'bundled');
}
if (COMPRESS) {
  check('compressed: one bootstrap script with DecompressionStream, no eval/blob', (html.match(/<script\b/g) ?? []).length === 1 && html.includes("new DecompressionStream('gzip')") && !/createObjectURL|\beval\(|new Function/.test(html));
  check('compressed: file under half of the bundle', report.compress.enabled && record.bytes < report.compress.bundleBytes / 2, { bytes: record.bytes, bundle: report.compress.bundleBytes });
}
if (LIB === 'namespace') {
  check('N11 import * as: strip off, message names pix3({ strip: { keep } })', report.strip.enabled === false && /pix3\(\{ strip: \{ keep:/.test(report.strip.reason ?? ''), report.strip.reason);
} else {
  check('N11 named import: strip on, GeometryMesh kept (not stubbed)', report.strip.enabled && !record.stripped.includes('nodes/3D/GeometryMesh') && !html.includes('GeometryMesh was stripped') && report.strip.dependencyImports.includes('GeometryMesh'), { dependencies: report.strip.dependencies, imports: report.strip.dependencyImports });
  check('N11: unrelated modules still stripped', record.stripped.includes('nodes/2D/UI/Slider2D'));
}

// The sandbox wrapper: an opaque-origin frame around the artifact (no allow-same-origin).
writeFileSync(
  join(PROJ, 'dist/sandbox.html'),
  '<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" src="index.html" style="width:100vw;height:100vh;border:0"></iframe></body></html>\n'
);

// --- 3. headless Chrome: preview, file://, sandboxed iframe -------------------------------------
const PORT = await freePort();
const CDP_PORT = await freePort();
const preview = await vite.preview({ root: PROJ, configFile: false, build: { outDir: 'dist' }, preview: { port: PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'warn' });
mkdirSync(PROFILE, { recursive: true });
chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=600,1000', 'about:blank'], { stdio: 'ignore' });
let browser;

const PLAYER = `(() => { const p = window.__PIX3_PLAYER__; return p ? { status: p.status, frames: p.frames, errors: p.errors, scene: p.scene, check: window.__PIX3_CHECK__ ?? null } : null; })()`;

const judge = async (name, page) => {
  try {
    await page.waitFor(`(${PLAYER})?.frames > 0`, 30000, 100);
    // The entry scene changes to the second one after five ticks; wait for it.
    await page.waitFor(`(${PLAYER})?.check?.second === true`, 15000, 100);
  } catch {
    // reported below
  }
  const first = await page.evaluate(PLAYER);
  await new Promise(r => setTimeout(r, 1000));
  const second = await page.evaluate(PLAYER);
  const alive = !!first && !!second && second.frames > first.frames;
  check(`${name}: status running, frames > 0 and counting`, first?.status === 'running' && alive, { first: { ...first, check: undefined }, second: { ...second, check: undefined } });
  check(`${name}: changeScene reached the second scene, the nested prefab is in it`, second?.check?.changed && second?.check?.second && second?.check?.prefabFound, second?.check);
  check(`${name}: the library's GeometryMesh was constructed`, second?.check?.libBox === true);
  {
    const c = second?.check;
    check(
      `${name}: the autoload counter ticks, survives changeScene as one instance and keeps counting`,
      c?.counter?.attached === 1 &&
        c?.counterAtChange?.id === c?.counter?.id &&
        c?.counterInSecond?.id === c?.counter?.id &&
        c.counterAtChange.ticks >= 5 &&
        c.counterInSecond.ticks > c.counterAtChange.ticks &&
        c.counter.ticks > (first?.check?.counter?.ticks ?? Infinity),
      { counter: c?.counter, atChange: c?.counterAtChange, inSecond: c?.counterInSecond, before: first?.check?.counter }
    );
  }
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
  killChrome();
  await new Promise(resolve => preview.httpServer.close(resolve));
  if (!KEEP) {
    rmSync(PROFILE, { recursive: true, force: true });
    rmSync(PROJ, { recursive: true, force: true });
  }
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed (vite ${viteVersion}, ${TEMPLATE}${COMPRESS ? ', compressed' : ''}, lib ${LIB})`);
  process.exit(failed ? 1 : 0);
}
