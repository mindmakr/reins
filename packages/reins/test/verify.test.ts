import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findMarker, main, MARKER } from '../src/verify.js';

const dirs: string[] = [];
function bundleDir(files: Record<string, string | Buffer>) {
  const dir = mkdtempSync(join(tmpdir(), 'reins-verify-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quiet = () => {};

describe('findMarker', () => {
  it('finds the marker in nested files, including binary ones, and skips node_modules', () => {
    const dir = bundleDir({
      'index.html': '<html></html>',
      'assets/app.js': `var a="${MARKER}";`,
      'assets/clean.js': 'var b=1;',
      'main.hbc': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(MARKER), Buffer.from([3])]),
      'node_modules/reins/index.js': MARKER,
    });
    expect(findMarker(dir).sort()).toEqual(['assets/app.js', 'main.hbc']);
  });
});

describe('reins-verify-bundle', () => {
  it('exits 0 for a clean bundle', () => {
    expect(main([bundleDir({ 'a.js': 'ok' })], quiet, quiet)).toBe(0);
  });

  it('exits 1 when the marker is present', () => {
    const errors: string[] = [];
    expect(main([bundleDir({ 'a.js': MARKER })], quiet, (m) => errors.push(m))).toBe(1);
    expect(errors.join('\n')).toMatch(/a\.js/);
  });

  it('exits 2 without a directory or with a missing one', () => {
    expect(main([], quiet, quiet)).toBe(2);
    expect(main([join(tmpdir(), 'reins-does-not-exist-' + Date.now())], quiet, quiet)).toBe(2);
  });

  const built = fileURLToPath(new URL('../dist/verify-cli.js', import.meta.url));
  it.skipIf(!existsSync(built))('runs as a CLI process (after npm run build)', () => {
    const run = (dir: string) => {
      try {
        execFileSync(process.execPath, [built, dir], { stdio: 'pipe' });
        return 0;
      } catch (e: any) {
        return e.status as number;
      }
    };
    expect(run(bundleDir({ 'a.js': MARKER }))).toBe(1);
    expect(run(bundleDir({ 'a.js': 'clean' }))).toBe(0);
  });
});