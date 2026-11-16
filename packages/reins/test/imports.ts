// What a test module loads, followed through every import: shared by the flight safety test (the production entry
// reaches nothing of development reins) and the CLI start-up test (a one-shot command reaches neither the bridge nor
// the MCP SDK), so the two never read imports differently.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/** Built-ins that load or run code the walk cannot follow. */
export const LOADERS = /^(?:node:)?(?:module|worker_threads|vm|child_process)$/;
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)\s*$/;

/** Blanks comments, keeping strings, template literals and regex literals whole, so a comment marker in one is text. */
export function stripComments(code: string): string {
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
export function scan(code: string): { specs: string[]; bad: string[] } {
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
export function refused(code: string): string[] {
  const { specs, bad } = scan(code);
  return [...bad, ...specs.filter((s) => LOADERS.test(s))];
}

export const specifiers = (code: string): string[] => scan(code).specs;

export function walk(entry: string, ts: boolean, alias: (spec: string) => string | null = () => null) {
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
      const own = s.startsWith('.') ? null : alias(s);
      if (own) {
        bare.add(s);
        todo.push(own);
        continue;
      }
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

/**
 * Resolves this package's own name to its sources, as vitest.config.ts does (`@mindmakr/reins` is src/index.ts,
 * `@mindmakr/reins/<x>` is src/<x>.ts, with the few entries that live elsewhere), so a walk follows a module
 * reached through the package's own entry instead of stopping at it.
 */
export function ownPackage(src: string): (spec: string) => string | null {
  const special: Record<string, string> = { '': 'index.ts', 'next/token-route': 'next-token-route.ts', 'expo/metro': 'metro.ts', bridge: 'bridge/index.ts' };
  return (spec) => {
    const m = /^@mindmakr\/reins(?:\/(.+))?$/.exec(spec);
    if (!m) return null;
    const sub = m[1] ?? '';
    return resolve(src, special[sub] ?? `${sub}.ts`);
  };
}
