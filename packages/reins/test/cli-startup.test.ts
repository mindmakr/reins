import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The CLI loads each command's modules only when that command runs: a one-shot command (verify, report, exec, …)
// must not load the bridge (hub.ts, and with it ws's server and the tools) or the MCP SDK, which made every call
// take about 260 ms instead of about 75 ms. The walk follows every static import, so a load one level down counts.
const src = fileURLToPath(new URL('../src/', import.meta.url));
const cli = readFileSync(join(src, 'cli.ts'), 'utf8');

/** The modules `file` loads at once: its static imports and re-exports, type-only ones left out. */
function staticImports(file: string): string[] {
  const code = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?[^'";]*?\sfrom\s+['"]([^'"]+)['"]/gm)) if (!m[2]) out.push(m[3]);
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}
const resolveLocal = (from: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return null;
  const f = join(dirname(from), spec.replace(/\.js$/, '.ts'));
  return existsSync(f) ? f : null;
};

/** Every module, local file or package, that loading `entry` loads. */
function loads(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    for (const spec of staticImports(f)) {
      const local = resolveLocal(f, spec);
      const key = local ? relative(src, local).split('\\').join('/') : spec;
      if (seen.has(key)) continue;
      seen.add(key);
      if (local) todo.push(local);
    }
  }
  return seen;
}

describe('cli start-up', () => {
  it('imports nothing of its own at the top but types', () => {
    const own = cli.split('\n').filter((l) => /^import\s/.test(l) && /from '\.\//.test(l) && !/^import type\s/.test(l));
    expect(own).toEqual([]);
  });

  it('a one-shot command loads neither the bridge nor the MCP SDK, however deep the import', () => {
    for (const entry of ['verify.ts', 'bridge/report-cli.ts', 'bridge/oneshot-cli.ts', 'bridge/fuzz-cli.ts', 'bridge/map-cli.ts', 'flight/check-cli.ts']) {
      expect(cli).toContain(`import('./${entry.replace(/\.ts$/, '.js')}')`);
      const all = [...loads(join(src, entry))];
      expect(all.filter((m) => m === 'bridge/hub.ts' || m === 'bridge/mcp.ts' || m.startsWith('@modelcontextprotocol/')), entry).toEqual([]);
    }
  });

  it('the walk sees the bridge where it is loaded', () => {
    expect([...loads(join(src, 'bridge/mcp.ts'))].some((m) => m.startsWith('@modelcontextprotocol/'))).toBe(true);
  });

  it('loads the MCP SDK before the bridge opens its port', () => {
    expect(cli.indexOf("import('./bridge/mcp.js')")).toBeGreaterThan(-1);
    expect(cli.indexOf("import('./bridge/mcp.js')")).toBeLessThan(cli.indexOf('Hub.start('));
  });
});
