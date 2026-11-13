// Design section 7: the flight entry is inert until started, never reaches development reins, and holds no
// eval, no new Function and no __REINS_DEV_ONLY__ marker. The walk runs on the sources always, and on the
// built entry after `npm run build`.
import { execFileSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const CHANNELS = ['undici:request:create', 'undici:request:headers', 'undici:request:error', 'http.client.request.start', 'http.client.response.finish', 'http.client.request.error'];

/** Development-only modules the flight entry must never reach (bridge, pairing, actions, DOM and state reading). */
const FORBIDDEN = /^(bridge\/.*|index|node|record|record-stub|dom|adapters|react|expo|server|stub|webmcp|env|next|next-token-route|vite|metro|cli|verify|verify-cli)$/;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Specifiers a module loads at run time: static imports and re-exports (not type-only ones) and dynamic imports. */
function specifiers(code: string): string[] {
  const src = stripComments(code);
  const out: string[] = [];
  const re = /\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) continue;
    out.push(m[2] || m[3]);
  }
  return out;
}

function walk(entry: string, ts: boolean) {
  const root = dirname(entry);
  const files = new Set<string>();
  const bare = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const s of specifiers(readFileSync(file, 'utf8'))) {
      if (!s.startsWith('.')) {
        bare.add(s);
        continue;
      }
      let next = resolve(dirname(file), s);
      if (ts) next = next.replace(/\.js$/, '.ts');
      todo.push(next);
    }
  }
  const names = [...files].map((f) => relative(root, f).replace(/\\/g, '/').replace(/\.(ts|js)$/, ''));
  return { files: [...files], names, bare: [...bare] };
}

function expectSafe(entry: string, ts: boolean) {
  const g = walk(entry, ts);
  expect(g.names).toContain('recorder');
  expect(g.names.filter((n) => FORBIDDEN.test(n))).toEqual([]);
  // Only Node built-ins: no ws, no MCP SDK, no other package.
  expect(g.bare.filter((b) => !b.startsWith('node:'))).toEqual([]);
  for (const f of g.files) {
    const code = stripComments(readFileSync(f, 'utf8'));
    expect(code, f).not.toMatch(/\beval\s*\(/);
    expect(code, f).not.toMatch(/\bnew\s+Function\b|\bFunction\s*\(/);
    expect(readFileSync(f, 'utf8'), f).not.toContain('__REINS_DEV_ONLY__');
  }
  return g;
}

describe('@mindmakr/reins/flight safety (design section 7)', () => {
  it('starts no timer, listener, patch or global on import, and subscribes only once started', async () => {
    const globalsBefore = Reflect.ownKeys(globalThis);
    const fetchBefore = globalThis.fetch;
    const resourcesBefore = process.getActiveResourcesInfo().length;
    const listenersBefore = process.eventNames().map((e) => process.listenerCount(e as string));

    const mod = await import('../src/flight.js');

    expect(Reflect.ownKeys(globalThis)).toEqual(globalsBefore);
    expect(globalThis.fetch).toBe(fetchBefore);
    // The test runner's own handles come and go, so check that nothing was added.
    expect(process.getActiveResourcesInfo().length).toBeLessThanOrEqual(resourcesBefore);
    expect(process.eventNames().map((e) => process.listenerCount(e as string))).toEqual(listenersBefore);
    for (const c of CHANNELS) expect(channel(c).hasSubscribers, c).toBe(false);
    expect(mod.flight.isStarted()).toBe(false);
    expect(mod.flight.recorder()).toBeNull();

    const f = mod.createFlight({ NODE_ENV: 'production' });
    // The development module has not been loaded in this file yet.
    expect(f.devInstruments()).toEqual({ production: true, devModuleLoaded: false, devRecording: false });
    expect(f.start()).toBe(true);
    for (const c of CHANNELS) expect(channel(c).hasSubscribers, c).toBe(true);
    f.stop();
    for (const c of CHANNELS) expect(channel(c).hasSubscribers, c).toBe(false);
  });

  it('has a walker that sees what it must refuse', () => {
    const dev = walk(join(pkg, 'src', 'node.ts'), true);
    expect(dev.bare).toContain('ws');
    const core = walk(join(pkg, 'src', 'index.ts'), true);
    expect(core.names).toContain('index');
    expect(readFileSync(join(pkg, 'src', 'index.ts'), 'utf8')).toContain('__REINS_DEV_ONLY__');
    expect(specifiers(`import type { A } from './types.js';\nexport { b } from './b.js';\nconst x = await import('ws');`)).toEqual(['./b.js', 'ws']);
  });

  it('never reaches development reins from the source entry', () => {
    expectSafe(join(pkg, 'src', 'flight.ts'), true);
  });

  const built = join(pkg, 'dist', 'flight.js');
  it.skipIf(!existsSync(built))('never reaches development reins from the built entry (after npm run build)', () => {
    expectSafe(built, false);
  });

  it.skipIf(!existsSync(built))('loads the built entry in a fresh process without loading development reins', () => {
    const script = [
      `const before = Reflect.ownKeys(globalThis).length;`,
      `const res = process.getActiveResourcesInfo().join();`,
      `const m = await import(${JSON.stringify(new URL(`file:///${built.replace(/\\/g, '/')}`).href)});`,
      `const after = Reflect.ownKeys(globalThis).length;`,
      `console.log(JSON.stringify({ globals: after - before, resources: process.getActiveResourcesInfo().join() === res, dev: m.flight.devInstruments(), started: m.flight.isStarted() }));`,
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } });
    expect(JSON.parse(out)).toEqual({ globals: 0, resources: true, dev: { production: true, devModuleLoaded: false, devRecording: false }, started: false });
  });

  it('states when the development module is loaded in a production process, and when it records', async () => {
    const { createFlight } = await import('../src/flight.js');
    const { createReinsNode } = await import('../src/node.js');
    const f = createFlight({ NODE_ENV: 'production' });
    expect(f.devInstruments()).toEqual({ production: true, devModuleLoaded: true, devRecording: false });
    const rn = createReinsNode({ NODE_ENV: 'development' });
    await rn.connect({ standalone: true, reconnect: false, tokenFile: 'no-such-token-file' });
    try {
      expect(f.devInstruments().devRecording).toBe(true);
    } finally {
      rn.disconnect();
    }
    expect(f.devInstruments().devRecording).toBe(false);
  });

  it('keeps the dev marker where it is and out of the shared recorder', () => {
    expect(readFileSync(join(pkg, 'src', 'index.ts'), 'utf8')).toContain('__REINS_DEV_ONLY__');
    expect(readFileSync(join(pkg, 'src', 'record.ts'), 'utf8')).toContain('__REINS_DEV_ONLY__');
    expect(readFileSync(join(pkg, 'src', 'node.ts'), 'utf8')).not.toContain('__REINS_DEV_ONLY__');
  });
});
