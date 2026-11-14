// Design sections 6 and 11, unit u7: the bridge's read-only `reins_flight` tool. It reads a saved report file or
// the file store under the project, loads no app code, reaches no Postgres store, writes nothing, refuses every
// path outside the project, caps what it reads, and leaves process keys out unless the call asks for them.
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry } from '../src/bridge/audit.js';
import { FLIGHT_TOOL_LIMITS, flightTool } from '../src/bridge/flight.js';
import { callTool, TOOLS } from '../src/bridge/tools.js';
import { createFlight, type Flight } from '../src/flight.js';
import { fileStore } from '../src/flight/file-store.js';
import { MIN } from './flight-fixtures.js';
import { step } from './flight-store-contract.js';

const H = 60 * MIN;
const cleanup: Array<() => unknown> = [];
const flights: Flight[] = [];
afterEach(() => {
  for (const f of flights.splice(0)) f.stop();
  for (const f of cleanup.splice(0).reverse()) f();
});

function tempDir(prefix = 'reins-bridge-flight-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const manifest = {
  schema: 1,
  service: 'payday',
  processes: [
    {
      name: 'payout',
      key: 'the payout id',
      steps: ['requested', 'bank.sent', 'bank.pending', 'bank.settled', 'bank.failed', 'ledger.debited'],
      ends: ['ledger.debited', 'bank.failed'],
      promises: [{ id: 'pending-settles', kind: 'within', after: 'bank.pending', expect: ['bank.settled', 'bank.failed'], within: '4h', why: 'A stuck transfer is money owed.' }],
    },
  ],
};

/** Whether the lock folder holds exactly one generation, 2.json, written in full as given up: {owner, until: 0}. */
function lockReleased(lockDir: string): boolean {
  try {
    if (readdirSync(lockDir).join() !== '2.json') return false;
    const lock = JSON.parse(readFileSync(join(lockDir, '2.json'), 'utf8'));
    return typeof lock.owner === 'string' && lock.owner !== '' && lock.until === 0;
  } catch {
    return false;
  }
}

/** A project with a manifest and a file store under .reins/flight holding one overdue payout, checked once. */
async function project() {
  const dir = tempDir();
  writeFileSync(join(dir, 'reins.flight.json'), JSON.stringify(manifest));
  const store = fileStore({ dir: join(dir, '.reins', 'flight') });
  const now = Date.now();
  await store.addSteps([step('payout-7f3a', 'requested', now - 10 * H), step('payout-7f3a', 'bank.sent', now - 10 * H + MIN), step('payout-7f3a', 'bank.pending', now - 9 * H)]);
  const f = createFlight({});
  flights.push(f);
  expect(f.start({ store, manifest, checkEveryMs: 0, flushMs: 60_000, instance: 'srv', notify: { daily: false } })).toBe(true);
  await f.checkNow();
  const report = (await f.report())!;
  f.stop();
  // stop() flushes and gives the lock up in the background: dropLock writes 2.json, then unlinks 1.json. Wait for
  // both (the folder holds only 2.json, written in full as a free lock), so later changes are not the tool's.
  const lockDir = join(dir, '.reins', 'flight', 'lock');
  for (let i = 0; i < 500 && !lockReleased(lockDir); i++) await new Promise((r) => setTimeout(r, 10));
  expect(lockReleased(lockDir)).toBe(true);
  expect(report.findings.some((x) => x.keys?.includes('payout-7f3a'))).toBe(true);
  return { dir, report };
}

/** Every file under a folder with its size and time, to show a call wrote nothing. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out.push(`${p} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

const hasKeys = (v: unknown) => JSON.stringify(v).includes('payout-7f3a');

describe('B1: reins_flight is listed and read only', () => {
  it('is one new tool with a read-only description and an object input schema', () => {
    const tools = TOOLS.filter((t) => t.name === 'reins_flight');
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toMatch(/^Read only/);
    expect(tools[0].description).toMatch(/Loads no app code and never reaches a Postgres store/);
    expect(tools[0].inputSchema).toMatchObject({ type: 'object', required: [] });
    expect(Object.keys((tools[0].inputSchema as any).properties)).toEqual(['file', 'store', 'manifest', 'keys']);
  });

  it('reaches no app config loader, no Postgres store and no dynamic import (static walk of its imports)', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/\bimport\s*\(|\brequire\s*\(|createRequire|new Function|\beval\s*\(/);
      for (const m of code.matchAll(/^(?:import|export)\s+(?!type\b)[^'"]*?from\s*['"](\.[^'"]+)['"]/gm)) walk(resolve(dirname(file), m[1].replace(/\.js$/, '.ts')));
    };
    walk(join(src, 'bridge', 'flight.ts'));
    const names = [...seen].map((f) => f.slice(src.length).split('\\').join('/'));
    expect(names).toContain('flight/file-store.ts');
    for (const bad of ['flight/pg-store.ts', 'flight/report-cli.ts', 'flight/check-cli.ts', 'flight.ts', 'node.ts', 'index.ts']) expect(names).not.toContain(bad);
  });
});

describe('B1: a saved report file', () => {
  it('returns the Markdown and the data without process keys, and with them only when asked', async () => {
    const { dir, report } = await project();
    mkdirSync(join(dir, 'reports'));
    writeFileSync(join(dir, 'reports', 'before.json'), JSON.stringify(report));
    const audit: AuditEntry[] = [];
    const r: any = await callTool({ hub: undefined as any, dir, audit: (e) => audit.push(e) }, 'reins_flight', { file: 'reports/before.json' });
    expect(r).toMatchObject({ source: 'file', path: 'reports/before.json', keys: false });
    expect(r.markdown).toMatch(/payout/);
    expect(r.report.findings.length).toBe(report.findings.length);
    expect(hasKeys(r)).toBe(false);
    expect(audit).toEqual([expect.objectContaining({ event: 'reins_flight', name: 'reports/before.json', ok: true })]);
    const withKeys: any = await callTool({ hub: undefined as any, dir }, 'reins_flight', { file: 'reports/before.json', keys: true });
    expect(withKeys.keys).toBe(true);
    expect(hasKeys(withKeys.report)).toBe(true);
    expect(hasKeys(withKeys.markdown)).toBe(false);
  });

  it('says plainly when the file is not a flight report, or is missing', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'x.json'), '{"a":1}');
    await expect(flightTool(dir, { file: 'x.json' })).rejects.toThrow(/x\.json is not a flight report/);
    await expect(flightTool(dir, { file: 'nope.json' })).rejects.toThrow(/report file nope\.json not found/);
    await expect(flightTool(dir, { file: 'x.json', store: '.reins/flight' })).rejects.toThrow(/not both/);
    mkdirSync(join(dir, 'folder.json'));
    await expect(flightTool(dir, { file: 'folder.json' })).rejects.toThrow(/report file is not a file/);
    await expect(flightTool(dir, { store: 'x.json' })).rejects.toThrow(/store is not a folder/);
  });
});

describe('B1: the file store under the project', () => {
  it('reads .reins/flight with reins.flight.json by default, writes nothing and leaves keys out', async () => {
    const { dir } = await project();
    const before = snapshot(dir);
    const r: any = await callTool({ hub: undefined as any, dir }, 'reins_flight', {});
    expect(r).toMatchObject({ source: 'store', path: '.reins/flight', keys: false });
    expect(r.report.service).toBe('payday');
    expect(r.report.manifest).toBe('ok');
    expect(r.report.findings.some((f: any) => f.key === 'promise:payout:pending-settles')).toBe(true);
    expect(r.report.processes.find((p: any) => p.name === 'payout')).toMatchObject({ declared: true, started: 1 });
    expect(hasKeys(r)).toBe(false);
    expect(hasKeys((await flightTool(dir, { keys: true })).report)).toBe(true);
    expect(snapshot(dir)).toEqual(before);
  });

  it('takes a store folder and a manifest named inside the project', async () => {
    const { dir } = await project();
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'flight.json'), JSON.stringify({ ...manifest, service: 'other' }));
    const r = await flightTool(dir, { store: '.reins/flight', manifest: 'config/flight.json' });
    expect(r.report.service).toBe('other');
  });

  it('says plainly when there is no store and no file', async () => {
    await expect(flightTool(tempDir(), {})).rejects.toThrow(/no file store at \.reins\/flight and no file given/);
  });

  it('never loads the app config module, even when one sits in the project', async () => {
    const { dir } = await project();
    const marker = join(dir, 'loaded.txt');
    const config = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\nexport default {};\n`;
    for (const name of ['flight.config.mjs', 'flight.config.js', 'reins.flight.config.mjs']) writeFileSync(join(dir, name), config);
    await flightTool(dir, {});
    await flightTool(dir, { store: '.reins/flight' });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('B1 and B6: paths outside the project are refused', () => {
  const refused = /reins_flight refused the (report file|store|manifest) path/;

  it('refuses .., absolute paths elsewhere, NUL bytes, UNC and device paths, drive-relative paths and streams', async () => {
    const { dir, report } = await project();
    const outside = tempDir('reins-bridge-flight-outside-');
    writeFileSync(join(outside, 'r.json'), JSON.stringify(report));
    const rel = join('..', outside.slice(dirname(outside).length + 1), 'r.json');
    const thisPackage = fileURLToPath(new URL('../package.json', import.meta.url)); // another folder, on Windows here another drive
    const cases: Array<[string, Record<string, unknown>]> = [
      ['..', { file: rel }],
      ['.. inside then out', { file: 'reports/../../r.json' }],
      ['.. that stays inside', { file: 'reports/../reins.flight.json' }],
      ['absolute elsewhere', { file: join(outside, 'r.json') }],
      ['absolute, another folder or drive', { file: thisPackage }],
      ['missing absolute elsewhere', { file: join(outside, 'missing.json') }],
      ['root-relative', { file: '/etc/passwd' }],
      ['NUL byte', { file: 'reins.flight.json\0.png' }],
      ['UNC', { file: '\\\\server\\share\\r.json' }],
      ['UNC forward', { file: '//server/share/r.json' }],
      ['device', { file: '\\\\?\\C:\\Windows\\win.ini' }],
      ['drive-relative', { file: 'C:r.json' }],
      ['stream', { file: 'reins.flight.json:hidden' }],
      ...['CON', 'NUL', 'COM1', 'LPT1', 'con.json', 'nul.json', 'Com1.txt', 'lpt1.json', 'AUX', 'prn.json', 'CONIN$', 'reports/nul.json', 'nul .json', 'NUL.'].map(
        (name): [string, Record<string, unknown>] => [`device ${name}`, { file: name }],
      ),
      ['device store', { store: 'NUL' }],
      ['device manifest', { manifest: 'com1.json' }],
      ['empty', { file: '' }],
      ['not a string', { file: 42 }],
      ['too long', { file: 'a/'.repeat(600) + 'r.json' }],
      ['store ..', { store: rel.slice(0, -'r.json'.length - 1) }],
      ['store absolute elsewhere', { store: outside }],
      ['manifest ..', { manifest: rel }],
      ['manifest absolute elsewhere', { manifest: join(outside, 'r.json') }],
    ];
    for (const [label, args] of cases) {
      const err = await flightTool(dir, args).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message, label).toMatch(refused);
      expect(err?.message, label).not.toContain(outside);
    }
    // Through callTool too: refused, audited as failed.
    const audit: AuditEntry[] = [];
    await expect(callTool({ hub: undefined as any, dir, audit: (e) => audit.push(e) }, 'reins_flight', { file: rel })).rejects.toThrow(refused);
    expect(audit).toEqual([expect.objectContaining({ event: 'reins_flight', ok: false })]);
  });

  it('refuses a link or junction that leads out of the project, for a file, a store and inside a store', async (ctx) => {
    const { dir, report } = await project();
    const outside = tempDir('reins-bridge-flight-outside-');
    writeFileSync(join(outside, 'r.json'), JSON.stringify(report));
    try {
      symlinkSync(outside, join(dir, 'out'), 'junction');
    } catch {
      ctx.skip();
    }
    await expect(flightTool(dir, { file: 'out/r.json' })).rejects.toThrow(/refused the report file path: it is outside the project \(after resolving links\)/);
    await expect(flightTool(dir, { store: 'out' })).rejects.toThrow(/refused the store path: it is outside the project/);
    await expect(flightTool(dir, { manifest: 'out/r.json' })).rejects.toThrow(/refused the manifest path: it is outside/);
    // A link inside the store folder would let the store read outside the project.
    symlinkSync(outside, join(dir, '.reins', 'flight', 'minutes', 'evil'), 'junction');
    await expect(flightTool(dir, {})).rejects.toThrow(/refused the store path: it holds a link \(minutes\/evil\)/);
    rmSync(join(dir, '.reins', 'flight', 'minutes', 'evil'), { recursive: false, force: true });
    // The whole .reins folder as a link out of the project.
    mkdirSync(join(outside, 'flight'));
    const other = tempDir('reins-bridge-flight-other-');
    symlinkSync(outside, join(other, '.reins'), 'junction');
    await expect(flightTool(other, {})).rejects.toThrow(/refused the store path: it is outside the project/);
  });
});

describe('B1 and B6: a hard link to a file elsewhere is refused', () => {
  it('refuses a report file, a manifest or a store file with more than one hard link', async (ctx) => {
    const { dir, report } = await project();
    const outside = tempDir('reins-bridge-flight-outside-');
    writeFileSync(join(outside, 'r.json'), JSON.stringify(report));
    writeFileSync(join(outside, 'm.json'), JSON.stringify(manifest));
    try {
      linkSync(join(outside, 'r.json'), join(dir, 'hard.json'));
    } catch {
      // Only where the file system cannot make hard links (the temp folder is on one volume, so this is rare).
      ctx.skip();
    }
    await expect(flightTool(dir, { file: 'hard.json' })).rejects.toThrow(/refused the report file path: it is a file with more than one hard link/);
    linkSync(join(outside, 'm.json'), join(dir, 'hard-manifest.json'));
    await expect(flightTool(dir, { manifest: 'hard-manifest.json' })).rejects.toThrow(/refused the manifest path: it is a file with more than one hard link/);
    // A store file hard-linked from elsewhere: the store would read it.
    linkSync(join(outside, 'r.json'), join(dir, '.reins', 'flight', 'minutes', 'hard.json'));
    await expect(flightTool(dir, {})).rejects.toThrow(/refused the store path: it is a file with more than one hard link/);
    // The same files with one link each are read.
    writeFileSync(join(dir, 'plain.json'), JSON.stringify(report));
    await expect(flightTool(dir, { file: 'plain.json' })).resolves.toMatchObject({ source: 'file' });
  });
});

describe('B1: a manifest that is not JSON', () => {
  it('says only "not valid JSON", never the text it read', async () => {
    const { dir } = await project();
    writeFileSync(join(dir, '.env'), 'SECRET=hunter2\n');
    writeFileSync(join(dir, 'long.env'), 'hunter2 '.repeat(50));
    for (const m of ['.env', 'long.env']) {
      const r = await flightTool(dir, { manifest: m, keys: true });
      expect(r.report.manifest).toBe('invalid');
      const all = JSON.stringify(r);
      expect(all, m).not.toContain('hunter2');
      expect(all, m).not.toContain('SECRET');
      expect(r.markdown, m).not.toContain('hunter2');
      expect(all, m).toContain('is not valid JSON');
    }
  });
});

describe('B1: what it reads is capped', () => {
  const small = { ...FLIGHT_TOOL_LIMITS, reportBytes: 1000, manifestBytes: 100, storeBytes: 200, storeFiles: 3 };

  it('has defaults that bound a saved report, the manifest, the store and the wait', () => {
    expect(FLIGHT_TOOL_LIMITS).toEqual({ reportBytes: 8 * 1024 * 1024, manifestBytes: 1024 * 1024, storeBytes: 64 * 1024 * 1024, storeFiles: 5000, timeoutMs: 15_000 });
    expect(Object.isFrozen(FLIGHT_TOOL_LIMITS)).toBe(true);
  });

  it('refuses a report file, a manifest or a store over its cap', async () => {
    const { dir, report } = await project();
    writeFileSync(join(dir, 'big.json'), JSON.stringify({ ...report, pad: 'x'.repeat(2000) }));
    await expect(flightTool(dir, { file: 'big.json' }, small)).rejects.toThrow(/report file is larger than 1000 bytes/);
    await expect(flightTool(dir, {}, { ...small, storeBytes: 1e9, storeFiles: 1e6 })).rejects.toThrow(/manifest is larger than 100 bytes/);
    await expect(flightTool(dir, {}, { ...small, manifestBytes: 1e6 })).rejects.toThrow(/file store holds more than 3 files or 200 bytes/);
  });
});
