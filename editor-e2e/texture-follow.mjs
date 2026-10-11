// An image overwritten on disk repaints in the editor viewport without a reload (pix3-core
// `.plans/editor-core-port.md` → "Texture refresh"), in headless Chrome.
//
// A `pix3 new 2d` project (`proj-texture/`, made here) whose entry scene draws one PNG three ways:
// a Sprite2D (2D proxy), a Sprite3D (3D content sync) and an AnimatedSprite3D frame (runtime node,
// frames from the shared AssetLoader). The "agent" rewrites the PNG with fs, a different colour
// each time. Judged by the pixel at each node's screen point in a CDP screenshot (decoded in the
// page, not read from the editor's own state). Checks:
//   - red at all three points after opening;
//   - after an overwrite with green: green at all three, no page reload (a window marker survives),
//     nothing pending;
//   - during play an overwrite with blue is held (pending, per ExternalChangeService step 4);
//     after stop the viewport shows blue.
//
// Usage: node texture-follow.mjs [--core <pix3-core checkout>]   (rebuild editor-core first)
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import { bridge, HERE, makeChecks, openEditor, resolveCore, sleep, startChrome, startServer, waitUntil } from './harness.mjs';

const CORE = resolveCore();
const PROJ = join(HERE, 'proj-texture');
const PNG_PATH = join(PROJ, 'sprites', 'probe.png');
const { check, finish } = makeChecks();

/** A solid 64×64 RGBA PNG. */
const solidPng = ([r, g, b]) => {
  const size = 64;
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) row.set([r, g, b, 255], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];

const SCENE = `version: 1.0.0
metadata:
  description: texture-follow probe
root:
  - id: probe-2d
    type: Sprite2D
    name: Probe 2D
    properties:
      texture: { type: 'texture', url: 'res://sprites/probe.png' }
      width: 160
      height: 160
      transform:
        position: [-500, 250]
        scale: [1, 1]
        rotation: 0
    children: []
  - id: probe-3d
    type: Sprite3D
    name: Probe 3D
    properties:
      texture: { type: 'texture', url: 'res://sprites/probe.png' }
      width: 2
      height: 2
      billboard: true
      transform:
        position: [-1.5, 0, 0]
        rotationEuler: [0, 0, 0]
        scale: [1, 1, 1]
    children: []
  - id: probe-anim3d
    type: AnimatedSprite3D
    name: Probe Anim 3D
    properties:
      frames:
        - { type: 'texture', url: 'res://sprites/probe.png' }
      width: 2
      height: 2
      playing: false
      billboard: true
      transform:
        position: [1.5, 0, 0]
        rotationEuler: [0, 0, 0]
        scale: [1, 1, 1]
    children: []
`;

// --- project --------------------------------------------------------------------------------------
rmSync(PROJ, { recursive: true, force: true });
spawnSync(process.execPath, [join(CORE, 'packages', 'cli', 'src', 'index.ts'), 'new', '2d', 'proj-texture', '--name', 'texture-e2e'], { cwd: HERE, stdio: 'ignore' });
symlinkSync(join(CORE, 'node_modules'), join(PROJ, 'node_modules'));
mkdirSync(join(PROJ, 'sprites'), { recursive: true });
writeFileSync(PNG_PATH, solidPng(RED));
writeFileSync(join(PROJ, 'scenes', 'main.pix3scene'), SCENE);

const { server, base } = await startServer(CORE, PROJ, join(HERE, '.vite-cache-texture'));
const { chrome, browser } = await startChrome(join(HERE, 'profile-texture'));
try {
  const page = await openEditor(browser, base, 'texture');
  const b = bridge(page);
  await sleep(2000);
  await page.evaluate(`window.__textureFollowMarker = 'same-page'`);

  const ids = ['probe-2d', 'probe-3d', 'probe-anim3d'];
  const points = {};
  for (const id of ids) points[id] = await b.screen(id);
  check('every probe has a screen point', ids.every(id => points[id]), points);
  const apart = (a, c) => Math.hypot(a.x - c.x, a.y - c.y) > 40;
  check('the three probes are apart on screen', apart(points['probe-2d'], points['probe-3d']) && apart(points['probe-2d'], points['probe-anim3d']) && apart(points['probe-3d'], points['probe-anim3d']), points);

  /** The colour at each probe's screen point, from a CDP screenshot decoded in the page. */
  const sample = async () => {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    return page.evaluate(`(async () => {
      const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,${data}')).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / window.innerWidth;
      const points = ${JSON.stringify(points)};
      const out = {};
      // The most saturated pixel of a 17×17 patch: a grid line drawn over the quad is grey.
      for (const [id, p] of Object.entries(points)) {
        const patch = ctx.getImageData(Math.round(p.x * scale) - 8, Math.round(p.y * scale) - 8, 17, 17).data;
        let best = [0, 0, 0];
        for (let i = 0; i < patch.length; i += 4) {
          const rgb = [patch[i], patch[i + 1], patch[i + 2]];
          if (Math.max(...rgb) - Math.min(...rgb) > Math.max(...best) - Math.min(...best)) best = rgb;
        }
        out[id] = best;
      }
      return out;
    })()`);
  };
  const is = (rgb, want) => rgb.every((v, i) => Math.abs(v - want[i]) <= 60);
  const allAre = want => async () => {
    const colours = await sample();
    return ids.every(id => is(colours[id], want)) ? colours : null;
  };

  const red = await waitUntil(allAre(RED), 8000);
  check('red at all three probes after opening', red.v, red.v ?? (await sample()));

  writeFileSync(PNG_PATH, solidPng(GREEN));
  const green = await waitUntil(allAre(GREEN), 8000);
  check('overwritten with green → green at all three, no reload', green.v, { ms: green.ms, colours: green.v ?? (await sample()) });
  check('same page (no reload)', (await page.evaluate(`window.__textureFollowMarker`)) === 'same-page');
  const pendingExternal = async () => (await b.status()).pendingExternal ?? [];
  const settled = await waitUntil(async () => !(await pendingExternal()).includes('sprites/probe.png'), 4000);
  check('the image is not pending after the refresh', settled.v, await pendingExternal());

  // Play holds external changes (ExternalChangeService step 4): applied when play stops.
  const started = await b.play.start();
  check('play starts', started?.ok !== false, started);
  await sleep(1000);
  writeFileSync(PNG_PATH, solidPng(BLUE));
  const held = await waitUntil(async () => (await pendingExternal()).includes('sprites/probe.png'), 5000);
  await sleep(1000); // settled and held, not just settling
  check('a write during play is held (pendingExternal)', held.v && (await pendingExternal()).includes('sprites/probe.png'), await pendingExternal());
  const stopped = await b.play.stop();
  check('play stops', stopped?.ok !== false, stopped);
  const blue = await waitUntil(allAre(BLUE), 8000);
  check('after stop → blue at all three', blue.v, { ms: blue.ms, colours: blue.v ?? (await sample()) });
  const errors = await b.errors();
  check('no editor errors', !errors?.length, errors);
} finally {
  browser.close();
  chrome.kill();
  await server.close();
}
finish();
