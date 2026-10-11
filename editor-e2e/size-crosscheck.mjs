// Cross-check of .plans/write-model.md W1/W2 (S12 §4.2): a node whose size can come from an image
// must normalise the same in the EDITOR (the browser decodes the image) and in Node (`pix3
// validate`, the plugin: `NodeAssetLoader` reads the image header) — else one scene has two norms.
//
// 1. `Sprite2D`, un-sized, per image kind: editor size == `readImageHeaderSize` (PNG/JPEG/WebP made
//    by Chrome itself, 8 SVG variants).
// 2. Every textured node type, un-sized (`AnimatedSprite2D` stretch + native over a `.pix3anim`,
//    `AnimatedSprite3D`, `Sprite3D`, `TiledSprite2D`, `Button2D`, `Bar2D`, `Slider2D`,
//    `Checkbox2D`): the editor's saved node == the Node norm of the same file, property by property.
// 3. Auto-sized UI — a `flow` column with `autoSize` stacking un-sized sprites: the editor lays it
//    out from decoded sizes, Node from header sizes; the children must land on the same positions.
//
// Async bridge v2, free ports, a fresh `proj-size/` from the corpus. `--core <checkout>`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { bridge, HERE, makeChecks, makeProject, openEditor, resolveCore, startChrome, startServer } from './harness.mjs';

const CORE = resolveCore();
const PROJ = makeProject(CORE, 'recipe-tapper-2d', join(HERE, 'proj-size'));
const { check, finish } = makeChecks();

/** Equal as JSON documents, numbers within 1e-6 (the saver's float noise). */
const same = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter(k => a[k] !== undefined).sort();
    const kb = Object.keys(b).filter(k => b[k] !== undefined).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same(a[k], b[k]));
  }
  return a === b;
};
const differing = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !same(a[k], b[k])).map(k => ({ key: k, editor: a[k], node: b[k] }));

// Node side: the runtime's own harness (`NodeAssetLoader` + the saver), loaded through Vite's SSR.
const { createServer } = await import(pathToFileURL(join(CORE, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
const ssr = await createServer({ configFile: false, root: CORE, logLevel: 'warn', server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
const nodeMod = await ssr.ssrLoadModule(`${CORE}/packages/runtime/src/node/index.ts`);
const corpus = await ssr.ssrLoadModule(`${CORE}/packages/runtime/src/node/scene-corpus.ts`);
const runtime = await ssr.ssrLoadModule(`${CORE}/packages/runtime/src/index.ts`);
const { readImageHeaderSize } = await ssr.ssrLoadModule(`${CORE}/packages/runtime/src/core/image-header-size.ts`);

const { chrome, browser } = await startChrome(join(HERE, 'profile-size'), []);
const scenePath = join(PROJ, 'scenes/main.pix3scene');
let server;
try {
  // --- images: raster from Chrome's own encoders, SVG variants by hand ----------------------------
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
  writeFileSync(join(PROJ, 'sprites/xcheck.pix3anim'), JSON.stringify({
    version: '1.0.0',
    texturePath: '',
    clips: [{ name: 'idle', fps: 8, loop: true, frames: [{ texturePath: 'res://sprites/xcheck.png' }, { texturePath: 'res://sprites/xcheck-viewbox.svg' }] }],
  }, null, 2));

  // --- the scene ------------------------------------------------------------------------------------
  const names = Object.keys(files);
  const tex = name => `{ type: texture, url: res://sprites/${name} }`;
  const node = (id, type, props, extra = []) => [`  - id: ${id}`, `    type: ${type}`, `    name: ${id}`, '    properties:', ...props.map(p => `      ${p}`), ...extra];
  const typed = [
    ['anim-stretch', 'AnimatedSprite2D', ['animationResourcePath: res://sprites/xcheck.pix3anim']],
    ['anim-native', 'AnimatedSprite2D', ['animationResourcePath: res://sprites/xcheck.pix3anim', 'sizeMode: native']],
    ['anim3d', 'AnimatedSprite3D', ['animationResourcePath: res://sprites/xcheck.pix3anim']],
    ['sprite3d-png', 'Sprite3D', [`texture: ${tex('xcheck.png')}`]],
    ['sprite3d-svg', 'Sprite3D', [`texture: ${tex('xcheck-viewbox.svg')}`]],
    ['tiled', 'TiledSprite2D', [`texture: ${tex('xcheck.webp')}`]],
    ['button', 'Button2D', [`textureNormal: ${tex('xcheck.png')}`, `textureHover: ${tex('xcheck-attrs.svg')}`]],
    ['bar', 'Bar2D', [`textureTrough: ${tex('xcheck.jpg')}`, `textureFill: ${tex('xcheck-px.svg')}`]],
    ['slider', 'Slider2D', [`textureTrack: ${tex('xcheck.png')}`, `textureThumb: ${tex('xcheck-bare.svg')}`]],
    ['checkbox', 'Checkbox2D', [`textureBox: ${tex('xcheck.webp')}`, `textureMark: ${tex('xcheck-width-only.svg')}`]],
  ];
  const flowKids = ['xcheck.png', 'xcheck-viewbox.svg', 'xcheck-height-viewbox.svg', 'xcheck.jpg'];
  const scene = ['version: 1.0.0', 'root:',
    ...names.flatMap((name, i) => node(`s${i}`, 'Sprite2D', [`texture: ${tex(name)}`])),
    ...typed.flatMap(([id, type, props]) => node(id, type, props)),
    ...node('column', 'Group2D', ['width: 200', 'height: 10', 'flow:', '  enabled: true', '  gap: 4', '  autoSize: true'], [
      '    children:',
      ...flowKids.flatMap((name, i) => [`      - id: f${i}`, '        type: Sprite2D', `        name: f${i}`, '        properties:', `          texture: ${tex(name)}`]),
    ]),
  ].join('\n') + '\n';
  writeFileSync(scenePath, scene);

  // --- editor ---------------------------------------------------------------------------------------
  ({ server } = await startServer(CORE, PROJ, join(HERE, '.vite-cache-size')));
  const page = await openEditor(browser, `http://127.0.0.1:${server.config.server.port}`, 'editor');
  const b = bridge(page);
  await page.waitFor(`(async () => !!(await window.__PIX3_DEBUG__.node('s0')))()`, 30000);
  await new Promise(r => setTimeout(r, 2500)); // animation resources and frame textures load async
  const editorNode = async id => { const n = await b.node(id); return n ? { saved: n.saved, position: n.transform?.position ?? null } : null; };

  // --- Node -----------------------------------------------------------------------------------------
  const uninstall = nodeMod.installCanvasOnlyDocument();
  const h = corpus.createSceneHarness(PROJ);
  const graph = await h.parse(scene, 'scenes/main.pix3scene');
  await new Promise(r => setTimeout(r, 300)); // the same async asset loads, on the Node side
  const nodeNorm = h.normOf(graph);
  const nodeDefs = new Map();
  const index = defs => (defs ?? []).forEach(d => { nodeDefs.set(d.id, d); index(d.children); });
  index(nodeNorm.root);
  for (const root of graph.rootNodes) if (root instanceof runtime.Node2D) root.applyAnchoredLayoutRecursive({ width: 720, height: 1280 }, { width: 720, height: 1280 });
  uninstall();

  // 1. Sprite2D: editor (decoded) vs header.
  for (const [i, name] of names.entries()) {
    const props = (await editorNode(`s${i}`))?.saved?.properties ?? null;
    const header = readImageHeaderSize(new Uint8Array(files[name]));
    const editor = props ? { width: props.width, height: props.height } : null;
    check(`Sprite2D ${name}: editor size == header size`, header && editor && header.width === editor.width && header.height === editor.height, { editor, header });
  }
  // 2. Every textured type: the saved node, property by property.
  for (const [id, type] of [...names.map((_, i) => [`s${i}`, 'Sprite2D']), ...typed]) {
    const editor = (await editorNode(id))?.saved ?? null;
    const diff = differing(editor?.properties, nodeDefs.get(id)?.properties);
    check(`${type} ${id}: editor norm == Node norm`, editor && diff.length === 0, diff.length ? diff : { width: editor?.properties?.width, height: editor?.properties?.height });
  }
  // 3. Auto-sized flow column: same layout from decoded and from header sizes.
  for (const [i] of flowKids.entries()) {
    const editor = (await editorNode(`f${i}`))?.position;
    const n = graph.nodeMap.get(`f${i}`);
    const nodePos = n ? { x: n.position.x, y: n.position.y } : null;
    check(`flow autoSize child f${i} (${flowKids[i]}): editor position == Node position`, editor && nodePos && same(editor.x, nodePos.x) && same(editor.y, nodePos.y), { editor, node: nodePos });
  }
  check('the scene file was not written by opening it', readFileSync(scenePath, 'utf8') === scene);
  const pending = await b.pending();
  check('nothing pending after opening (flow positions and autoSize are not edits)', JSON.stringify(pending) === '{}', pending);
  const errors = (await b.errors()).slice(0, 4);
  check('no captured editor errors', errors.length === 0, errors);
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  browser.close();
  chrome.kill();
  await server?.close();
  await ssr.close();
  finish();
}
