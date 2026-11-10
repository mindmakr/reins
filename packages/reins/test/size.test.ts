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

describe('size', () => {
  it('core is under 5 KB min+gzip', async () => {
    const code = await bundle('index');
    const gz = gzipSync(code).length;
    console.log(`reins core: ${code.length} B min, ${gz} B min+gzip`);
    expect(gz).toBeLessThan(5 * 1024);
  });

  it('record entry is under 6 KB min+gzip (core excluded)', async () => {
    const code = await bundle('record', ['reins']);
    const gz = gzipSync(code).length;
    console.log(`reins/record: ${code.length} B min, ${gz} B min+gzip`);
    expect(gz).toBeLessThan(6 * 1024);
  });

  it('core and record carry the dev marker; their stubs do not', async () => {
    expect(await bundle('index')).toContain('__REINS_DEV_ONLY__');
    expect(await bundle('record', ['reins'])).toContain('__REINS_DEV_ONLY__');
    expect(await bundle('stub')).not.toContain('__REINS_DEV_ONLY__');
    expect(await bundle('record-stub')).not.toContain('__REINS_DEV_ONLY__');
  });

  it('the report module has no Node imports, so the browser can bundle it', async () => {
    const code = await bundle('report');
    expect(code).not.toMatch(/node:|require\(/);
  });
});
