import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The CLI loads each command's modules only when that command runs: a one-shot command (verify, report, exec, …)
// must not pay for the MCP SDK and the bridge, which made every call take about 260 ms instead of about 75 ms.
describe('cli start-up', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8');

  it('imports nothing of its own at the top but types', () => {
    const top = src.split('\n').filter((l) => /^import\s/.test(l));
    const own = top.filter((l) => /from '\.\//.test(l) && !/^import type\s/.test(l));
    expect(own).toEqual([]);
  });

  it('loads every command module on demand', () => {
    for (const m of ['./verify.js', './bridge/report-cli.js', './bridge/oneshot-cli.js', './bridge/fuzz-cli.js', './bridge/map-cli.js', './flight/check-cli.js', './bridge/hub.js']) {
      expect(src).toContain(`import('${m}')`);
    }
  });

  it('loads the MCP SDK before the bridge opens its port', () => {
    expect(src.indexOf("import('./bridge/mcp.js')")).toBeGreaterThan(-1);
    expect(src.indexOf("import('./bridge/mcp.js')")).toBeLessThan(src.indexOf('Hub.start('));
  });
});
