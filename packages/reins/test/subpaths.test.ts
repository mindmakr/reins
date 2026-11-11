import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reactQuery, redux, routerLocation, zustand } from 'reins/adapters';
import { Hub, parseArgs, TOOLS } from 'reins/bridge';
import { shouldStub as metroShouldStub, withReins as withReinsMetro } from 'reins/metro';
import { shouldStub as expoMetroShouldStub, withReins as withReinsExpoMetro } from 'reins/expo/metro';
import { shouldStub as nextShouldStub, withReins as withReinsNext } from 'reins/next';
import { GET as nextTokenGET } from 'reins/next/token-route';
import { ReinsPanel, useReinsAction, useReinsState } from 'reins/react';
import { findMarker, listFiles, main as verifyMain, MARKER } from 'reins/verify';
import reinsVite, { reinsPlugin } from 'reins/vite';

const dirs: string[] = [];
function tempDir(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reins-subpaths-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('reins single-package subpath exports', () => {
  it('exports reins/react hooks and ReinsPanel', () => {
    expect(typeof useReinsAction).toBe('function');
    expect(typeof useReinsState).toBe('function');
    // ReinsPanel uses a hook, so it must be rendered by React rather than called as a function.
    const html = renderToStaticMarkup(createElement(ReinsPanel, { id: 'checkout', className: 'box' }, 'hi'));
    expect(html).toBe('<div class="box" data-reins="checkout">hi</div>');
  });

  it('keeps every VERSION constant in step with package.json', async () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    const versions = await Promise.all([import('reins'), import('reins/stub'), import('reins/node'), import('reins/bridge')].map(async (m) => (await m).VERSION));
    expect(versions).toEqual([pkg.version, pkg.version, pkg.version, pkg.version]);
  });

  it('exports reins/adapters for zustand, redux, reactQuery, and routerLocation', () => {
    const store = { getState: () => ({ count: 42 }) };
    expect(zustand(store)()).toEqual({ count: 42 });
    expect(redux(store)()).toEqual({ count: 42 });
    const qc = {
      getQueryCache: () => ({
        getAll: () => [{ queryKey: ['user'], state: { status: 'success', fetchStatus: 'idle', dataUpdatedAt: 100, data: { id: 1 } } }],
      }),
    };
    expect(reactQuery(qc)()).toEqual([{ key: ['user'], status: 'success', fetchStatus: 'idle', updatedAt: 100, error: undefined, data: { id: 1 } }]);
    expect(routerLocation(() => '/cart')()).toBe('/cart');
  });

  it('exports reins/vite plugin', async () => {
    expect(reinsVite).toBe(reinsPlugin);
    const plugin = reinsPlugin();
    plugin.configResolved({ root: '.', command: 'build', mode: 'production' });
    const resolve = vi.fn(async (id: string) => ({ id: `/abs/${id}` }));
    expect(await plugin.resolveId.call({ resolve }, 'reins', '/app/main.ts')).toEqual({ id: '/abs/reins/stub' });
  });

  it('exports reins/next and reins/next/token-route', async () => {
    expect(nextShouldStub(false, {}, {})).toBe(true);
    const cfg = withReinsNext({});
    const out = cfg.webpack({ resolve: { alias: {} } }, { dev: false });
    expect(out.resolve.alias).toEqual({ reins$: 'reins/stub', 'reins/record$': 'reins/record-stub' });

    vi.stubEnv('NODE_ENV', 'production');
    const res = await nextTokenGET(new Request('http://localhost:3000/api/reins-token'));
    expect(res.status).toBe(404);
  });

  it('exports reins/metro and reins/expo/metro', () => {
    expect(withReinsMetro).toBe(withReinsExpoMetro);
    expect(metroShouldStub).toBe(expoMetroShouldStub);
    vi.stubEnv('NODE_ENV', 'production');
    const resolveRequest = vi.fn((_c, name) => name);
    expect(withReinsMetro({}).resolver.resolveRequest({ resolveRequest }, 'reins', 'ios')).toBe('reins/stub');
  });

  it('exports reins/verify and reins/bridge', () => {
    const dir = tempDir({ 'bundle.js': `const m = "${MARKER}";` });
    expect(listFiles(dir).length).toBe(1);
    expect(findMarker(dir)).toEqual(['bundle.js']);
    expect(verifyMain([dir], () => {}, () => {})).toBe(1);

    expect(typeof Hub.start).toBe('function');
    expect(TOOLS.map((t) => t.name)).toContain('reins_list_actions');
    expect(parseArgs(['bridge', '--port', '7357'], '/app').command).toBe('bridge');
  });

  const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const verifyCliPath = fileURLToPath(new URL('../dist/verify-cli.js', import.meta.url));
  it.skipIf(!existsSync(cliPath) || !existsSync(verifyCliPath))('runs reins verify and reins-verify-bundle CLI binaries from packages/reins', () => {
    const clean = tempDir({ 'app.js': 'console.log("ok")' });
    const dirty = tempDir({ 'app.js': MARKER });
    const run = (bin: string, args: string[]) => {
      try {
        execFileSync(process.execPath, [bin, ...args], { stdio: 'pipe' });
        return 0;
      } catch (e: any) {
        return e.status as number;
      }
    };
    expect(run(cliPath, ['verify', clean])).toBe(0);
    expect(run(cliPath, ['verify', dirty])).toBe(1);
    expect(run(verifyCliPath, [clean])).toBe(0);
    expect(run(verifyCliPath, [dirty])).toBe(1);
  });
});
