import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const entry = (name: string) => fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url));

// `external` keeps the shared core out of the record entry's count: an app that records already loads it.
async function bundle(name: string, external: string[] = []) {
  const out = await build({ entryPoints: [entry(name)], bundle: true, minify: true, format: 'esm', write: false, platform: 'browser', external });
  return out.outputFiles[0].text;
}

// Files the core has already loaded: an entry that also imports one shares that copy, so it is not counted again.
const SHARED = ['./redact.js'];

describe('size', () => {
  it('core is under 5 KB min+gzip', async () => {
    // The DOM inspector is a file of its own that the core loads on the first `dom()` call, so it is counted apart.
    const code = await bundle('index', ['./dom.js']);
    const gz = gzipSync(code).length;
    console.log(`reins core: ${code.length} B min, ${gz} B min+gzip`);
    expect(code).toContain('import("./dom.js")');
    expect(gz).toBeLessThan(5 * 1024);
  });

  it('the DOM inspector, loaded on demand, is under 1 KB min+gzip', async () => {
    const code = await bundle('dom', SHARED);
    const gz = gzipSync(code).length;
    console.log(`reins dom inspector: ${code.length} B min, ${gz} B min+gzip`);
    expect(gz).toBeLessThan(1024);
  });

  it('record entry is under 6 KB min+gzip (core excluded)', async () => {
    const code = await bundle('record', ['@mindmakr/reins', ...SHARED]);
    const gz = gzipSync(code).length;
    console.log(`@mindmakr/reins/record: ${code.length} B min, ${gz} B min+gzip`);
    expect(gz).toBeLessThan(6 * 1024);
  });

  it('core and record carry the dev marker; their stubs do not', async () => {
    expect(await bundle('index')).toContain('__REINS_DEV_ONLY__');
    expect(await bundle('record', ['@mindmakr/reins'])).toContain('__REINS_DEV_ONLY__');
    expect(await bundle('stub')).not.toContain('__REINS_DEV_ONLY__');
    expect(await bundle('record-stub')).not.toContain('__REINS_DEV_ONLY__');
  });

  it('the report module has no Node imports, so the browser can bundle it', async () => {
    const code = await bundle('report');
    expect(code).not.toMatch(/node:|require\(/);
  });
});
