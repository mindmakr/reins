// One contract every flight store meets (design B2, B3, B4): memory, file and Postgres run the same cases.
import { expect, it } from 'vitest';
import { createStepWriter } from '../src/flight/steps.js';
import { type FindingRecord, type FlightStore, type InstanceMinute, MAX_LOCK_MS, type StepRecord } from '../src/flight/store.js';

const DAY = 86_400_000;

export const step = (key: string, s: string, at: number, process = 'payout', instance = 'i1'): StepRecord => ({ process, key, step: s, at, instance });

/** Round 3 (G3): a run removed by retention leaves one marker step; `real` leaves markers out, `marker` makes one. */
export const real = (steps: StepRecord[]) => steps.filter((s) => s.step !== '(pruned)');
export const marker = (key: string, at: number, process = 'payout'): StepRecord => ({ process, key, step: '(pruned)', at, instance: '(prune)' });

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

  it('leaves out a bad row passed straight to addSteps and stores the rest of the batch', async () => {
    const { store } = await make();
    const t = 1_000_000;
    const bad: any[] = [
      step('a\u0000b', 'requested', t), // NUL in the key
      step('lone\ud800', 'requested', t),
      step('', 'requested', t),
      step('x'.repeat(201), 'requested', t),
      step('k', 'Requested', t), // not a manifest name
      step('k', '(pruned)', t), // the reserved retention marker
      step('k', 'requested', t, 'pay out'),
      step('k', 'requested', t, 'payout', 'i\u0000'),
      step('k', 'requested', 1.5),
      step('k', 'requested', Number.NaN),
      { process: 'payout', key: 7, step: 'requested', at: t, instance: 'i1' },
      null,
    ];
    await store.addSteps([step('good1', 'requested', t), ...bad, step('good2', 'requested', t + 1)]);
    expect((await store.runSteps('payout', 0)).map((s) => s.key)).toEqual(['good1', 'good2']);
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

  it('keeps finding data that holds U+0000 or a lone surrogate, cleaned the same way in every store (u3 follow-up)', async () => {
    const { store } = await make();
    const nul = String.fromCharCode(0);
    const data = { text: `route /a${nul}b`, tags: [`x${nul}`, 'ok\ud800'], nested: { [`k${nul}`]: 'v\udc00w' }, count: 2 };
    await store.putFindings([{ key: `basic:slow-route:GET /a${nul}b`, state: 'open', updatedAt: 1000, data }]);
    expect(await store.findings()).toEqual([
      { key: 'basic:slow-route:GET /ab', state: 'open', updatedAt: 1000, data: { text: 'route /ab', tags: ['x', 'ok�'], nested: { k: 'v�w' }, count: 2 } },
    ]);
  });

  it('keeps a value with toJSON in finding data as JSON keeps it: a Date as its ISO text (u4 round 2, L5)', async () => {
    const { store } = await make();
    await store.putFindings([{ key: 'basic:x', state: 'open', updatedAt: 1000, data: { at: new Date(0), nested: [{ when: new Date(1000) }] } }]);
    expect((await store.findings())[0].data).toEqual({ at: '1970-01-01T00:00:00.000Z', nested: [{ when: '1970-01-01T00:00:01.000Z' }] });
  });

  it('keeps finding data an object when the data itself has toJSON (u4 round 3, L7)', async () => {
    const { store } = await make();
    await store.putFindings([{ key: 'basic:x', state: 'open', updatedAt: 1000, data: new Date(0) as unknown as Record<string, unknown> }]);
    expect((await store.findings())[0].data).toEqual({});
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

  it('takes over a lock at its time exactly, and a lock impossibly far ahead (planted, or a clock that runs ahead)', async () => {
    const { store, second } = await make();
    const other = second();
    const t = Date.now();
    expect(await store.lock('a', 1000, t)).toBe(true);
    expect(await other.lock('b', 1000, t + 999)).toBe(false);
    expect(await other.lock('b', 1000, t + 1000)).toBe(true); // until <= now, in every store
    // A checker whose clock runs ten years ahead takes it, then holds it impossibly far ahead of the others.
    expect(await store.lock('ahead', 60_000, t + 10 * 365 * DAY)).toBe(true);
    expect(await other.lock('b', 60_000, t + 2000)).toBe(true);
    // A lease longer than MAX_LOCK_MS is cut to it.
    expect(await store.lock('long', 100 * 365 * DAY, t + 70_000)).toBe(true);
    expect(await other.lock('b', 1000, t + 70_000 + MAX_LOCK_MS - 1)).toBe(false);
    expect(await other.lock('b', 1000, t + 70_000 + MAX_LOCK_MS)).toBe(true);
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
    expect(await store.runSteps('payout', 0)).toEqual([marker('p1', t)]);
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
    expect(real(await store.runSteps('payout', 0))).toEqual([]);
    // Another handle (a watcher) reads the count back.
    const got = (await second().minutes(0)).filter((m) => m.instance === '(prune)');
    expect(got).toHaveLength(1);
    expect(got[0].runsPruned).toEqual({ payout: 2 });
    // A second prune in the same minute adds to the count.
    await store.addSteps([step('open3', 'requested', t)]);
    await store.prune({ maxAgeMs: DAY }, t + 2 * DAY, { payout: ['ledger.debited'] });
    expect((await store.minutes(0)).find((m) => m.instance === '(prune)')!.runsPruned).toEqual({ payout: 3 });
  });

  it('prune by age removes whole runs: a run stays whole while its newest step is inside the bounds', async () => {
    const { store } = await make();
    // Pruned at a time ahead of now: the file store leaves segments written in the hour before the prune alone.
    const t = Date.now();
    await store.addSteps([
      step('long', 'requested', t), // open, last step at t + 6.5 days
      step('long', 'bank.pending', t + 6.5 * DAY),
      step('ord', 'bank.settled', t), // order: its first step is old, its then step recent
      step('ord', 'ledger.debited', t + 6.5 * DAY),
      step('old', 'requested', t), // open, wholly old
      step('oldend', 'requested', t),
      step('oldend', 'bank.failed', t + 1000),
    ]);
    await store.prune({ maxAgeMs: 7 * DAY }, t + 7 * DAY + 3_600_000, { payout: ['ledger.debited', 'bank.failed'] });
    const got = await store.runSteps('payout', 0);
    expect(got.map((s) => `${s.key}:${s.step}`).sort()).toEqual(['long:bank.pending', 'long:requested', 'old:(pruned)', 'oldend:(pruned)', 'ord:bank.settled', 'ord:ledger.debited']);
    expect((await store.minutes(0)).find((m) => m.instance === '(prune)')!.runsPruned).toEqual({ payout: 1 });
  });

  it('prune by count removes whole runs, oldest first, and counts the open ones', async () => {
    const { store, second } = await make();
    const t = Date.now();
    // Ten runs of three steps; the even ones reached an end step.
    await store.addSteps(Array.from({ length: 10 }, (_, i) => [step(`r${i}`, 'requested', t + i), step(`r${i}`, 'bank.sent', t + i), step(`r${i}`, i % 2 ? 'bank.pending' : 'ledger.debited', t + i)]).flat());
    // Another handle prunes, two hours on (the file store leaves segments written in the last hour alone).
    await second().prune({ maxSteps: 10 }, t + 2 * 3_600_000, { payout: ['ledger.debited'] });
    const got = real(await store.runSteps('payout', 0));
    expect(got.length).toBeLessThanOrEqual(10);
    const left = new Map<string, number>();
    for (const s of got) left.set(s.key, (left.get(s.key) || 0) + 1);
    for (const n of left.values()) expect(n).toBe(3);
    const removedOpen = Array.from({ length: 10 }, (_, i) => i).filter((i) => i % 2 && !left.has(`r${i}`)).length;
    expect(removedOpen).toBeGreaterThan(0);
    expect((await store.minutes(0)).find((m) => m.instance === '(prune)')!.runsPruned).toEqual({ payout: removedOpen });
    // What is left is the newest runs.
    const kept = [...left.keys()].map((k) => Number(k.slice(1))).sort((a, b) => a - b);
    expect(kept).toEqual(kept.length ? Array.from({ length: kept.length }, (_, i) => 10 - kept.length + i) : []);
    // Each removed run left one marker at its newest step's time.
    const marks = (await store.runSteps('payout', 0)).filter((s) => s.step === '(pruned)');
    expect(marks.map((s) => s.key).sort()).toEqual(Array.from({ length: 10 - kept.length }, (_, i) => `r${i}`).sort());
    for (const m of marks) expect(m.at).toBe(t + Number(m.key.slice(1)));
  });

  it('a removed run leaves a marker, so a later step for its key joins a run known to be partial; markers go after twice the age', async () => {
    const { store } = await make();
    const t = Date.now();
    const ends = { payout: ['ledger.debited'] };
    await store.addSteps([step('p1', 'bank.settled', t), step('p1', 'ledger.debited', t + 1000), step('keep', 'requested', t + 7 * DAY)]);
    await store.prune({ maxAgeMs: 7 * DAY }, t + 8 * DAY, ends);
    expect(await store.runSteps('payout', 0)).toEqual([marker('p1', t + 1000), step('keep', 'requested', t + 7 * DAY)]);
    // A second debit of p1 arrives after p1 was removed: it joins the marker, not a fresh run.
    await store.addSteps([step('p1', 'ledger.debited', t + 8 * DAY)]);
    expect(await store.runSteps('payout', t + 7.5 * DAY)).toEqual([marker('p1', t + 1000), step('p1', 'ledger.debited', t + 8 * DAY)]);
    // The marker inside a run that has real steps stays while they do; keep (open) goes and is counted once.
    await store.prune({ maxAgeMs: 7 * DAY }, t + 14 * DAY + 2000, ends);
    expect(await store.runSteps('payout', 0)).toEqual([marker('p1', t + 1000), marker('keep', t + 7 * DAY), step('p1', 'ledger.debited', t + 8 * DAY)]);
    // Past twice the age bound nothing is left; p1, partial and open, is not counted as overdue again.
    const pruned = (since: number) => store.minutes(since).then((ms) => ms.filter((m) => m.instance === '(prune)').reduce((n, m) => n + (m.runsPruned?.payout || 0), 0));
    expect(await pruned(0)).toBe(1);
    await store.prune({ maxAgeMs: 7 * DAY }, t + 30 * DAY, ends);
    expect(await store.runSteps('payout', 0)).toEqual([]);
    expect(await pruned(t + 29 * DAY)).toBe(0);
  });

  it('the cap on steps leaves markers for the runs it removes, and keeps at most maxSteps runs that hold only a marker', async () => {
    const { store } = await make();
    const t = Date.now();
    await store.addSteps(Array.from({ length: 6 }, (_, i) => step(`r${i}`, 'requested', t + i)));
    await store.prune({ maxSteps: 2 }, t + 2 * 3_600_000);
    expect(await store.runSteps('payout', 0)).toEqual([marker('r2', t + 2), marker('r3', t + 3), step('r4', 'requested', t + 4), step('r5', 'requested', t + 5)]);
    // r0 and r1 were left with no marker by the count bound on markers: counted, so the checker can say so.
    const rec = (await store.minutes(0)).find((m) => m.instance === '(prune)');
    expect(rec?.markersDropped).toEqual({ payout: 2 });
    // A second prune drops the marker-only runs past the bound again: r2 goes, and the count adds up.
    await store.addSteps([step('r6', 'requested', t + 6)]);
    await store.prune({ maxSteps: 2 }, t + 2 * 3_600_000);
    const all = (await store.minutes(0)).filter((m) => m.instance === '(prune)');
    expect(all.reduce((n, m) => n + (m.markersDropped?.payout || 0), 0)).toBe(3);
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
