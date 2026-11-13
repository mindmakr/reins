// One contract every flight store meets (design B2, B3, B4): memory, file and Postgres run the same cases.
import { expect, it } from 'vitest';
import { createStepWriter } from '../src/flight/steps.js';
import type { FindingRecord, FlightStore, InstanceMinute, StepRecord } from '../src/flight/store.js';

const DAY = 86_400_000;

export const step = (key: string, s: string, at: number, process = 'payout', instance = 'i1'): StepRecord => ({ process, key, step: s, at, instance });

export const minute = (instance: string, at: number, extra: Partial<InstanceMinute> = {}): InstanceMinute => ({
  instance,
  minute: at - (at % 60_000),
  basics: null,
  stepsDropped: {},
  stepsInvalid: 0,
  storeErrors: 0,
  probes: [],
  ...extra,
});

/** Registers the contract cases. `make` gives a fresh, empty store; `second` a second handle on the same data. */
export function storeContract(make: () => Promise<{ store: FlightStore; second: () => FlightStore }>) {
  it('keeps every step of each run with a step in the window, before the window and after the end, in order', async () => {
    const { store } = await make();
    const t = Date.now() - 10 * DAY;
    await store.addSteps([
      step('old', 'requested', t),
      step('old', 'ledger.debited', t + 1000),
      step('p1', 'requested', t),
      step('p1', 'bank.settled', t + 5 * DAY),
      step('other', 'requested', t + 5 * DAY, 'refund'),
    ]);
    // A step recorded after the run ended belongs to that same run (C18), and equal times keep the order written.
    await store.addSteps([step('p1', 'ledger.debited', t + 9 * DAY), step('p1', 'ledger.debited', t + 9 * DAY), step('p2', 'requested', t + 9 * DAY)]);
    const since = t + 4 * DAY;
    const got = await store.runSteps('payout', since);
    expect(got.map((s) => `${s.key}:${s.step}`)).toEqual(['p1:requested', 'p1:bank.settled', 'p1:ledger.debited', 'p1:ledger.debited', 'p2:requested']);
    expect(got[0]).toEqual(step('p1', 'requested', t));
    expect(await store.runSteps('refund', since)).toEqual([step('other', 'requested', t + 5 * DAY, 'refund')]);
    expect(await store.runSteps('payout', t + 20 * DAY)).toEqual([]);
  });

  it('passes names and keys through as data, whatever characters they hold', async () => {
    const { store } = await make();
    const odd = `x'); drop table reins_flight_steps; -- "\\ $1 ${'%'}`;
    await store.addSteps([step(odd, 'bank.sent', 1_000_000)]);
    expect(await store.runSteps('payout', 0)).toEqual([step(odd, 'bank.sent', 1_000_000)]);
  });

  it('refuses keys with a control character or a lone surrogate before the store, and keeps every good key as given', async () => {
    const { store } = await make();
    const w = createStepWriter({ store, instance: 'i1' });
    const bad = ['a\u0000b', 'tab\there', 'nl\n', 'del\u007f', 'hi\ud800', '\udc00lo', 'x\udc00\ud800y'];
    const good = ['plain', 'pair-😀', 'é ü 中', `q'"\\%`];
    for (let i = 0; i < 101; i++) w.step('payout', `k${i}`, 'requested');
    for (const k of bad) expect(w.step('payout', k, 'requested')).toBe(false);
    for (const k of good) expect(w.step('payout', k, 'requested')).toBe(true);
    await w.flush();
    expect(w.stats()).toMatchObject({ invalid: bad.length, dropped: 0, storeErrors: 0, written: 101 + good.length });
    const keys = new Set((await store.runSteps('payout', 0)).map((s) => s.key));
    expect(keys.size).toBe(101 + good.length);
    for (const k of good) expect(keys.has(k)).toBe(true);
  });

  it('keeps one record per instance and minute, the last write winning', async () => {
    const { store } = await make();
    const t = Date.now();
    await store.putMinute(minute('a', t, { stepsDropped: { payout: 1 } }));
    await store.putMinute(minute('a', t, { stepsDropped: { payout: 4 }, probes: ['pool'] }));
    await store.putMinute(minute('b', t));
    await store.putMinute(minute('a', t - 3_600_000));
    const got = await store.minutes(t - 60_000);
    expect(got).toHaveLength(2);
    expect(got.find((m) => m.instance === 'a')).toEqual(minute('a', t, { stepsDropped: { payout: 4 }, probes: ['pool'] }));
    expect(await store.minutes(t - 2 * 3_600_000)).toHaveLength(3);
  });

  it('keeps the latest result of each probe', async () => {
    const { store } = await make();
    await store.putProbe({ id: 'pool', instance: 'a', at: 2000, ok: false, reason: 'threw', ms: 5 });
    await store.putProbe({ id: 'pool', instance: 'b', at: 1000, ok: true, ms: 5 });
    await store.putProbe({ id: 'cash', instance: 'b', at: 1500, ok: true, ms: 7 });
    const got = (await store.probes()).sort((a, b) => a.id.localeCompare(b.id));
    expect(got).toEqual([
      { id: 'cash', instance: 'b', at: 1500, ok: true, ms: 7 },
      { id: 'pool', instance: 'a', at: 2000, ok: false, reason: 'threw', ms: 5 },
    ]);
  });

  it('holds findings with their state, one per key', async () => {
    const { store } = await make();
    const f = (key: string, state: FindingRecord['state'], updatedAt: number): FindingRecord => ({ key, state, updatedAt, data: { kind: 'broken', count: 2, text: 'two debits' } });
    await store.putFindings([f('promise:payout:one-debit', 'open', 1000), f('blind:store', 'open', 1000)]);
    await store.putFindings([f('promise:payout:one-debit', 'resolved', 2000)]);
    const got = (await store.findings()).sort((a, b) => a.key.localeCompare(b.key));
    expect(got).toEqual([f('blind:store', 'open', 1000), f('promise:payout:one-debit', 'resolved', 2000)]);
  });

  it('gives the lock to one checker at a time, and takes over a lock its checker left', async () => {
    const { store, second } = await make();
    const other = second();
    const t = Date.now();
    expect(await store.lock('a', 1000, t)).toBe(true);
    expect(await other.lock('b', 1000, t + 10)).toBe(false);
    expect(await store.lock('a', 1000, t + 500)).toBe(true); // renewed until t + 1500
    expect(await other.lock('b', 1000, t + 1200)).toBe(false);
    // Checker a died: its lock passes its time and b takes over; a cannot take it back.
    expect(await other.lock('b', 1000, t + 1600)).toBe(true);
    expect(await store.lock('a', 1000, t + 1700)).toBe(false);
    await other.unlock('a'); // not the owner: nothing happens
    expect(await store.lock('a', 1000, t + 1800)).toBe(false);
    await other.unlock('b');
    expect(await store.lock('a', 1000, t + 1900)).toBe(true);
  });

  it('of many checkers racing for a free lock, exactly one wins', async () => {
    const { store, second } = await make();
    const t = Date.now();
    const handles = [store, second(), second(), second()];
    const won = await Promise.all(handles.map((h, i) => h.lock(`c${i}`, 60_000, t)));
    expect(won.filter(Boolean)).toHaveLength(1);
  });

  it('prunes by age: old steps, minutes, probe results and resolved findings go, open findings stay', async () => {
    const { store } = await make();
    const t = Date.now();
    await store.addSteps([step('p1', 'requested', t)]);
    await store.putMinute(minute('a', t));
    await store.putProbe({ id: 'pool', instance: 'a', at: t, ok: true, ms: 1 });
    await store.putFindings([
      { key: 'open-one', state: 'open', updatedAt: t, data: {} },
      { key: 'done', state: 'resolved', updatedAt: t, data: {} },
    ]);
    await store.prune({ maxAgeMs: DAY }, t + 2 * DAY);
    expect(await store.runSteps('payout', 0)).toEqual([]);
    expect(await store.minutes(0)).toEqual([]);
    expect(await store.probes()).toEqual([]);
    expect((await store.findings()).map((f) => f.key)).toEqual(['open-one']);
  });

  it('lists every step of the open runs of any age, and none of a run that reached an end step', async () => {
    const { store } = await make();
    const t = Date.now() - 30 * DAY;
    await store.addSteps([
      step('stuck', 'requested', t),
      step('stuck', 'bank.pending', t + 1000),
      step('done', 'requested', t),
      step('done', 'bank.failed', t + 2000),
      step('done', 'bank.sent', t + 3000), // after the end: still the same, ended run
      step('r1', 'requested', t, 'refund'),
    ]);
    await store.addSteps([step('fresh', 'requested', Date.now())]);
    const got = await store.openRuns('payout', ['ledger.debited', 'bank.failed']);
    expect(got.map((s) => `${s.key}:${s.step}`)).toEqual(['stuck:requested', 'stuck:bank.pending', 'fresh:requested']);
    expect(got[0]).toEqual(step('stuck', 'requested', t));
    expect(await store.openRuns('payout', [])).toHaveLength(6);
  });

  it('prune counts the runs it removes while they had reached no end step, in the store', async () => {
    const { store, second } = await make();
    const t = Date.now();
    await store.addSteps([
      step('open1', 'requested', t),
      step('open2', 'bank.pending', t),
      step('ended', 'requested', t),
      step('ended', 'ledger.debited', t),
      step('r1', 'requested', t, 'refund'), // a process not named: not counted
    ]);
    await store.prune({ maxAgeMs: DAY }, t + 2 * DAY, { payout: ['ledger.debited', 'bank.failed'] });
    expect(await store.runSteps('payout', 0)).toEqual([]);
    // Another handle (a watcher) reads the count back.
    const got = (await second().minutes(0)).filter((m) => m.instance === '(prune)');
    expect(got).toHaveLength(1);
    expect(got[0].runsPruned).toEqual({ payout: 2 });
    // A second prune in the same minute adds to the count.
    await store.addSteps([step('open3', 'requested', t)]);
    await store.prune({ maxAgeMs: DAY }, t + 2 * DAY, { payout: ['ledger.debited'] });
    expect((await store.minutes(0)).find((m) => m.instance === '(prune)')!.runsPruned).toEqual({ payout: 3 });
  });

  it('prune without end steps writes no count', async () => {
    const { store } = await make();
    const t = Date.now();
    await store.addSteps([step('open1', 'requested', t)]);
    await store.prune({ maxAgeMs: DAY }, t + 2 * DAY);
    expect(await store.minutes(0)).toEqual([]);
  });

  it('prune keeps what is inside the bounds', async () => {
    const { store } = await make();
    const t = Date.now();
    await store.addSteps([step('p1', 'requested', t)]);
    await store.putMinute(minute('a', t));
    await store.prune({}, t + 1000);
    expect(await store.runSteps('payout', 0)).toHaveLength(1);
    expect(await store.minutes(0)).toHaveLength(1);
  });
}

export { DAY };
