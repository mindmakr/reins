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

/** Runs the check and returns the exit code: 0 clean, 1 marker found, 2 bad usage. */
export function main(args: string[], out = console.log, err = console.error): number {
  const dirs = args.filter((a) => !a.startsWith('-'));
  if (dirs.length === 0 || args.includes('--help') || args.includes('-h')) {
    err('usage: reins-verify-bundle <dir> [<dir>...]');
    err(`Exits 1 if any file contains ${MARKER}, which means reins dev code is in a production build.`);
    return 2;
  }
  let found = 0;
  for (const dir of dirs) {
    let hits: string[];
    try {
      hits = findMarker(dir);
    } catch (e: any) {
      err(`reins-verify-bundle: ${e.message}`);
      return 2;
    }
    for (const hit of hits) err(`reins dev code found: ${dir}/${hit}`);
    found += hits.length;
  }
  if (found > 0) {
    err(`reins-verify-bundle: ${found} file(s) contain reins dev code. Use the reins/vite, reins/next or reins/metro plugin, or check REINS_ENABLE.`);
    return 1;
  }
  out(`reins-verify-bundle: clean (${dirs.join(', ')})`);
  return 0;
}
