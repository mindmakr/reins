import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The string the reins core carries. It must never reach a production bundle. */
export const MARKER = '__REINS_DEV_ONLY__';

const SKIP = new Set(['node_modules', '.git']);

/** Every file under `dir`, skipping node_modules and .git. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Files under `dir` (relative paths, forward slashes) that contain the marker.
 * Reads bytes, so it also finds the marker in Hermes bytecode and source maps.
 */
export function findMarker(dir: string, marker: string = MARKER): string[] {
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  const needle = Buffer.from(marker);
  return listFiles(dir)
    .filter((file) => readFileSync(file).includes(needle))
    .map((file) => relative(dir, file).split('\\').join('/'));
}
