// Shared M3 harness: Vite + pix3() on the scratch project, headless Chrome over raw CDP.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { pix3 } from '/data/igor.gritsenko/projects/pix3-stuff/pix3-core/packages/vite-plugin/dist/index.js';
import { Browser } from './cdp.mjs';

export const HERE = import.meta.dirname;
export const PROJ = join(HERE, 'proj');
export const BASE = 'http://127.0.0.1:5294';

export async function start() {
  const server = await createServer({ configFile: false, root: PROJ, logLevel: 'warn', cacheDir: join(HERE, '.vite-cache'), plugins: [pix3()], server: { port: 5294, strictPort: true, host: '127.0.0.1' } });
  await server.listen();
  mkdirSync(join(HERE, 'profile3'), { recursive: true });
  const chrome = spawn('/data/igor.gritsenko/projects/pix3-stuff/pix3-core-spikes/chrome.sh', ['--remote-debugging-port=9364', `--user-data-dir=${join(HERE, 'profile3')}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  const browser = await Browser.connect(9364);
  const openEditor = async name => {
    const page = await browser.newPage(name);
    await page.navigate(`${BASE}/__pix3/`);
    await page.waitFor(`!!window.__PIX3_DEBUG__ && !!window.__PIX3_DEBUG__.status().activeScene`, 60000);
    return page;
  };
  const stop = async () => { browser.close(); chrome.kill(); await server.close(); };
  return { server, browser, openEditor, stop };
}
