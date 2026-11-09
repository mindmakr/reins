import { findMarker, MARKER } from './lib.js';

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
    err(`reins-verify-bundle: ${found} file(s) contain reins dev code. Use the @reins/vite, @reins/next or @reins/expo plugin, or check REINS_ENABLE.`);
    return 1;
  }
  out(`reins-verify-bundle: clean (${dirs.join(', ')})`);
  return 0;
}
