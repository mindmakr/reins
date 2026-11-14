// Design C5, C14, sections 6 and 8, unit u6: `reins flight watch` runs the same checker beside the server from the
// app's config module, polls the server's health address from that module, holds the store lock while it runs and
// gives it back, opens no port, and gives the same findings as a server checker from the same store. Also B10: a
// store that refuses the findings write gives a blind finding, told once per app copy.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Server as NetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlight, type Flight, type Notification } from '../src/flight.js';
import { flightMain } from '../src/flight/check-cli.js';
import { fileStore } from '../src/flight/file-store.js';
import { validateManifest } from '../src/flight/manifest.js';
import { type FlightStore, memoryStore } from '../src/flight/store.js';
import { FLIGHT_WATCH_USAGE, flightWatchMain } from '../src/flight/watch-cli.js';
import { flightReportMain } from '../src/flight/report-cli.js';
import { errorCode } from '../src/recorder.js';
import { fig, im, MIN } from './flight-fixtures.js';
import { step } from './flight-store-contract.js';

const H = 60 * MIN;
const flights: Flight[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const f of flights.splice(0)) f.stop();
  await Promise.all(flights.map((f) => f.closed()));
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
  delete (globalThis as any).__reinsFlightWatchTest;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'reins-flight-watch-'));
  dirs.push(d);
  return d;
};
/** A folder for config modules the CLI imports in this test (under vitest on Windows, not on another drive). */
const moduleDir = () => {
  const cache = fileURLToPath(new URL('../../../node_modules/.cache', import.meta.url));
  mkdirSync(cache, { recursive: true });
  const d = mkdtempSync(join(cache, 'reins-flight-watch-'));
  dirs.push(d);
  return d;
};

const manifest = () => ({
  schema: 1,
  service: 'payday',
  processes: [
    {
      name: 'payout',
      key: 'the payout id',
      steps: ['requested', 'bank.sent', 'bank.pending', 'bank.settled', 'bank.failed', 'ledger.debited'],
      ends: ['ledger.debited', 'bank.failed'],
      promises: [
        { id: 'pending-settles', kind: 'within', after: 'bank.pending', expect: ['bank.settled', 'bank.failed'], within: '4h' },
        { id: 'one-debit', kind: 'once', step: 'ledger.debited' },
      ],
    },
  ],
  probes: [],
});

/** One payout overdue, one debited twice, an undeclared refund process and a minute with too many failures. */
async function seeded(store: FlightStore, now = Date.now()) {
  await store.addSteps([
    step('p1', 'requested', now - 10 * H),
    step('p1', 'bank.pending', now - 9 * H),
    step('p2', 'requested', now - 3 * H),
    step('p2', 'bank.pending', now - 2 * H),
    step('p2', 'bank.settled', now - H),
    step('p2', 'ledger.debited', now - H + MIN),
    step('p2', 'ledger.debited', now - H + 2 * MIN),
    step('r1', 'started', now - 20 * MIN, 'refund'),
  ]);
  await store.putMinute(im('a', now - MIN, { requests: [['GET', '/api/pay', fig(100, 30, 20)]] }, { steps: { 'refund started': 1 } }));
  return store;
}

const collect = () => {
  const got: Notification[] = [];
  return { got, sink: (n: Notification) => void got.push(n), told: () => got.filter((n) => n.finding).map((n) => `${n.type} ${n.finding!.key}`) };
};
const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, print: (s: string) => void out.push(s), perr: (s: string) => void err.push(s) };
};
/** Resolves when `cond` holds, polling; fails the test after `ms`. */
async function until(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const server = (o: Record<string, unknown>) => {
  const f = createFlight({});
  flights.push(f);
  expect(f.start({ checkEveryMs: 0, flushMs: 600_000, instance: 'srv', notify: { daily: false }, ...o })).toBe(true);
  return f;
};
const watcher = (o: Record<string, unknown>) => {
  const f = createFlight({});
  flights.push(f);
  expect(f.watch({ checkEveryMs: 0, notify: { daily: false }, ...o })).toBe(true);
  return f;
};
/** The findings by key, kind, level and state, in report order. */
const shape = (f: Flight) => f.findings().map((x) => `${x.key} ${x.kind} ${x.level} ${x.state}`);

/** A health address: answers 200 while `up`, else never answers (`hang`), answers `status`, or drops the connection. */
async function healthServer() {
  const ctl = { up: true, status: 0, hang: false };
  const s = createServer((req, res) => {
    if (ctl.up) return void res.writeHead(200).end('ok');
    if (ctl.hang) return;
    if (ctl.status) return void res.writeHead(ctl.status).end('no');
    req.socket.destroy();
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { ctl, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/healthz` };
}

describe('B1: reins flight watch --config <module>', () => {
  it('loads the app config module, runs the checker against its store and delivers to its sinks', async () => {
    const dir = moduleDir();
    const store = await seeded(fileStore({ dir: join(dir, '.reins', 'flight') }));
    const s = collect();
    (globalThis as any).__reinsFlightWatchTest = { store, sinks: [s.sink], manifest: manifest(), checkEveryMs: 0, notify: { daily: false } };
    writeFileSync(join(dir, 'flight.config.mjs'), 'export default () => globalThis.__reinsFlightWatchTest;\n');
    let stop!: () => void;
    // Run until stopped (the CLI stops on SIGINT or SIGTERM): here, once the sinks heard the findings.
    const o2 = capture();
    const done = flightWatchMain(['--config', 'flight.config.mjs'], dir, o2.print, o2.perr, new Promise<void>((r) => (stop = r)));
    await until(() => s.told().includes('opened promise:payout:pending-settles'));
    stop();
    expect(await done).toBe(0);
    expect(o2.out[0]).toMatch(/^reins flight watch: watching from .*flight\.config\.mjs, a pass once \(checkEveryMs is 0\); no health address/);
    expect(o2.out.at(-1)).toBe('reins flight watch: stopped; the store lock is given back.');
    expect(s.told()).toEqual(expect.arrayContaining(['opened promise:payout:pending-settles', 'opened promise:payout:one-debit', 'opened basic:error-share', 'opened unusual:process:refund']));
    // What it found is in the store the servers share, and it gave the lock back.
    const stored = (await store.findings()).filter((r) => r.state === 'open').map((r) => r.key);
    expect(stored).toEqual(expect.arrayContaining(['promise:payout:pending-settles', 'promise:payout:one-debit', 'basic:error-share']));
    expect(await store.lock('someone-else', MIN)).toBe(true);
  });

  it('prints its usage, and refuses bad usage with exit 2', async () => {
    const h = capture();
    expect(await flightMain(['watch', '--help'], tmp(), h.print, h.perr)).toBe(0);
    expect(h.err.join('\n')).toMatch(/reins flight watch --config <module>/);
    for (const args of [['watch'], ['watch', '--config'], ['watch', '--config', 'a.mjs', 'extra'], ['watch', '--port', '1']]) {
      const o = capture();
      expect(await flightMain(args, tmp(), o.print, o.perr), args.join(' ')).toBe(2);
      expect(o.err[0]).toMatch(/^reins flight watch: /);
    }
  });
});

describe('B2: the health address, from the config module', () => {
  it('opens a basic finding while the server does not answer its health address, and resolves it when it answers again', async () => {
    const h = await healthServer();
    const dir = moduleDir();
    const store = memoryStore();
    const s = collect();
    // The address is in the config module the server passes to flight.start(); the manifest refuses one.
    expect(validateManifest({ ...manifest(), healthUrl: h.url }).ok).toBe(false);
    (globalThis as any).__reinsFlightWatchTest = { store, sinks: [s.sink], manifest: manifest(), healthUrl: h.url, checkEveryMs: 50, notify: { daily: false } };
    writeFileSync(join(dir, 'flight.config.mjs'), 'export const config = globalThis.__reinsFlightWatchTest;\n');
    const o = capture();
    let stop!: () => void;
    const done = flightWatchMain(['--config', 'flight.config.mjs'], dir, o.print, o.perr, new Promise<void>((r) => (stop = r)));
    expect(o.out).toEqual([]);
    await until(() => o.out.length > 0);
    // The start line names the address by its origin only, never its path.
    expect(o.out[0]).toMatch(/health address http:\/\/127\.0\.0\.1:\d+\.$/);
    // Answering: checked, no finding.
    await until(async () => (await store.findings()).length > 0);
    expect(s.told().filter((t) => t.endsWith('basic:health'))).toEqual([]);
    // No answer: a basic finding, told once however many periods it lasts.
    h.ctl.up = false;
    await until(() => s.told().includes('opened basic:health'));
    const opened = s.got.find((n) => n.type === 'opened' && n.finding?.key === 'basic:health')!.finding!;
    expect(opened).toMatchObject({ kind: 'basic', level: 'error' });
    expect(opened.text).toMatch(/^The server's health address failed: it did not answer \(\w+\)\. The server may be down\.$/);
    const record = async () => (await store.findings()).find((r) => r.key === 'basic:health');
    await until(async () => ((await record())?.data as any)?.count >= 3);
    expect(s.told().filter((t) => t.endsWith('basic:health'))).toEqual(['opened basic:health']);
    // Answering again: resolved, once.
    h.ctl.up = true;
    await until(() => s.told().includes('resolved basic:health'));
    expect((await record())!.state).toBe('resolved');
    // A non-2xx answer is not an answer: open again, and its text names the status.
    h.ctl.status = 503;
    h.ctl.up = false;
    await until(() => s.told().filter((t) => t === 'opened basic:health').length === 2);
    expect(s.got.filter((n) => n.type === 'opened' && n.finding?.key === 'basic:health')[1].finding!.text).toBe("The server's health address failed: it answered with status 503. The server may be down.");
    stop();
    expect(await done).toBe(0);
  });

  it('once no watcher polls the address, a server checker resolves the health finding instead of carrying it open', async () => {
    const h = await healthServer();
    h.ctl.up = false;
    const store = memoryStore();
    const s = collect();
    const w = watcher({ store, healthUrl: h.url, sinks: [s.sink] });
    await w.checkNow();
    await until(async () => (await store.findings()).some((r) => r.key === 'basic:health' && r.state === 'open'));
    w.stop();
    await w.closed();
    const srv = server({ store, sinks: [s.sink] });
    await store.putMinute(im('a', Date.now() - MIN, { requests: [['GET', '/api/pay', fig(100, 0, 20)]] }));
    expect(await srv.checkNow()).not.toBeNull();
    await srv.sinksIdle();
    expect(srv.findings().find((f) => f.key === 'basic:health')).toMatchObject({ state: 'resolved', kind: 'basic' });
    expect((await store.findings()).find((r) => r.key === 'basic:health')!.state).toBe('resolved');
    expect(s.told().filter((t) => t.endsWith('basic:health'))).toEqual(['opened basic:health', 'resolved basic:health']);
  });

  it('with a pass time limit under 10 s, a health address that never answers opens the health finding, not a store outage', async () => {
    const h = await healthServer();
    h.ctl.up = false;
    h.ctl.hang = true;
    const store = memoryStore();
    const w = watcher({ store, healthUrl: h.url, checkTimeoutMs: 3000 });
    const t0 = Date.now();
    expect(await w.checkNow()).not.toBeNull();
    // The poll gives up at half the pass's limit (1.5 s), so the pass ends inside its 3 s.
    expect(Date.now() - t0).toBeLessThan(3000);
    const keys = w.findings().filter((f) => f.state === 'open').map((f) => f.key);
    expect(keys).toContain('basic:health');
    expect(keys).not.toContain('blind:store-unreachable');
    expect(w.findings().find((f) => f.key === 'basic:health')!.text).toBe("The server's health address failed: it did not answer within 1.5 s. The server may be down.");
    // The next pass reaches the store again: the last one did not run past its limit.
    expect(await w.checkNow()).not.toBeNull();
    expect(w.findings().some((f) => f.key === 'blind:store-unreachable')).toBe(false);
  }, 15_000);

  it('names the code of a refused connection', async () => {
    // A port that was free a moment ago and is not one fetch refuses to use.
    let port = 0;
    for (let i = 0; i < 20 && (!port || [6000, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080].includes(port)); i++) {
      const s = createServer();
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
      port = (s.address() as AddressInfo).port;
      await new Promise((r) => s.close(r));
    }
    const w = watcher({ store: memoryStore(), healthUrl: `http://127.0.0.1:${port}/healthz` });
    await w.checkNow();
    expect(w.findings().find((f) => f.key === 'basic:health')!.text).toBe("The server's health address failed: it did not answer (ECONNREFUSED). The server may be down.");
    // A code kept only on the errors inside an AggregateError (a connection tried on several addresses) is named too.
    const inner = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    expect(errorCode(new TypeError('fetch failed', { cause: new AggregateError([inner, inner]) }))).toBe('ECONNREFUSED');
  });

  it('refuses a health address fetch could never poll: not http or https, with a user or password, or on a port fetch refuses', () => {
    for (const healthUrl of ['ftp://x/health', 'not a url', 42, 'file:///etc/passwd', 'http://user:pw@127.0.0.1:8080/healthz', 'https://token@example.com/healthz', 'http://127.0.0.1:1/healthz', 'http://127.0.0.1:6000/healthz'])
      expect(createFlight({}).watch({ store: memoryStore(), healthUrl } as any), String(healthUrl)).toBe(false);
  });
});

describe('B3: one checker at a time, the watcher first while it runs', () => {
  it('while a watcher holds the store lock the server checkers stand down; when it stops, a server checker takes over', async () => {
    const dir = join(tmp(), 'flight');
    await seeded(fileStore({ dir }));
    const s = collect();
    // Each its own store object on the one folder, as two processes have.
    const srv = server({ store: fileStore({ dir }), manifest: manifest(), sinks: [s.sink] });
    const w = watcher({ store: fileStore({ dir }), manifest: manifest(), sinks: [s.sink] });
    expect(await w.checkNow()).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(await srv.checkNow()).toBeNull();
      expect(await w.checkNow()).not.toBeNull();
    }
    // The app's findings were told once, by the watcher, while the server stood down.
    expect(s.told().filter((t) => t === 'opened promise:payout:pending-settles')).toHaveLength(1);
    w.stop();
    await w.closed();
    // Stopped: the lock is given back, and the server's next pass checks.
    expect(await srv.checkNow()).not.toBeNull();
    expect(s.told().filter((t) => t === 'opened promise:payout:pending-settles')).toHaveLength(1);
  });

  it('exits within a bound when the store does not take the lock back; a second signal ends the wait at once', async () => {
    const dir = moduleDir();
    // A store that never answers unlock, as a hung pool does.
    const base = memoryStore();
    const hung = new Proxy(base, {
      get(t, k) {
        const v = (t as any)[k];
        if (typeof v !== 'function') return v;
        return k === 'unlock' ? () => new Promise(() => {}) : v.bind(t);
      },
    }) as FlightStore;
    (globalThis as any).__reinsFlightWatchTest = { store: hung, checkEveryMs: 0, notify: { daily: false } };
    writeFileSync(join(dir, 'flight.config.mjs'), 'export default globalThis.__reinsFlightWatchTest;\n');
    const stopLine = 'reins flight watch: stopped; the store did not confirm the lock was given back, so a server checker takes over when its lease runs out (within 3 min).';
    const run = async (stopWaitMs?: number, then?: () => void) => {
      let stop!: () => void;
      const o = capture();
      const done = flightWatchMain(['--config', 'flight.config.mjs'], dir, o.print, o.perr, new Promise<void>((r) => (stop = r)), stopWaitMs);
      await until(() => o.out.length > 0);
      const t0 = Date.now();
      stop();
      then?.();
      expect(await done).toBe(0);
      expect(o.out.at(-1)).toBe(stopLine);
      return Date.now() - t0;
    };
    // Flight's own bound: the store has 5 s to take the lock back, then closed() says it did not.
    const own = await run();
    expect(own).toBeGreaterThanOrEqual(4_900);
    expect(own).toBeLessThan(8_000);
    // The command's bound on the whole wait.
    expect(await run(300)).toBeLessThan(1_500);
    // A second SIGTERM (or Ctrl+C) while it waits: it exits at once.
    // Only the command's own listener is called: the test runner's are left alone.
    const others = new Set(process.listeners('SIGTERM'));
    const signal = () => {
      const mine = process.listeners('SIGTERM').filter((l) => !others.has(l));
      expect(mine).toHaveLength(1);
      (mine[0] as (s: string) => void)('SIGTERM');
    };
    const second = await run(60_000, () => setTimeout(signal, 100));
    expect(second).toBeLessThan(1_500);
  }, 30_000);

  it('a watcher that dies holding the lock is taken over within the lease: three periods, at least three minutes', async () => {
    const dir = join(tmp(), 'flight');
    await seeded(fileStore({ dir }));
    const srv = server({ store: fileStore({ dir }), manifest: manifest() });
    // A store that never gives the lock back, as when the watcher process is killed.
    const base = fileStore({ dir });
    const dying = { ...base, unlock: async () => {} } as FlightStore;
    const w = watcher({ store: dying, manifest: manifest() });
    expect(await w.checkNow()).not.toBeNull();
    w.stop();
    await w.closed();
    const t0 = Date.now();
    expect(await srv.checkNow()).toBeNull();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0 + 3 * MIN - 5_000);
    try {
      expect(await srv.checkNow()).toBeNull();
      clock.mockReturnValue(t0 + 3 * MIN + 1_000);
      expect(await srv.checkNow()).not.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('B4: no port, no route, no shell; a config module that cannot load', () => {
  it('opens no port while it watches', async () => {
    const dir = moduleDir();
    (globalThis as any).__reinsFlightWatchTest = { store: memoryStore(), manifest: manifest(), checkEveryMs: 20 };
    writeFileSync(join(dir, 'flight.config.mjs'), 'export default globalThis.__reinsFlightWatchTest;\n');
    const listen = vi.spyOn(NetServer.prototype, 'listen');
    try {
      let stop!: () => void;
      const o = capture();
      const done = flightWatchMain(['--config', 'flight.config.mjs'], dir, o.print, o.perr, new Promise<void>((r) => (stop = r)));
      await new Promise((r) => setTimeout(r, 150));
      stop();
      expect(await done).toBe(0);
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  });

  it('holds no server, route or process code', () => {
    for (const file of ['watch-cli.ts', '../flight.ts']) {
      const src = readFileSync(fileURLToPath(new URL(`../src/flight/${file}`, import.meta.url)), 'utf8');
      expect(src, file).not.toMatch(/createServer|\.listen\(|child_process|\bexec(File)?(Sync)?\(|\bspawn(Sync)?\(|\beval\(|new Function/);
    }
  });

  it('exits non-zero with a plain message when the config module cannot be loaded or cannot start a watcher', async () => {
    const dir = moduleDir();
    writeFileSync(join(dir, 'broken.mjs'), 'export default {;\n');
    writeFileSync(join(dir, 'nostore.mjs'), 'export default { service: "x" };\n');
    writeFileSync(join(dir, 'throws.mjs'), 'export default () => { throw new Error("boom: secret-value"); };\n');
    writeFileSync(join(dir, 'badhealth.mjs'), 'export default { store: globalThis.__reinsFlightWatchTest.store, healthUrl: "ftp://x" };\n');
    (globalThis as any).__reinsFlightWatchTest = { store: memoryStore() };
    const cases: Array<[string, RegExp]> = [
      ['missing.mjs', /missing\.mjs not found$/],
      ['broken.mjs', /broken\.mjs could not be loaded \(SyntaxError: a syntax error, or a module Node cannot run as it is\)$/],
      ['nostore.mjs', /nostore\.mjs: its options have no store\. A watcher checks the store the servers write to/],
      ['throws.mjs', /throws\.mjs: its config function threw \(Error\)$/],
      ['badhealth.mjs', /badhealth\.mjs: its options cannot start a watcher: check store, healthUrl \(an http or https URL with no user or password, on a port fetch may use\)/],
    ];
    for (const [file, re] of cases) {
      const o = capture();
      expect(await flightWatchMain(['--config', file], dir, o.print, o.perr, Promise.resolve()), file).toBe(2);
      expect(o.err, file).toHaveLength(1);
      expect(o.err[0], file).toMatch(/^reins flight watch: /);
      expect(o.err[0], file).toMatch(re);
      expect(o.err[0]).not.toMatch(/secret-value|\n\s+at /);
      expect(o.out).toEqual([]);
    }
    // The no-store message is worded for the watcher, not for flight.report().
    const o = capture();
    await flightWatchMain(['--config', 'nostore.mjs'], dir, o.print, o.perr, Promise.resolve());
    expect(o.err[0]).toMatch(/where a watcher cannot reach it\.$/);
    expect(o.err[0]).not.toMatch(/flight\.report\(\)/);
  });

  it('prints only the code of what a config getter throws, never its message', async () => {
    const dir = moduleDir();
    (globalThis as any).__reinsFlightWatchTest = { store: memoryStore() };
    // A store getter that throws from its nth read on: in loading the module, in reading its store, in watch().
    for (const n of [0, 1, 2]) writeFileSync(join(dir, `getter${n}.mjs`), `let reads = 0;\nexport default { get store() { if (reads++ >= ${n}) throw new Error('s3cr3t-TOKEN-xyz'); return globalThis.__reinsFlightWatchTest.store; } };\n`);
    writeFileSync(join(dir, 'service.mjs'), `export default { store: globalThis.__reinsFlightWatchTest.store, get service() { throw new Error('s3cr3t-TOKEN-xyz'); } };\n`);
    const cases: Array<[string[], RegExp]> = [
      [['watch', 'getter0.mjs'], /getter0\.mjs: its config function threw \(Error\)$/],
      [['watch', 'getter1.mjs'], /getter1\.mjs: its store could not be read \(Error\)$/],
      [['watch', 'getter2.mjs'], /getter2\.mjs: its options cannot start a watcher/],
      [['watch', 'service.mjs'], /service\.mjs: its options cannot start a watcher/],
      [['report', 'getter1.mjs'], /getter1\.mjs: its store could not be read \(Error\)$/],
      [['report', 'service.mjs'], /service\.mjs: its service could not be read \(Error\)$/],
    ];
    for (const [[cmd, file], re] of cases) {
      const o = capture();
      // A fresh copy of the module each time, so its read count starts again.
      const copy = `${cmd}-${file}`;
      writeFileSync(join(dir, copy), readFileSync(join(dir, file), 'utf8'));
      const code = cmd === 'watch' ? await flightWatchMain(['--config', copy], dir, o.print, o.perr, Promise.resolve()) : await flightReportMain(['--config', copy], dir, o.print, o.perr);
      expect(code, copy).toBe(2);
      expect(o.err, copy).toHaveLength(1);
      expect(o.err[0], copy).toMatch(new RegExp(`^reins flight ${cmd}: `));
      expect(o.err[0], copy).toMatch(re);
      expect(o.err.join('\n') + o.out.join('\n')).not.toMatch(/s3cr3t|\n\s+at /);
    }
  });

  it('says in its usage that it checks while it holds the lock, and takes over once a server stops renewing it', () => {
    expect(FLIGHT_WATCH_USAGE).not.toMatch(/While it runs it holds the store's checker lock/);
    expect(FLIGHT_WATCH_USAGE).toMatch(/It checks while it holds the store's checker lock/);
    expect(FLIGHT_WATCH_USAGE).toMatch(/while a server holds the lock, the watcher waits and takes over once that server stops renewing it/);
    expect(FLIGHT_WATCH_USAGE).toMatch(/a second Ctrl\+C or SIGTERM exits at once/);
  });
});

describe('B5: the same findings inside a server and in the watcher', () => {
  it('given the same store contents, by key, kind and level', async () => {
    const now = Date.now();
    const a = await seeded(memoryStore(), now);
    const b = await seeded(memoryStore(), now);
    const srv = server({ store: a, manifest: manifest() });
    const w = watcher({ store: b, manifest: manifest() });
    expect(await srv.checkNow()).not.toBeNull();
    expect(await w.checkNow()).not.toBeNull();
    expect(shape(w)).toEqual(shape(srv));
    expect(shape(w)).toEqual(
      expect.arrayContaining(['promise:payout:pending-settles broken error open', 'promise:payout:one-debit broken error open', 'basic:error-share basic error open', 'unusual:process:refund unusual warn open']),
    );
    const stored = async (s: FlightStore) => (await s.findings()).map((r) => `${r.key} ${r.state}`).sort();
    expect(await stored(b)).toEqual(await stored(a));
  });
});

describe('B6: loads with import, and with require on Node 22.12 or newer', () => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const entry = join(dist, 'flight.js');
  const cli = join(dist, 'flight', 'watch-cli.js');
  const [major, minor] = process.versions.node.split('.').map(Number);
  const requireOk = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);
  const run = (args: string[]) => execFileSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } }).trim();

  it.skipIf(!existsSync(entry) || !existsSync(cli))('loads the built flight entry and watcher with import (after npm run build)', () => {
    const script = `const f = await import(${JSON.stringify(pathToFileURL(entry).href)}); const w = await import(${JSON.stringify(pathToFileURL(cli).href)}); console.log(typeof f.flight.watch, typeof w.flightWatchMain);`;
    expect(run(['--input-type=module', '-e', script])).toBe('function function');
  });

  it.skipIf(!existsSync(entry) || !existsSync(cli) || !requireOk)('loads them with require on this Node (after npm run build)', () => {
    const script = `const f = require(${JSON.stringify(entry)}); const w = require(${JSON.stringify(cli)}); console.log(typeof f.flight.watch, typeof w.flightWatchMain, f.flight.isStarted());`;
    expect(run(['-e', script])).toBe('function function false');
  });

  it('states the Node versions of design C17 in the package docs', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'latin1');
    expect(readme).toMatch(/with `import` it needs Node 18 or newer; loaded with `require` it needs Node 20\.19 or 22\.12 and newer/);
  });
});

describe('B10: a store that refuses the findings write', () => {
  const fail = () => Object.assign(new Error('refused'), { code: 'EACCES' });
  /** A store that answers the lock and the reads, and refuses the findings write while `refuse` is set. */
  function refusing(base: FlightStore) {
    const ctl = { refuse: true };
    const store = new Proxy(base, {
      get(t, k) {
        const v = (t as any)[k];
        if (typeof v !== 'function') return v;
        return async (...a: unknown[]) => {
          if (k === 'putFindings' && ctl.refuse) throw fail();
          return v.apply(t, a);
        };
      },
    }) as FlightStore;
    return { store, ctl };
  }

  it('raises a blind finding that flight cannot save findings, told once per app copy, and its end once', async () => {
    const base = await seeded(memoryStore());
    const wa = refusing(base);
    const wb = refusing(base);
    const sa = collect();
    const sb = collect();
    const A = server({ store: wa.store, manifest: manifest(), sinks: [sa.sink], instance: 'A' });
    const B = server({ store: wb.store, manifest: manifest(), sinks: [sb.sink], instance: 'B' });
    for (let i = 0; i < 4; i++) {
      expect(await A.checkNow()).not.toBeNull();
      expect(await B.checkNow()).toBeNull();
      await A.sinksIdle();
    }
    expect(sa.told()).toEqual(['opened blind:findings-unsaved']);
    const f = A.findings().find((x) => x.key === 'blind:findings-unsaved')!;
    expect(f).toMatchObject({ kind: 'blind', level: 'error', state: 'open', count: 4 });
    expect(f.text).toBe('The store answered but refused to save the findings (EACCES), so what flight found was neither saved nor told.');
    // Nothing about the app was told, and the store holds none of it.
    expect((await base.findings()).map((r) => r.key)).toEqual([]);
    // The other copy takes over when A stops, and tells its own, once.
    A.stop();
    await A.closed();
    for (let i = 0; i < 3; i++) {
      expect(await B.checkNow()).not.toBeNull();
      await B.sinksIdle();
    }
    expect(sb.told()).toEqual(['opened blind:findings-unsaved']);
    // The write goes through again: resolved once, and the app's findings told.
    wb.ctl.refuse = false;
    for (let i = 0; i < 2; i++) {
      await B.checkNow();
      await B.sinksIdle();
    }
    expect(sb.told().filter((t) => t.endsWith('blind:findings-unsaved'))).toEqual(['opened blind:findings-unsaved', 'resolved blind:findings-unsaved']);
    expect(sb.told()).toContain('opened promise:payout:pending-settles');
    expect((await base.findings()).map((r) => r.key)).not.toContain('blind:findings-unsaved');
  });
});
