import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Box } from '@mindmakr/reins';
import { copyImage } from './clipboard.js';
import type { Client } from './hub.js';

export interface SnapOptions {
  dir: string;
  /** Chrome DevTools endpoint, for example http://127.0.0.1:9222. Needed for browser snaps. */
  cdp?: string;
  copy?: boolean;
}

export interface SnapResult {
  box: Box;
  file?: string;
  copied?: boolean;
  /** For full-screen device captures: the panel in device pixels, to crop with. */
  pixelBox?: { x: number; y: number; width: number; height: number };
  note?: string;
}

async function loadPlaywright(): Promise<any> {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return await import(name);
    } catch {
      // try the next one
    }
  }
  return null;
}

const stripQuery = (url = '') => url.split(/[?#]/)[0];

function snapFile(dir: string, id: string): string {
  const folder = join(dir, '.reins', 'snaps');
  mkdirSync(folder, { recursive: true });
  return join(folder, `${id.replace(/[^A-Za-z0-9._-]/g, '_')}-${Date.now()}.png`);
}

const pixels = (b: Box) => ({
  x: Math.round(b.x * b.devicePixelRatio),
  y: Math.round(b.y * b.devicePixelRatio),
  width: Math.round(b.width * b.devicePixelRatio),
  height: Math.round(b.height * b.devicePixelRatio),
});

/**
 * Takes a pixel-exact picture of a panel.
 * Browser: Playwright over CDP, clipped to the box (viewport CSS pixels).
 * Android (Expo): a full-screen `adb screencap` plus the box in device pixels.
 * Otherwise it returns the box so the agent's own driver can clip.
 */
export async function snap(box: Box, client: Client | undefined, opts: SnapOptions): Promise<SnapResult> {
  if (client && client.meta && client.meta.platform === 'android') {
    try {
      const png = execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
      const file = snapFile(opts.dir, box.id);
      writeFileSync(file, png);
      return { box, file, pixelBox: pixels(box), note: 'Full screen; crop to pixelBox.', copied: opts.copy ? copyImage(file) : undefined };
    } catch {
      return { box, pixelBox: pixels(box), note: 'adb screencap failed; is adb on PATH and a device attached?' };
    }
  }
  const pw = await loadPlaywright();
  if (!pw || !opts.cdp) {
    return { box, note: pw ? 'Start the bridge with --cdp <url> to take snaps.' : 'Playwright is not installed; clip your own screenshot to this box (viewport CSS pixels).' };
  }
  const browser = await pw.chromium.connectOverCDP(opts.cdp);
  try {
    const pages: any[] = browser.contexts().flatMap((c: any) => c.pages());
    const want = stripQuery(client && client.url);
    const page = pages.find((p) => stripQuery(p.url()) === want) || pages[0];
    if (!page) return { box, note: 'No page found over CDP.' };
    const file = snapFile(opts.dir, box.id);
    await page.screenshot({ path: file, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    return { box, file, copied: opts.copy ? copyImage(file) : undefined };
  } finally {
    // For CDP connections this disconnects; it does not close the person's browser.
    await browser.close();
  }
}
