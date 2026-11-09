import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const entry = (name: string) => fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url));

async function bundle(name: string) {
  const out = await build({ entryPoints: [entry(name)], bundle: true, minify: true, format: 'esm', write: false, platform: 'browser' });
  return out.outputFiles[0].text;
}

describe('size', () => {
  it('core is under 5 KB min+gzip', async () => {
    const code = await bundle('index');
    const gz = gzipSync(code).length;
    console.log(`reins core: ${code.length} B min, ${gz} B min+gzip`);
    expect(gz).toBeLessThan(5 * 1024);
  });

  it('core contains the dev marker and the stub does not', async () => {
    expect(await bundle('index')).toContain('__REINS_DEV_ONLY__');
    expect(await bundle('stub')).not.toContain('__REINS_DEV_ONLY__');
  });
});
