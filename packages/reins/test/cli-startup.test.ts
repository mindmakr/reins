import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ownPackage, scan, walk } from './imports.js';

// The CLI loads each command's modules only when that command runs: a one-shot command (verify, report, exec, …)
// must not load the bridge (hub.ts, and with it ws's server and the tools) or the MCP SDK, which made every call
// take about 260 ms instead of about 75 ms. The walk is the flight safety test's (test/imports.ts): it follows every
// static and literal dynamic import, through the package's own name too, so a load at any depth counts.
const src = fileURLToPath(new URL('../src/', import.meta.url));
const cli = readFileSync(join(src, 'cli.ts'), 'utf8');
const ONE_SHOT = ['verify.ts', 'bridge/report-cli.ts', 'bridge/oneshot-cli.ts', 'bridge/fuzz-cli.ts', 'bridge/map-cli.ts', 'flight/check-cli.ts'];
const BRIDGE = (m: string) => m === 'bridge/hub' || m === 'bridge/mcp' || m.startsWith('@modelcontextprotocol/');

/** What loading `entry` loads: its local modules (relative to src, without extension) and the packages it names. */
function loads(entry: string): string[] {
  const g = walk(join(src, entry), true, ownPackage(src));
  return [...g.files.map((f) => relative(src, f).replace(/\\/g, '/').replace(/\.(ts|js)$/, '')), ...g.bare];
}

describe('cli start-up', () => {
  it('imports nothing of its own at the top: every command module is a dynamic import', () => {
    const top = scan(cli).specs.filter((s) => s.startsWith('.') && !cli.includes(`import('${s}')`));
    expect(top).toEqual([]);
  });

  it('a one-shot command loads neither the bridge nor the MCP SDK, however deep the import', () => {
    for (const entry of ONE_SHOT) {
      expect(cli).toContain(`import('./${entry.replace(/\.ts$/, '.js')}')`);
      expect(loads(entry).filter(BRIDGE), entry).toEqual([]);
    }
  });

  it('the walk finds the bridge where it is loaded, also through the package name', () => {
    expect(loads('bridge/mcp.ts').filter(BRIDGE).length).toBeGreaterThan(0);
    expect(loads('bridge/index.ts')).toContain('bridge/hub');
    expect(ownPackage(src)('@mindmakr/reins/report')).toBe(join(src, 'report.ts'));
    expect(ownPackage(src)('ws')).toBeNull();
  });

  it('loads the MCP SDK before the bridge opens its port', () => {
    expect(cli.indexOf("import('./bridge/mcp.js')")).toBeGreaterThan(-1);
    expect(cli.indexOf("import('./bridge/mcp.js')")).toBeLessThan(cli.indexOf('Hub.start('));
  });
});
