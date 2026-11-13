// Design sections 4, 5 and 8, behaviours B1 and B4 to B10: flight.step, the checker for each promise kind,
// the look-back window, probes, dropped steps and an invalid manifest.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFlight, type Flight } from '../src/flight.js';
import { check, type PromiseCheck } from '../src/flight/checker.js';
import { validateManifest } from '../src/flight/manifest.js';
import { runProbe } from '../src/flight/probes.js';
import { createStepWriter } from '../src/flight/steps.js';
import { type FlightStore, memoryStore } from '../src/flight/store.js';
import { minute, step } from './flight-store-contract.js';

const H = 3_600_000;
const DAY = 24 * H;

/** The example manifest from docs/design/flight.md section 4. */
const manifestData = (extra: Record<string, unknown> = {}) => ({
  schema: 1,
  service: 'invoice-api',
  upstreams: ['bank.example.com'],
  processes: [
    {
      name: 'payout',
      key: 'the payout id',
      steps: ['requested', 'bank.sent', 'bank.pending', 'bank.settled', 'bank.failed', 'ledger.debited'],
      ends: ['ledger.debited', 'bank.failed'],
      retries: { 'bank.sent': 3 },
      promises: [
        { id: 'pending-settles', kind: 'within', after: 'bank.pending', expect: ['bank.settled', 'bank.failed'], within: '4h' },
        { id: 'one-debit', kind: 'once', step: 'ledger.debited' },
        { id: 'debit-after-settle', kind: 'order', first: 'bank.settled', then: 'ledger.debited' },
        { id: 'payout-ends', kind: 'ends', within: '24h' },
      ],
    },
  ],
  probes: [{ id: 'pool-matches-ledger', every: '15m' }],
  ...extra,
});
const manifest = (extra?: Record<string, unknown>) => {
  const r = validateManifest(manifestData(extra));
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r;
};

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const get = (r: { promises: PromiseCheck[] }, id: string) => r.promises.find((p) => p.id === id)!;

async function storeWith(...steps: Array<[string, string, number]>): Promise<FlightStore> {
  const s = memoryStore();
  await s.addSteps(steps.map(([key, name, at]) => step(key, name, at)));
  return s;
}

const flights: Flight[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of flights.splice(0)) f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const newFlight = () => {
  const f = createFlight({});
  flights.push(f);
  return f;
};

describe('within (B5)', () => {
  it('is broken when the time passes after the after step with none of the expect steps', async () => {
    const s = await storeWith(['p1', 'bank.pending', NOW - 5 * H], ['p2', 'bank.pending', NOW - 3 * H], ['p3', 'bank.pending', NOW - 6 * H], ['p3', 'bank.failed', NOW - 5 * H]);
    const r = get(await check(s, manifest(), { now: NOW }), 'pending-settles');
    expect(r).toMatchObject({ state: 'broken', count: 1, keys: ['p1'], lastBreachAt: NOW - H, runs: 3 });
  });

  it('a late arrival leaves the count, and how late it was is kept', async () => {
    const s = await storeWith(['p1', 'bank.pending', NOW - 6 * H], ['p1', 'bank.settled', NOW - 30 * 60_000]);
    const r = get(await check(s, manifest(), { now: NOW }), 'pending-settles');
    expect(r).toMatchObject({ state: 'held', lateCount: 1, late: [{ key: 'p1', lateMs: 90 * 60_000, at: NOW - 30 * 60_000 }] });
  });
});

describe('ends (B5)', () => {
  it('is broken when a run is older than the time and has reached no end step', async () => {
    const s = await storeWith(['old', 'requested', NOW - 25 * H], ['old', 'bank.sent', NOW - 2 * H], ['new', 'requested', NOW - 2 * H], ['done', 'requested', NOW - 28 * H], ['done', 'ledger.debited', NOW - 3 * H]);
    const r = get(await check(s, manifest(), { now: NOW }), 'payout-ends');
    // `done` ended after 25 hours: late by one hour, not overdue.
    expect(r).toMatchObject({ state: 'broken', count: 1, keys: ['old'], lastBreachAt: NOW - H, late: [{ key: 'done', lateMs: H, at: NOW - 3 * H }], lateCount: 1 });
  });
});

describe('once, order and retries (B6)', () => {
  it('once is broken on a second record of the step for one key', async () => {
    const s = await storeWith(['p1', 'ledger.debited', NOW - 3 * H], ['p1', 'ledger.debited', NOW - 2 * H], ['p2', 'ledger.debited', NOW - H]);
    expect(get(await check(s, manifest(), { now: NOW }), 'one-debit')).toMatchObject({ state: 'broken', count: 1, keys: ['p1'], lastBreachAt: NOW - 2 * H });
  });

  it('order is broken when then is recorded for a key with no first', async () => {
    const s = await storeWith(
      ['bad', 'ledger.debited', NOW - 3 * H],
      ['bad', 'bank.settled', NOW - 2 * H], // a first that comes after does not mend it
      ['good', 'bank.settled', NOW - 2 * H],
      ['good', 'ledger.debited', NOW - H],
    );
    expect(get(await check(s, manifest(), { now: NOW }), 'debit-after-settle')).toMatchObject({ state: 'broken', count: 1, keys: ['bad'], lastBreachAt: NOW - 3 * H });
  });

  it('retries of 3 allow four records of the step per key, and the fifth is a breach', async () => {
    const four = [1, 2, 3, 4].map((i): [string, string, number] => ['p4', 'bank.sent', NOW - 10 * H + i]);
    const five = [1, 2, 3, 4, 5].map((i): [string, string, number] => ['p5', 'bank.sent', NOW - 9 * H + i]);
    let r = get(await check(await storeWith(...four), manifest(), { now: NOW }), 'retries:bank.sent');
    expect(r).toMatchObject({ kind: 'retries', state: 'held', runs: 1 });
    r = get(await check(await storeWith(...four, ...five), manifest(), { now: NOW }), 'retries:bank.sent');
    expect(r).toMatchObject({ state: 'broken', count: 1, keys: ['p5'], lastBreachAt: NOW - 9 * H + 5 });
  });

  it('a step not under retries or once may repeat freely', async () => {
    const s = await storeWith(['p1', 'requested', NOW - 3 * H], ['p1', 'requested', NOW - 2 * H], ['p1', 'requested', NOW - H]);
    const r = await check(s, manifest(), { now: NOW });
    expect(r.promises.filter((p) => p.state !== 'held' && p.id !== 'payout-ends')).toEqual([]);
  });
});

describe('the look-back window (B7)', () => {
  it('is 24 hours unless the promise sets window, and only runs with a step inside it are checked', async () => {
    const s = await storeWith(['p1', 'ledger.debited', NOW - 30 * H], ['p1', 'ledger.debited', NOW - 29 * H]);
    expect(get(await check(s, manifest(), { now: NOW }), 'one-debit')).toMatchObject({ state: 'held', runs: 0, windowMs: DAY, since: NOW - DAY });
    const wide = manifestData();
    (wide.processes[0].promises[1] as any).window = '2d';
    const m = validateManifest(wide);
    expect(get(await check(s, m, { now: NOW }), 'one-debit')).toMatchObject({ state: 'broken', runs: 1, windowMs: 2 * DAY });
  });

  it('a step recorded after a run ended belongs to that same run', async () => {
    // The first debit is 30 hours old, outside the window; the run's late second debit brings it in, whole.
    const s = await storeWith(['p1', 'bank.settled', NOW - 31 * H], ['p1', 'ledger.debited', NOW - 30 * H], ['p1', 'ledger.debited', NOW - H]);
    const r = await check(s, manifest(), { now: NOW });
    expect(get(r, 'one-debit')).toMatchObject({ state: 'broken', keys: ['p1'], lastBreachAt: NOW - H });
    expect(get(r, 'debit-after-settle')).toMatchObject({ state: 'held', runs: 1 });
  });
});

describe('overdue runs older than the window (B7)', () => {
  it('a run pending longer than the window with no new step is still broken, for within and for ends', async () => {
    const s = await storeWith(['stuck', 'requested', NOW - 40 * H], ['stuck', 'bank.pending', NOW - 30 * H]);
    const r = await check(s, manifest(), { now: NOW });
    expect(get(r, 'pending-settles')).toMatchObject({ state: 'broken', count: 1, keys: ['stuck'], lastBreachAt: NOW - 26 * H, runs: 1 });
    expect(get(r, 'payout-ends')).toMatchObject({ state: 'broken', count: 1, keys: ['stuck'], lastBreachAt: NOW - 16 * H, runs: 1 });
    // The window still limits once and order: the run has no step inside it.
    expect(get(r, 'one-debit')).toMatchObject({ state: 'held', runs: 0 });
  });

  it('leaves the count when the expected or end step arrives, and the late arrival is listed', async () => {
    const s = await storeWith(['stuck', 'requested', NOW - 40 * H], ['stuck', 'bank.pending', NOW - 30 * H], ['stuck', 'bank.failed', NOW - H]);
    const r = await check(s, manifest(), { now: NOW });
    expect(get(r, 'pending-settles')).toMatchObject({ state: 'held', lateCount: 1, late: [{ key: 'stuck', lateMs: 25 * H, at: NOW - H }] });
    expect(get(r, 'payout-ends')).toMatchObject({ state: 'held', lateCount: 1, late: [{ key: 'stuck', lateMs: 15 * H, at: NOW - H }] });
  });

  it('a late arrival outside the window is no longer listed', async () => {
    const s = await storeWith(['old', 'requested', NOW - 80 * H], ['old', 'bank.pending', NOW - 79 * H], ['old', 'bank.failed', NOW - 30 * H]);
    const r = await check(s, manifest(), { now: NOW });
    expect(get(r, 'pending-settles')).toMatchObject({ state: 'held', runs: 0, lateCount: 0 });
    expect(get(r, 'payout-ends')).toMatchObject({ state: 'held', runs: 0, lateCount: 0 });
  });

  it('a run retention removed while still open is reported as a blind fact', async () => {
    const s = await storeWith(['stuck', 'requested', NOW - 9 * DAY], ['done', 'requested', NOW - 9 * DAY], ['done', 'ledger.debited', NOW - 9 * DAY]);
    const m = manifest();
    const { endsOf } = await import('../src/flight/checker.js');
    expect(endsOf(m)).toEqual({ payout: ['ledger.debited', 'bank.failed'] });
    await s.prune({ maxAgeMs: 7 * DAY }, NOW - 60_000, endsOf(m));
    const r = await check(s, m, { now: NOW });
    expect(r.blind).toContainEqual({ kind: 'overdue-pruned', process: 'payout', count: 1, since: NOW - DAY });
    expect(get(r, 'payout-ends')).toMatchObject({ state: 'held', runs: 0 });
    // The prune record is not an instance: probes are still reported as having no instance.
    expect(r.probes).toMatchObject([{ reason: 'no-instance' }]);
  });
});

describe('dropped steps (B9)', () => {
  it('reports once, order and retries for the window as not checked, not as held', async () => {
    const s = await storeWith(['p1', 'bank.settled', NOW - 2 * H], ['p1', 'ledger.debited', NOW - H]);
    await s.putMinute(minute('i1', NOW - 3 * H, { stepsDropped: { payout: 7 } }));
    const r = await check(s, manifest(), { now: NOW });
    for (const id of ['one-debit', 'debit-after-settle', 'retries:bank.sent']) expect(get(r, id)).toMatchObject({ state: 'not-checked', reason: 'steps-dropped', stepsDropped: 7 });
    expect(get(r, 'pending-settles')).toMatchObject({ state: 'held', stepsDropped: 7 });
    expect(r.blind).toContainEqual({ kind: 'steps-dropped', process: 'payout', count: 7, since: NOW - DAY });
  });

  it('drops outside the window, or for another process, do not count', async () => {
    const s = await storeWith(['p1', 'ledger.debited', NOW - H]);
    await s.putMinute(minute('i1', NOW - 25 * H, { stepsDropped: { payout: 7 } }));
    await s.putMinute(minute('i1', NOW - H, { stepsDropped: { refund: 2 } }));
    expect(get(await check(s, manifest(), { now: NOW }), 'one-debit')).toMatchObject({ state: 'held', stepsDropped: 0 });
  });
});

describe('the store cannot be read', () => {
  it('reports every promise and probe as not checked, and a blind fact; never throws', async () => {
    const broken = { ...memoryStore(), minutes: async () => Promise.reject(Object.assign(new Error('password=hunter2 at db'), { code: 'ECONNREFUSED' })) };
    const r = await check(broken, manifest(), { now: NOW });
    expect(r.blind).toEqual([{ kind: 'store-unreachable', error: 'ECONNREFUSED' }]);
    expect(r.promises).toHaveLength(5);
    expect(r.promises.every((p) => p.state === 'not-checked' && p.reason === 'store-unreachable')).toBe(true);
    expect(r.probes).toMatchObject([{ id: 'pool-matches-ledger', state: 'not-checked', reason: 'store-unreachable' }]);
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });
});

describe('probes (B8)', () => {
  it('a result of ok false, a throw or a timeout is a breach; only ok is kept', async () => {
    expect(await runProbe('a', () => ({ ok: true, rows: ['secret'] }), 'i')).toMatchObject({ ok: true });
    expect(await runProbe('a', async () => ({ ok: false, detail: 'secret' }), 'i')).toMatchObject({ ok: false, reason: 'returned' });
    expect(await runProbe('a', () => 'yes', 'i')).toMatchObject({ ok: false, reason: 'returned' });
    expect(await runProbe('a', () => { throw new Error('secret'); }, 'i')).toMatchObject({ ok: false, reason: 'threw' });
    expect(await runProbe('a', () => Promise.reject(new Error('secret')), 'i')).toMatchObject({ ok: false, reason: 'threw' });
    const slow = await runProbe('a', () => new Promise(() => {}), 'i', 20);
    expect(slow).toMatchObject({ ok: false, reason: 'timeout' });
    expect(JSON.stringify(slow)).not.toContain('secret');
  });

  it('checks the latest result: held, broken, too old, declared but not registered, registered but not declared', async () => {
    const m = manifest({ probes: [{ id: 'pool-matches-ledger', every: '15m' }, { id: 'cash', every: '1m' }, { id: 'orphan', every: '1m' }] });
    const s = memoryStore();
    await s.putMinute(minute('i1', NOW - 60_000, { probes: ['cash', 'pool-matches-ledger', 'extra'] }));
    await s.putProbe({ id: 'pool-matches-ledger', instance: 'i1', at: NOW - 10 * 60_000, ok: false, reason: 'timeout', ms: 10_000 });
    await s.putProbe({ id: 'cash', instance: 'i1', at: NOW - 3 * 60_000, ok: true, ms: 2 });
    const r = await check(s, m, { now: NOW });
    expect(r.probes).toEqual([
      { id: 'pool-matches-ledger', everyMs: 15 * 60_000, lastAt: NOW - 10 * 60_000, state: 'broken', reason: 'timeout' },
      { id: 'cash', everyMs: 60_000, lastAt: NOW - 3 * 60_000, state: 'not-checked', reason: 'stale' },
      { id: 'orphan', everyMs: 60_000, lastAt: null, state: 'not-checked', reason: 'not-registered' },
    ]);
    expect(r.blind).toEqual(
      expect.arrayContaining([
        { kind: 'probe-stale', id: 'cash', lastAt: NOW - 3 * 60_000, everyMs: 60_000 },
        { kind: 'probe-not-registered', id: 'orphan' },
        { kind: 'probe-not-declared', id: 'extra' },
      ]),
    );
  });

  it('with no instance reporting, probes are not checked rather than not registered', async () => {
    const r = await check(memoryStore(), manifest(), { now: NOW });
    expect(r.probes).toMatchObject([{ state: 'not-checked', reason: 'no-instance' }]);
    expect(r.blind).toEqual([{ kind: 'no-instance', since: NOW - 5 * 60_000 }]);
  });

  it('flight.probe runs a registered probe from start and the checker sees it', async () => {
    const f = newFlight();
    const store = memoryStore();
    expect(f.probe('pool-matches-ledger', () => ({ ok: false }))).toBe(true);
    expect(f.probe('Bad Id', () => ({ ok: true }))).toBe(false);
    expect(f.probe('x', 'not a function' as any)).toBe(false);
    expect(f.start({ manifest: manifestData(), store, checkEveryMs: 0 })).toBe(true);
    for (let i = 0; i < 50 && !(await store.probes()).length; i++) await new Promise((r) => setTimeout(r, 10));
    await f.flush();
    const r = (await f.checkNow())!;
    expect(r.probes).toMatchObject([{ id: 'pool-matches-ledger', state: 'broken', reason: 'returned' }]);
  });
});

describe('flight.step (B1)', () => {
  it('returns at once, never throws on bad arguments and writes through the store', async () => {
    const f = newFlight();
    const store = memoryStore();
    expect(f.step('payout', 'p1', 'requested')).toBe(false); // before start: does nothing
    f.start({ manifest: manifestData(), store, checkEveryMs: 0 });
    let added = 0;
    const slow = store.addSteps;
    store.addSteps = (s) => ((added += s.length), new Promise((r) => setTimeout(() => r(slow(s)), 50)));
    const t0 = performance.now();
    expect(f.step('payout', 'p1', 'requested')).toBe(true);
    expect(f.step('payout', 42, 'bank.sent')).toBe(true);
    for (const bad of [[], [null, 'k', 's'], ['payout', {}, 'x'], ['Payout!', 'k', 'x'], ['payout', '', 'x'], ['payout', 'k'.repeat(201), 'x'], ['payout', NaN, 'x']] as any[]) {
      expect(() => (f.step as any)(...bad)).not.toThrow();
      expect((f.step as any)(...bad)).toBe(false);
    }
    expect(performance.now() - t0).toBeLessThan(20);
    expect(added).toBe(0); // nothing waited for the store
    await f.flush();
    expect((await store.runSteps('payout', 0)).map((s) => `${s.key}:${s.step}`)).toEqual(['p1:requested', '42:bank.sent']);
    const m = await store.minutes(0);
    expect(m.reduce((n, x) => n + x.stepsInvalid, 0)).toBe(14);
  });

  it('counts steps dropped per process when the bounded buffer is full, and writes the counts to the store', async () => {
    const store = memoryStore();
    const w = createStepWriter({ store, instance: 'i1', bufferSize: 2 });
    for (let i = 0; i < 5; i++) w.step('payout', `k${i}`, 'requested');
    w.step('refund', 'r1', 'requested');
    expect(w.stats()).toMatchObject({ accepted: 2, dropped: 4, queued: 2 });
    await w.flush();
    const m = await store.minutes(0);
    expect(m.reduce((n, x) => n + (x.stepsDropped.payout || 0), 0)).toBe(3);
    expect(m.reduce((n, x) => n + (x.stepsDropped.refund || 0), 0)).toBe(1);
    expect(await store.runSteps('payout', 0)).toHaveLength(2);
  });

  it('counts a batch the store refuses as dropped for its process, and the store error', async () => {
    const store = memoryStore();
    const failing = { ...store, addSteps: async () => Promise.reject(new Error('down')) };
    const w = createStepWriter({ store: failing, instance: 'i1' });
    w.step('payout', 'k1', 'requested');
    w.step('payout', 'k2', 'requested');
    await w.flush();
    const m = await store.minutes(0);
    expect(m.reduce((n, x) => n + (x.stepsDropped.payout || 0), 0)).toBe(2);
    expect(m.reduce((n, x) => n + x.storeErrors, 0)).toBe(1);
    expect(w.stats()).toMatchObject({ dropped: 2, storeErrors: 1, written: 0 });
  });
});

describe('one checker at a time (B4)', () => {
  it('of two checkers on one store, only the one holding the lock runs a pass', async () => {
    const store = memoryStore();
    const a = newFlight();
    const b = newFlight();
    a.start({ manifest: manifestData(), store, checkEveryMs: 0 });
    b.start({ manifest: manifestData(), store, checkEveryMs: 0 });
    expect(await a.checkNow()).not.toBeNull();
    expect(await b.checkNow()).toBeNull();
    expect(await a.checkNow()).not.toBeNull();
    a.stop(); // gives the lock up
    await new Promise((r) => setTimeout(r, 20));
    expect(await b.checkNow()).not.toBeNull();
  });

  it('a lock left by a dead checker is taken over after a bounded time (file store, two handles)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reins-flight-lock-'));
    dirs.push(dir);
    const { fileStore } = await import('../src/flight/file-store.js');
    const t = Date.now();
    expect(await fileStore({ dir }).lock('dead', 180_000, t)).toBe(true);
    expect(await fileStore({ dir }).lock('live', 180_000, t + 179_000)).toBe(false);
    expect(await fileStore({ dir }).lock('live', 180_000, t + 181_000)).toBe(true);
  });
});

describe('an invalid manifest (B10)', () => {
  it('start does not throw, the basics keep running, promise checks stop and a blind result says so', async () => {
    const f = newFlight();
    const bad = { ...manifestData(), service: 42, extra: true };
    expect(f.start({ manifest: bad, checkEveryMs: 0 })).toBe(true);
    expect(f.recorder()?.isActive()).toBe(true);
    expect(f.step('payout', 'p1', 'requested')).toBe(true);
    const r = (await f.checkNow())!;
    expect(r.manifest).toBe('invalid');
    expect(r.promises).toEqual([]);
    expect(r.blind[0]).toMatchObject({ kind: 'manifest-invalid' });
    expect((r.blind[0] as any).problems.length).toBeGreaterThan(1);
  });

  it('a manifest file that is missing or not JSON is invalid in the same way', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reins-flight-manifest-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'reins.flight.json'), '{ nope');
    for (const file of [join(dir, 'reins.flight.json'), join(dir, 'missing.json')]) {
      const f = newFlight();
      expect(f.start({ manifest: file, checkEveryMs: 0 })).toBe(true);
      expect((await f.checkNow())!.blind[0]).toMatchObject({ kind: 'manifest-invalid' });
    }
  });

  it('with strict true, start throws', () => {
    const f = newFlight();
    expect(() => f.start({ manifest: { schema: 1 }, strict: true })).toThrow(/manifest is invalid/);
    expect(f.isStarted()).toBe(false);
    expect(newFlight().start({ manifest: manifestData(), strict: true, checkEveryMs: 0 })).toBe(true);
  });

  it('with no manifest at all, only the basics run and nothing is blind', async () => {
    const f = newFlight();
    const dir = mkdtempSync(join(tmpdir(), 'reins-flight-none-'));
    dirs.push(dir);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(f.start({ checkEveryMs: 0 })).toBe(true);
    } finally {
      process.chdir(cwd);
    }
    expect(await f.checkNow()).toMatchObject({ manifest: 'none', promises: [], probes: [], blind: [] });
  });

  it('a bad store or instance option starts nothing and returns false', () => {
    expect(newFlight().start({ store: {} as any })).toBe(false);
    expect(newFlight().start({ instance: '../etc' })).toBe(false);
  });
});

describe('the checker timer', () => {
  it('runs passes on its own when checkEveryMs is set', async () => {
    const f = newFlight();
    f.start({ manifest: manifestData(), store: memoryStore(), checkEveryMs: 20 });
    for (let i = 0; i < 50 && !f.lastCheck(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(f.lastCheck()).toMatchObject({ manifest: 'ok' });
  });
});
