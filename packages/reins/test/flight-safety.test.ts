// Design section 7: the flight entry is inert until started, never reaches development reins, and holds no
// eval, no new Function and no __REINS_DEV_ONLY__ marker. The walk runs on the sources always, and on the
// built entry after `npm run build`.
import { execFileSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const CHANNELS = ['undici:request:create', 'undici:request:headers', 'undici:request:error', 'http.client.request.start', 'http.client.response.finish', 'http.client.request.error'];

/** Development-only modules the flight entry must never reach (bridge, pairing, actions, DOM and state reading). */
const FORBIDDEN = /^(bridge\/.*|index|node|record|record-stub|dom|adapters|react|expo|server|stub|webmcp|env|next|next-token-route|vite|metro|cli|verify|verify-cli)$/;

/** Built-ins that load or run code the walk cannot follow. */
const LOADERS = /^(?:node:)?(?:module|worker_threads|vm|child_process)$/;
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)\s*$/;

/** Blanks comments, keeping strings, template literals and regex literals whole, so a comment marker in one is text. */
function stripComments(code: string): string {
  let out = '';
  let prev = '';
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    const d = code[i + 1];
    if (c === '/' && d === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      const e = code.indexOf('*/', i + 2);
      i = e < 0 ? code.length : e + 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`' || (c === '/' && (!prev || REGEX_BEFORE.test(prev) || REGEX_AFTER_WORD.test(out)))) {
      let j = i + 1;
      let cls = false;
      for (; j < code.length; j++) {
        const x = code[j];
        if (x === '\\') j++;
        else if (c === '/' && x === '[') cls = true;
        else if (c === '/' && x === ']') cls = false;
        else if ((x === c && !cls) || (x === '\n' && c !== '`')) break;
      }
      out += code.slice(i, j + 1);
      i = j + 1;
      prev = c;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/**
 * What a module loads at run time: static imports and re-exports (not type-only ones), with or without
 * whitespace, and dynamic imports of a literal. `bad` lists what the walk cannot follow and so refuses:
 * an `import(` of anything but a string literal, any `require(`, `createRequire`, `getBuiltinModule` and
 * `new Worker(`. `import type from '...'` is a default import named `type`, and is followed.
 */
function scan(code: string): { specs: string[]; bad: string[] } {
  const src = stripComments(code);
  const specs: string[] = [];
  const bad: string[] = [];
  const re = /\b(?:import|export)\s*(type\b(?!\s*from\s*['"])\s*)?(?:[\w*{}\s,$]+?\s*\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) continue;
    specs.push(m[2] || m[3]);
  }
  for (const m of src.matchAll(/\bimport\s*\((?!\s*['"][^'"]+['"]\s*\))/g)) bad.push(src.slice(m.index!, m.index! + 40));
  for (const m of src.matchAll(/\brequire\s*\(|\bcreateRequire\b|\bgetBuiltinModule\b|\bnew\s+Worker\s*\(/g)) bad.push(src.slice(m.index!, m.index! + 40));
  return { specs, bad };
}

/** Everything the walk refuses in one file: what `scan` cannot follow, and the built-ins that load code. */
function refused(code: string): string[] {
  const { specs, bad } = scan(code);
  return [...bad, ...specs.filter((s) => LOADERS.test(s))];
}

const specifiers = (code: string): string[] => scan(code).specs;

function walk(entry: string, ts: boolean) {
  const root = dirname(entry);
  const files = new Set<string>();
  const bare = new Set<string>();
  const bad: string[] = [];
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const code = readFileSync(file, 'utf8');
    const found = scan(code);
    bad.push(...refused(code).map((b) => `${relative(root, file)}: ${b}`));
    for (const s of found.specs) {
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
  return { files: [...files], names, bare: [...bare], bad };
}

function expectSafe(entry: string, ts: boolean) {
  const g = walk(entry, ts);
  expect(g.names).toContain('recorder');
  // A load the walk cannot follow could reach anything.
  expect(g.bad).toEqual([]);
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

  it('follows imports without whitespace and refuses loads it cannot follow', () => {
    expect(specifiers(`import{a}from"./node.js";export*from'./bridge/hub.js';import"./side.js";import d,{e}from'./index.js'`)).toEqual([
      './node.js',
      './bridge/hub.js',
      './side.js',
      './index.js',
    ]);
    expect(specifiers(`import type{A}from'./types.js';import typeset from './typeset.js'`)).toEqual(['./typeset.js']);
    expect(scan(`const m = await import('./ok.js'); const n = await import( "./ok2.js" )`)).toEqual({ specs: ['./ok.js', './ok2.js'], bad: [] });
    expect(scan(`const name = './node.js'; await import(name)`).bad).toHaveLength(1);
    expect(scan('await import(`./${x}.js`)').bad).toHaveLength(1);
    expect(scan(`const ws = require('ws')`).bad).toHaveLength(1);
    expect(scan(`const r = require ('ws')`).bad).toHaveLength(1);
    expect(scan(`import { createRequire } from 'node:module'; const r = createRequire(import.meta.url);`).bad).toHaveLength(2);
    expect(scan(`// require('ws') in a comment\nconst meta = import.meta.url;`).bad).toEqual([]);
    // Comment markers inside strings and regex literals are text, not comments.
    expect(specifiers(`const a = "/*"; import {a} from './node.js'; const b = "*/";`)).toEqual(['./node.js']);
    expect(specifiers(`const s = "a//b"; import x from './node.js';`)).toEqual(['./node.js']);
    expect(specifiers(`const r = /\\/\\//; import x from './node.js';`)).toEqual(['./node.js']);
    expect(specifiers('const t = `//`; export * from "./bridge/hub.js";')).toEqual(['./bridge/hub.js']);
    expect(specifiers(`/* a */ import x from './a.js'; // b\nimport y from './b.js'`)).toEqual(['./a.js', './b.js']);
    // A default import named `type` is a real import.
    expect(specifiers(`import type from './node.js'`)).toEqual(['./node.js']);
    expect(specifiers(`import type from"./node.js"`)).toEqual(['./node.js']);
    // Loaders the walk cannot follow.
    expect(refused(`const w = new Worker(new URL('./node.js', import.meta.url));`)).toHaveLength(1);
    expect(refused(`const m = process.getBuiltinModule('node:module');`)).toHaveLength(1);
    for (const s of ['module', 'worker_threads', 'vm', 'child_process']) {
      expect(refused(`import x from 'node:${s}';`), s).toHaveLength(1);
      expect(refused(`import x from '${s}';`), s).toHaveLength(1);
      expect(refused(`const x = await import("node:${s}");`), s).toHaveLength(1);
    }
    expect(refused(`import { readFileSync } from 'node:fs'; import m from './module.js';`)).toEqual([]);
  });

  it('never reaches development reins from the source entry', () => {
    expectSafe(join(pkg, 'src', 'flight.ts'), true);
  });

  const built = join(pkg, 'dist', 'flight.js');
  it.skipIf(!existsSync(built))('never reaches development reins from the built entry (after npm run build)', () => {
    expectSafe(built, false);
  });

  /**
   * Imports a module in a fresh process and says whether it added a global or left a resource (timer, handle,
   * socket, file request) open. Node 18 and 20 close each module file the loader read after import() resolves
   * (a `CloseReq` that any module, even an empty one, leaves for one turn), so both sides are measured once the
   * loader's own I/O has settled. A one-shot `Immediate` would run during that settle, so it is checked right
   * after the import resolves, before the settle. Listeners added to `process` are counted too.
   */
  function freshImport(file: string, report: string): Record<string, unknown> {
    const script = [
      `const settle = () => new Promise((r) => setImmediate(r));`,
      `const listeners = () => process.eventNames().reduce((n, e) => n + process.listenerCount(e), 0);`,
      `await settle();`,
      `const before = Reflect.ownKeys(globalThis).length;`,
      `const res = process.getActiveResourcesInfo().join();`,
      `const lis = listeners();`,
      `const m = await import(${JSON.stringify(new URL(`file:///${file.replace(/\\/g, '/')}`).href)});`,
      `const after = Reflect.ownKeys(globalThis).length;`,
      `const immediate = process.getActiveResourcesInfo().includes('Immediate');`,
      `await settle();`,
      `const left = process.getActiveResourcesInfo().join();`,
      `const out = JSON.stringify({ globals: after - before, resources: left === res, immediate, listeners: listeners() - lis, ${report} });`,
      `process.stdout.write(out, () => process.exit(0));`,
    ].join('\n');
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } }));
  }

  it('has a fresh-process measure that sees a timer, handle, immediate, listener or global left by an import', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reins-flight-safety-'));
    try {
      const timer = join(dir, 'timer.mjs');
      writeFileSync(timer, 'setTimeout(() => {}, 100);\nexport const x = 1;\n');
      expect(freshImport(timer, 'x: m.x')).toEqual({ globals: 0, resources: false, immediate: false, listeners: 0, x: 1 });
      const global = join(dir, 'global.mjs');
      writeFileSync(global, 'globalThis.__reinsSafetyProbe = 1;\nexport const x = 1;\n');
      expect(freshImport(global, 'x: m.x')).toEqual({ globals: 1, resources: true, immediate: false, listeners: 0, x: 1 });
      const empty = join(dir, 'empty.mjs');
      writeFileSync(empty, 'export const x = 1;\n');
      expect(freshImport(empty, 'x: m.x')).toEqual({ globals: 0, resources: true, immediate: false, listeners: 0, x: 1 });
      const handle = join(dir, 'handle.mjs');
      writeFileSync(handle, "import net from 'node:net';\nnet.createServer().listen(0);\nexport const x = 1;\n");
      expect(freshImport(handle, 'x: m.x')).toEqual({ globals: 0, resources: false, immediate: false, listeners: 0, x: 1 });
      const immediate = join(dir, 'immediate.mjs');
      writeFileSync(immediate, 'setImmediate(() => {});\nexport const x = 1;\n');
      expect(freshImport(immediate, 'x: m.x')).toMatchObject({ immediate: true, x: 1 });
      const listener = join(dir, 'listener.mjs');
      writeFileSync(listener, "process.on('reins-safety-probe', () => {});\nexport const x = 1;\n");
      expect(freshImport(listener, 'x: m.x')).toEqual({ globals: 0, resources: true, immediate: false, listeners: 1, x: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(built))('loads the built entry in a fresh process without loading development reins', () => {
    expect(freshImport(built, 'dev: m.flight.devInstruments(), started: m.flight.isStarted()')).toEqual({
      globals: 0,
      resources: true,
      immediate: false,
      listeners: 0,
      dev: { production: true, devModuleLoaded: false, devRecording: false },
      started: false,
    });
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
