// Design section 5, unit u4 behaviours B1 to B7 and B12: findings of the five kinds, from a checker pass and the
// instance minutes, opening and resolving as section 5 states, with limits in one place and their sources.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, type CheckResult } from '../src/flight/checker.js';
import { evaluate, type EvaluateResult, type FindingsMemory, type FlightFinding, KIND_ORDER } from '../src/flight/findings.js';
import { BASICS, DEFAULT_BASICS, LIMITS, SINK_LIMITS } from '../src/flight/limits.js';
import { BASIC_NAMES, type ManifestResult, readManifest, validateManifest } from '../src/flight/manifest.js';
import { CHECKS, SOURCES } from '../src/flight/sources.js';
import { type FlightStore, type InstanceMinute, memoryStore } from '../src/flight/store.js';
import { type Figures, LATENCY_BOUNDS } from '../src/recorder.js';
import { fig, im, MIN } from './flight-fixtures.js';
import { step } from './flight-store-contract.js';

const H = 60 * MIN;
const DAY = 24 * H;
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

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
      retries: { 'bank.sent': 1 },
      promises: [
        { id: 'pending-settles', kind: 'within', after: 'bank.pending', expect: ['bank.settled', 'bank.failed'], within: '4h', why: 'A stuck transfer is money owed.' },
        { id: 'one-debit', kind: 'once', step: 'ledger.debited' },
      ],
    },
  ],
  probes: [],
  ...extra,
});
const manifest = (extra?: Record<string, unknown>): ManifestResult => {
  const r = validateManifest(manifestData(extra));
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r;
};


/** A checker pass and the findings step over it, as the server runs them. */
async function pass(store: FlightStore, m: ManifestResult | null, now: number, prior: FlightFinding[] = [], memory: FindingsMemory = {}): Promise<EvaluateResult & { check: CheckResult }> {
  let minutes: InstanceMinute[] | null = null;
  const c = await check(store, m, { now, minutes: (x) => (minutes = x) });
  return { ...evaluate({ check: c, minutes, manifest: m, prior, memory, now }), check: c };
}
async function storeWith(minutes: InstanceMinute[] = [], steps: Array<[string, string, number]> = []): Promise<FlightStore> {
  const s = memoryStore();
  for (const x of minutes) await s.putMinute(x);
  if (steps.length) await s.addSteps(steps.map(([key, name, at]) => step(key, name, at)));
  return s;
}
const open = (r: { findings: FlightFinding[] }) => r.findings.filter((f) => f.state === 'open');
const byKey = (r: { findings: FlightFinding[] }, key: string) => r.findings.find((f) => f.key === key);
const keys = (r: { findings: FlightFinding[] }) => open(r).map((f) => f.key).sort();
/** Minutes `n` minutes back from now, newest last. */
const back = (n: number) => NOW - n * MIN;

describe('B1: the finding', () => {
  it('has key, kind, level, text, count, firstAt, lastAt, state and a source; one per key; repeats raise count', async () => {
    const store = await storeWith([im('a', back(1), { requests: [['GET', '/api/x', fig(40, 4)]] })]);
    const one = await pass(store, null, NOW);
    const f = byKey(one, 'basic:error-share')!;
    expect(f).toMatchObject({ key: 'basic:error-share', kind: 'basic', level: 'error', count: 4, firstAt: NOW, lastAt: NOW, state: 'open' });
    expect(f.text).toBe('10% of requests failed in the last 5 min (4 of 40), over the limit of 5%.');
    expect(f.source).toMatch(/Site Reliability Engineering.*read 2026-11-14; the limit's number is reins' own choice/);
    expect(one.changes.map((c) => [c.event, c.finding.key])).toEqual([['opened', 'basic:error-share']]);

    // More failures later: still one finding for the key, its count raised, firstAt kept.
    await store.putMinute(im('a', NOW + MIN, { requests: [['GET', '/api/x', fig(40, 4)]] }));
    const two = await pass(store, null, NOW + 2 * MIN, one.findings, one.memory);
    expect(two.findings.filter((x) => x.key === 'basic:error-share')).toHaveLength(1);
    expect(byKey(two, 'basic:error-share')).toMatchObject({ count: 8, firstAt: NOW, lastAt: NOW + 2 * MIN, state: 'open' });
    expect(two.changes).toEqual([]);
  });

  it('a finding with no figure counts the passes that saw it', async () => {
    const blocked = [3, 2, 1].map((n) => im('a', back(n), { loopP99: 400 }));
    const store = await storeWith(blocked);
    let r = await pass(store, null, NOW);
    expect(byKey(r, 'basic:event-loop')?.count).toBe(1);
    r = await pass(store, null, NOW + 1000, r.findings, r.memory);
    r = await pass(store, null, NOW + 2000, r.findings, r.memory);
    expect(byKey(r, 'basic:event-loop')?.count).toBe(3);
  });

  it('is the report Finding (key, level, text) with the fields section 5 adds, in kind order', async () => {
    expect(KIND_ORDER).toEqual(['blind', 'basic', 'broken', 'drifting', 'unusual']);
    const store = await storeWith([im('a', back(1), { requests: [['GET', '/x', fig(40, 4)]], upstream: [['GET', 'other.example.com', fig(2)]] })], [['p1', 'bank.pending', NOW - 5 * H]]);
    const r = await pass(store, manifest(), NOW);
    expect(open(r).map((f) => f.kind)).toEqual(['basic', 'broken', 'unusual']);
  });
});

describe('B2: the six basics, with the framework hook and no manifest', () => {
  it('failed-request share, slow route, failing upstream, blocked loop, growing memory and refused spike', async () => {
    const minutes: InstanceMinute[] = [];
    // Memory: 31 minutes of a heap rising from 100 MB to 250 MB; the hour before that, a few refused responses.
    for (let n = 60; n >= 35; n--) minutes.push(im('a', back(n), { requests: [['POST', '/login', fig(10, 0, 20, { '401': 1 })]] }));
    for (let n = 30; n >= 6; n--) minutes.push(im('a', back(n), { heapMb: 100 + (30 - n) * 5 }));
    for (let n = 5; n >= 1; n--)
      minutes.push(
        im('a', back(n), {
          heapMb: 100 + (30 - n) * 5,
          loopP99: 350,
          requests: [
            ['GET', '/api/ok', fig(20, 3)],
            ['GET', '/api/slow', fig(10, 0, 2000)],
            ['POST', '/login', fig(12, 0, 20, { '401': 10, '429': 2 })],
          ],
          upstream: [['POST', 'bank.example.com', fig(4, 2)]],
        }),
      );
    const r = await pass(await storeWith(minutes), null, NOW);
    expect(keys(r)).toEqual(['basic:error-share', 'basic:event-loop', 'basic:memory', 'basic:refused', 'basic:slow-route:GET /api/slow', 'basic:upstream:bank.example.com']);
    expect(byKey(r, 'basic:slow-route:GET /api/slow')!.text).toBe('GET /api/slow is slow: 50 of its 50 requests in the last 5 min (100%) took longer than 800 ms, so its 95th percentile is over that limit.');
    expect(byKey(r, 'basic:upstream:bank.example.com')!.text).toMatch(/^Upstream bank.example.com is failing: 10 of 20 calls in the last 5 min failed \(50%\)/);
    expect(byKey(r, 'basic:event-loop')!.text).toMatch(/blocked on 1 instance: its 99th percentile delay was over 200 ms in 5 minutes/);
    expect(byKey(r, 'basic:memory')!.text).toMatch(/^Memory keeps growing on 1 instance/);
    expect(byKey(r, 'basic:refused')).toMatchObject({ tags: ['security'], count: 60 });
    expect(byKey(r, 'basic:refused')!.text).toMatch(/60 with status 401, 403 or 429 in the last 5 min \(401: 50, 429: 10\), against about 3 in the same time over the hour before/);
    for (const f of open(r)) expect(f.source).toMatch(/read 2026-11-14/);
  });

  it('a steady heap, a quiet loop and refused responses at their usual rate give nothing', async () => {
    const minutes: InstanceMinute[] = [];
    for (let n = 60; n >= 1; n--) minutes.push(im('a', back(n), { heapMb: 100 + (n % 3), requests: [['POST', '/login', fig(30, 0, 20, { '401': 5 })]] }));
    expect(keys(await pass(await storeWith(minutes), null, NOW))).toEqual([]);
  });
});

describe('B3: blind findings', () => {
  it('steps dropped, the manifest invalid, and a declared process with no steps at all', async () => {
    const store = await storeWith([im('a', back(90)), im('a', back(1), {}, { stepsDropped: { payout: 7 } })]);
    const r = await pass(store, manifest(), NOW);
    expect(keys(r)).toEqual(['blind:no-steps:payout', 'blind:steps-dropped:payout']);
    expect(byKey(r, 'blind:steps-dropped:payout')).toMatchObject({ count: 7, kind: 'blind', process: 'payout' });

    const bad = validateManifest({ schema: 1, service: 'x', processes: 'no' });
    const inv = await pass(store, bad, NOW);
    expect(byKey(inv, 'blind:manifest-invalid')).toMatchObject({ kind: 'blind', level: 'error', state: 'open' });
    expect(byKey(inv, 'blind:manifest-invalid')!.text).toMatch(/^The manifest is invalid, so no promise or probe is checked \(the basics still are\): 1 problem, the first at processes/);
  });

  it('no-steps waits until flight has been recording for a while', async () => {
    const r = await pass(await storeWith([im('a', back(10))]), manifest(), NOW);
    expect(keys(r)).toEqual([]);
  });

  it('the store unreachable', async () => {
    const store = memoryStore();
    store.minutes = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432 password=hunter2'), { code: 'ECONNREFUSED' });
    };
    const r = await pass(store, manifest(), NOW);
    expect(byKey(r, 'blind:store-unreachable')).toMatchObject({ level: 'error', text: 'The store could not be read (ECONNREFUSED), so nothing was checked.' });
    expect(JSON.stringify(r.findings)).not.toMatch(/hunter2|10\.0\.0\.1/);
  });

  it('a sink failing, handed in from the notifier', () => {
    const c: CheckResult = { at: NOW, manifest: 'none', promises: [], probes: [], blind: [] };
    const extra = [{ key: 'blind:sink:hook', kind: 'blind' as const, level: 'warn' as const, n: 3, text: 'Sink hook has failed its last 3 deliveries (timeout), so findings may not reach it.' }];
    const r = evaluate({ check: c, minutes: [], manifest: null, prior: [], memory: {}, now: NOW, extra });
    expect(byKey(r, 'blind:sink:hook')).toMatchObject({ kind: 'blind', count: 3, state: 'open' });
    // Once the sink delivers again, the notifier stops handing it in and the finding resolves.
    const later = evaluate({ check: c, minutes: [], manifest: null, prior: r.findings, memory: r.memory, now: NOW + MIN });
    expect(byKey(later, 'blind:sink:hook')).toMatchObject({ state: 'resolved', resolvedAt: NOW + MIN });
  });
});

describe('B4: unusual findings', () => {
  it('an undeclared step, an undeclared process, an upstream host not in the manifest', async () => {
    const store = await storeWith([
      im('a', back(2), { upstream: [['GET', 'bank.example.com', fig(3)], ['GET', 'pastebin.example.org', fig(2)]] }, { steps: { 'payout requested': 2, 'payout bank.retry': 1, 'refund requested': 4 } }),
    ]);
    const r = await pass(store, manifest(), NOW);
    expect(keys(r)).toEqual(['unusual:host:pastebin.example.org', 'unusual:process:refund', 'unusual:step:payout:bank.retry']);
    expect(byKey(r, 'unusual:process:refund')!.count).toBe(4);
  });

  it('a declared step that has gone silent while its process goes on', async () => {
    const minutes: InstanceMinute[] = [];
    // bank.settled came every 10 minutes for 6 hours, then stopped 3 hours ago; requested still arrives.
    for (let n = 540; n >= 180; n -= 10) minutes.push(im('a', back(n), {}, { steps: { 'payout bank.settled': 1, 'payout requested': 1 } }));
    for (let n = 170; n >= 10; n -= 10) minutes.push(im('a', back(n), {}, { steps: { 'payout requested': 1 } }));
    const r = await pass(await storeWith(minutes), manifest(), NOW);
    expect(keys(r)).toEqual(['unusual:silent:payout:bank.settled']);
    expect(byKey(r, 'unusual:silent:payout:bank.settled')!.text).toBe(
      'Step bank.settled of payout has not been recorded for 3 h, though it came about every 10 min before, while other payout steps still arrive.',
    );
  });

  it('an error code seen for the first time, and not a code seen before', async () => {
    const store = await storeWith([im('a', back(30), { codes: { ETIMEDOUT: 2 } }), im('a', back(2), { codes: { ETIMEDOUT: 1, ECONNRESET: 3 } })]);
    const r = await pass(store, null, NOW);
    expect(keys(r)).toEqual(['unusual:code:ECONNRESET']);
    expect(byKey(r, 'unusual:code:ECONNRESET')!.text).toBe('Error code ECONNRESET was seen for the first time 2 min ago (3 times since).');
    // A day later it is no longer new, and the finding resolves; ETIMEDOUT was known all along.
    const later = await pass(store, null, NOW + DAY, r.findings, r.memory);
    expect(byKey(later, 'unusual:code:ECONNRESET')!.state).toBe('resolved');
  });
});

describe('B5: drifting', () => {
  it('a promise that holds but is moving toward its limit, explained in one sentence', async () => {
    const steps: Array<[string, string, number]> = [];
    for (let i = 0; i < 20; i++) steps.push([`p${i}`, 'bank.pending', NOW - 10 * H + i * MIN], [`p${i}`, 'bank.settled', NOW - 10 * H + i * MIN + (i < 18 ? H : 3.5 * H)]);
    const r = await pass(await storeWith([im('a', back(1))], steps), manifest(), NOW);
    expect(keys(r)).toEqual(['drifting:promise:payout:pending-settles']);
    const f = byKey(r, 'drifting:promise:payout:pending-settles')!;
    expect(f.text).toBe('Promise pending-settles of payout still holds, but the slowest 5% of the 20 runs that finished in the last 24 h took 3.5 h or more, 87.5% of the 4 h allowed.');
    expect(f.text.split('. ').length).toBe(1);
    expect(f.why).toBe('A stuck transfer is money owed.');
  });

  it('a route well above its own recent baseline', async () => {
    const minutes: InstanceMinute[] = [];
    for (let n = 120; n >= 10; n--) minutes.push(im('a', back(n), { requests: [['GET', '/api/invoices', fig(10, 0, 90)]] }));
    for (let n = 4; n >= 1; n--) minutes.push(im('a', back(n), { requests: [['GET', '/api/invoices', fig(10, 0, 480)]] }));
    const r = await pass(await storeWith(minutes), null, NOW);
    expect(keys(r)).toEqual(['drifting:route:GET /api/invoices']);
    expect(byKey(r, 'drifting:route:GET /api/invoices')!.text).toBe('GET /api/invoices took up to 480 ms at the 95th percentile in the last 5 min, 5.3 times its usual 90 ms over the day before.');
  });
});

describe('B6: when findings open and resolve', () => {
  it('within counts overdue runs; a late arrival leaves the count; it resolves at zero', async () => {
    const store = await storeWith([im('a', back(1)), im('a', back(90))], [['p1', 'bank.pending', NOW - 5 * H], ['p2', 'bank.pending', NOW - 6 * H], ['p3', 'bank.pending', NOW - H]]);
    const m = manifest();
    const one = await pass(store, m, NOW);
    expect(byKey(one, 'promise:payout:pending-settles')).toMatchObject({ kind: 'broken', level: 'error', count: 2, keys: ['p2', 'p1'] });
    expect(byKey(one, 'promise:payout:pending-settles')!.text).toBe('2 runs of payout have waited more than 4 h after bank.pending for bank.settled or bank.failed (promise: pending-settles).');
    await store.addSteps([step('p2', 'bank.settled', NOW + MIN)]);
    const two = await pass(store, m, NOW + 2 * MIN, one.findings, one.memory);
    expect(byKey(two, 'promise:payout:pending-settles')).toMatchObject({ state: 'open', count: 1 });
    await store.addSteps([step('p1', 'bank.failed', NOW + 3 * MIN)]);
    const three = await pass(store, m, NOW + 4 * MIN, two.findings, two.memory);
    expect(byKey(three, 'promise:payout:pending-settles')).toMatchObject({ state: 'resolved', resolvedAt: NOW + 4 * MIN });
    expect(three.changes.find((c) => c.finding.key === 'promise:payout:pending-settles')!.event).toBe('resolved');
    // The runs that came late still show: the promise holds, but its slowest runs took longer than allowed.
    expect(byKey(three, 'drifting:promise:payout:pending-settles')!.state).toBe('open');
  });

  it('once stays open while a breaching run is inside the window, and says when the last breach was', async () => {
    const store = await storeWith([im('a', back(1)), im('a', back(90))], [['p1', 'ledger.debited', NOW - 2 * H], ['p1', 'ledger.debited', NOW - H]]);
    const m = manifest();
    const one = await pass(store, m, NOW);
    expect(byKey(one, 'promise:payout:one-debit')!.text).toBe('1 run of payout recorded ledger.debited more than once in the last 24 h; the last at 2026-11-14 11:00 UTC (promise: one-debit).');
    const still = await pass(store, m, NOW + 20 * H, one.findings, one.memory);
    expect(byKey(still, 'promise:payout:one-debit')!.state).toBe('open');
    const gone = await pass(store, m, NOW + 24 * H, still.findings, still.memory);
    expect(byKey(gone, 'promise:payout:one-debit')!.state).toBe('resolved');
  });

  it('retries stay open while a breaching run is inside the window', async () => {
    const store = await storeWith([im('a', back(1)), im('a', back(90))], [['p1', 'bank.sent', NOW - 3 * H], ['p1', 'bank.sent', NOW - 2 * H], ['p1', 'bank.sent', NOW - H]]);
    const r = await pass(store, manifest(), NOW);
    expect(byKey(r, 'promise:payout:retries:bank.sent')).toMatchObject({ state: 'open', level: 'error', count: 1 });
    const gone = await pass(store, manifest(), NOW + 24 * H, r.findings, r.memory);
    expect(byKey(gone, 'promise:payout:retries:bank.sent')!.state).toBe('resolved');
  });

  it('a promise that could not be checked keeps its finding as it was', async () => {
    const store = await storeWith([im('a', back(1)), im('a', back(90))], [['p1', 'ledger.debited', NOW - 2 * H], ['p1', 'ledger.debited', NOW - H]]);
    const m = manifest();
    const one = await pass(store, m, NOW);
    await store.putMinute(im('a', NOW + 24 * H, {}, { stepsDropped: { payout: 1 } }));
    const two = await pass(store, m, NOW + 2 * MIN + 24 * H, one.findings, one.memory);
    expect(two.check.promises.find((c) => c.id === 'one-debit')!.state).toBe('not-checked');
    expect(byKey(two, 'promise:payout:one-debit')!.state).toBe('open');
  });

  it('basics resolve when the figure is back inside the limit; a level change is a change', async () => {
    const store = await storeWith([im('a', back(1), { requests: [['GET', '/x', fig(40, 3)]] })]);
    const one = await pass(store, null, NOW);
    expect(byKey(one, 'basic:error-share')!.level).toBe('warn');
    await store.putMinute(im('a', NOW + MIN, { requests: [['GET', '/x', fig(40, 10)]] }));
    const two = await pass(store, null, NOW + 2 * MIN, one.findings, one.memory);
    expect(two.changes.map((c) => [c.event, c.from, c.finding.level])).toEqual([['changed', 'warn', 'error']]);
    await store.putMinute(im('a', NOW + 3 * MIN, { requests: [['GET', '/x', fig(1000, 0)]] }));
    const three = await pass(store, null, NOW + 4 * MIN, two.findings, two.memory);
    expect(byKey(three, 'basic:error-share')!.state).toBe('resolved');
  });

  it('figures from the instances are added before a limit applies', async () => {
    // Each instance alone has too few requests to judge (20 needed); together they have 20, 10% failed.
    const store = await storeWith([im('a', back(1), { requests: [['GET', '/x', fig(10, 2)]] }), im('b', back(1), { requests: [['GET', '/x', fig(10, 0)]] })]);
    const r = await pass(store, null, NOW);
    expect(byKey(r, 'basic:error-share')!.text).toBe('10% of requests failed in the last 5 min (2 of 20), over the limit of 5%.');
    // The 95th percentile of a route is taken over both instances' requests, not either one's.
    const slow = await storeWith([im('a', back(1), { requests: [['GET', '/y', fig(19, 0, 40)]] }), im('b', back(1), { requests: [['GET', '/y', fig(1, 0, 3000)]] })]);
    expect(keys(await pass(slow, null, NOW))).toEqual([]);
  });

  it('probes resolve when the probe returns ok again', async () => {
    const m = manifest({ probes: [{ id: 'pool', every: '15m' }] });
    const store = await storeWith([im('a', back(1), {}, { probes: ['pool'] }), im('a', back(90))]);
    await store.putProbe({ id: 'pool', instance: 'a', at: NOW - MIN, ok: false, reason: 'threw', ms: 3 });
    const one = await pass(store, m, NOW);
    expect(byKey(one, 'probe:pool')).toMatchObject({ kind: 'broken', level: 'error', text: 'Probe pool failed: it threw.' });
    await store.putProbe({ id: 'pool', instance: 'a', at: NOW + MIN, ok: true, ms: 3 });
    const two = await pass(store, m, NOW + 2 * MIN, one.findings, one.memory);
    expect(byKey(two, 'probe:pool')!.state).toBe('resolved');
  });
});

describe('B7: limits in one place, with sources', () => {
  it('every default limit has a range, a source with a read date, or is marked as reins choice', () => {
    for (const [name, l] of Object.entries(LIMITS)) {
      expect(l.value, name).toBeGreaterThanOrEqual(l.min);
      expect(l.value, name).toBeLessThanOrEqual(l.max);
      const s = SOURCES[l.source];
      expect(s.read, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (l.source === 'reins') expect(l.chosen, name).toBe(true);
      else expect(s.url, name).toBeTruthy();
    }
    for (const [id, c] of Object.entries(CHECKS)) expect(SOURCES[c.source], id).toBeTruthy();
    expect(Object.keys(LIMITS).sort()).toEqual([...Object.keys(BASICS), ...Object.keys(SINK_LIMITS)].sort());
    expect(DEFAULT_BASICS.errorShare).toBe(BASICS.errorShare.value);
  });

  it('the manifest basics field overrides the defaults, and accepts every basic limit and no other', async () => {
    expect(BASIC_NAMES.sort()).toEqual(Object.keys(BASICS).sort());
    const store = await storeWith([im('a', back(1), { requests: [['GET', '/x', fig(100, 3)]] })]);
    expect(keys(await pass(store, null, NOW))).toEqual([]);
    const strict = await pass(store, manifest({ basics: { errorShare: 0.02 } }), NOW);
    expect(byKey(strict, 'basic:error-share')!.text).toBe('3% of requests failed in the last 5 min (3 of 100), over the limit of 2%.');
    expect(validateManifest(manifestData({ basics: { slowRouteMs: 0 } })).ok).toBe(false);
    expect(validateManifest(manifestData({ basics: { notifyPerHour: 3 } })).ok).toBe(false);
  });
});

describe('B12: security findings', () => {
  it('development reins loaded in a production process is a finding tagged security', async () => {
    const store = await storeWith([im('a', back(1), {}, { devModule: true })]);
    const r = await pass(store, null, NOW);
    expect(byKey(r, 'security:dev-module')).toMatchObject({ kind: 'unusual', level: 'error', tags: ['security'], state: 'open' });
  });
});

describe("round 2: the critics' findings on the rules", () => {
  /** Figures of a route: `fast` requests at `fastMs` and `slow` at `slowMs`, in their latency buckets. */
  const mixed = (fast: number, fastMs: number, slow: number, slowMs: number): Figures => {
    const f = fig(fast, 0, fastMs);
    f.buckets![LATENCY_BOUNDS.findIndex((x) => slowMs <= x)] += slow;
    return { ...f, count: fast + slow, maxMs: slowMs, p95Ms: slowMs };
  };
  const only = (minutes: InstanceMinute[], m: ManifestResult | null = null, prior: FlightFinding[] = [], extra: Parameters<typeof evaluate>[0]['extra'] = []) =>
    evaluate({ check: { at: NOW, manifest: !m ? 'none' : m.ok ? 'ok' : 'invalid', promises: [], probes: [], blind: m && !m.ok ? [{ kind: 'manifest-invalid', problems: m.problems }] : [] }, minutes, manifest: m, prior, memory: {}, now: NOW, extra });
  const openFinding = (key: string, over: Partial<FlightFinding> = {}): FlightFinding => ({ key, kind: 'blind', level: 'warn', text: key, count: 1, firstAt: NOW - H, lastAt: NOW - H, state: 'open', ...over });

  it('M1: a slow route is judged on the requests surely over the limit, never on a bucket bound', () => {
    // 95 requests at 600 ms and 5 at 2 s: the 95th percentile is 600 ms, under the 800 ms limit.
    expect(keys(only([im('a', back(1), { requests: [['GET', '/x', mixed(95, 600, 5, 2000)]] })]))).toEqual([]);
    // 10 of 100 over the limit: slow, and the text says what was measured.
    const r = only([im('a', back(1), { requests: [['GET', '/x', mixed(90, 600, 10, 900)]] })]);
    expect(byKey(r, 'basic:slow-route:GET /x')).toMatchObject({ level: 'warn', count: 100 });
    expect(byKey(r, 'basic:slow-route:GET /x')!.text).toBe('GET /x is slow: 10 of its 100 requests in the last 5 min (10%) took longer than 800 ms, so its 95th percentile is over that limit.');
    // An error only when more than 5% surely took twice the limit.
    expect(byKey(only([im('a', back(1), { requests: [['GET', '/x', mixed(90, 600, 10, 2000)]] })]), 'basic:slow-route:GET /x')!.level).toBe('error');
    // A limit between two bucket bounds is judged on the requests surely over it, and the text says "at least".
    const custom = only([im('a', back(1), { requests: [['GET', '/x', mixed(80, 600, 20, 900)]] })], manifest({ basics: { slowRouteMs: 700 } }));
    expect(byKey(custom, 'basic:slow-route:GET /x')!.text).toMatch(/^GET \/x is slow: at least 20 of its 100 requests in the last 5 min \(20%\) took longer than 700 ms/);
  });

  it('M4: a store-sized list of minutes stops no rule: open findings stay open and sink health still counts', () => {
    const one = { instance: 'a', minute: back(120), stepsDropped: {}, stepsInvalid: 0, storeErrors: 0, probes: [] } as unknown as InstanceMinute;
    const minutes = new Array<InstanceMinute>(200_000).fill(one);
    const sink = { key: 'blind:sink:hook', kind: 'blind' as const, level: 'warn' as const, n: 3, text: 'Sink hook has failed its last 3 deliveries (timeout), so findings may not reach it.' };
    const r = only(minutes, manifest(), [openFinding('blind:no-steps:payout', { process: 'payout' })], [sink]);
    expect(byKey(r, 'blind:no-steps:payout')!.state).toBe('open');
    expect(byKey(r, 'blind:sink:hook')!.state).toBe('open');
  });

  it('L3: with an invalid manifest, blind findings about processes are not judged, so they stay as they were', () => {
    const bad = validateManifest({ schema: 1, service: 'x', processes: 'no' });
    const prior = [openFinding('blind:no-steps:payout'), openFinding('blind:steps-dropped:payout'), openFinding('blind:store-write-failed')];
    const r = only([im('a', back(1))], bad, prior);
    expect(byKey(r, 'blind:no-steps:payout')!.state).toBe('open');
    expect(byKey(r, 'blind:steps-dropped:payout')!.state).toBe('open');
    // The store's own write failures are judged without a manifest.
    expect(byKey(r, 'blind:store-write-failed')!.state).toBe('resolved');
  });

  it('L6: the level multiplier, the memory test minutes and spread, and the refused look-back are limits', async () => {
    for (const k of ['errorFactor', 'heapMinutes', 'heapSpread', 'refusedLookbackMs']) expect(BASICS, k).toHaveProperty(k);
    // 10% failed is twice the 5% limit: an error by default, a warning when the error level is three times the limit.
    const minutes = [im('a', back(1), { requests: [['GET', '/x', fig(40, 4)]] })];
    expect(byKey(only(minutes), 'basic:error-share')!.level).toBe('error');
    expect(byKey(only(minutes, manifest({ basics: { errorFactor: 3 } })), 'basic:error-share')!.level).toBe('warn');
  });

  it('S2: an unreadable manifest file is named by its base name only', () => {
    const r = readManifest(join(tmpdir(), 'some-private-dir', 'reins.flight.json'));
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    expect(text).toContain('reins.flight.json: no such file');
    expect(text).not.toContain('some-private-dir');
  });
});

describe("round 3: the critics' findings on the rules", () => {
  const only = (minutes: InstanceMinute[], m: ManifestResult | null = null) =>
    evaluate({ check: { at: NOW, manifest: m ? 'ok' : 'none', promises: [], probes: [], blind: [] }, minutes, manifest: m, prior: [], memory: {}, now: NOW });
  /** Figures of `count` requests at `ms`, with the exact counts over `limits` that the recorder keeps for flight's own limits. */
  const exact = (count: number, ms: number, limits: number[]): Figures => ({ ...fig(count, 0, ms), over: Object.fromEntries(limits.map((l) => [String(l), ms > l ? count : 0])) });
  const basicsAndDrift = (r: { findings: FlightFinding[] }) => keys(r).filter((k) => /^(basic|drifting):/.test(k));

  it.each([
    [1200, 1500, '1.2 s'],
    [300, 450, '300 ms'],
    [900, 990, '900 ms'],
  ])('M2: a slowRouteMs of %i ms between two bucket bounds is judged on the exact count over it (every request at %i ms)', (limit, ms, said) => {
    const r = only([im('a', back(1), { requests: [['GET', '/x', exact(100, ms, [limit, 2 * limit])]] })], manifest({ basics: { slowRouteMs: limit } }));
    expect(byKey(r, 'basic:slow-route:GET /x')).toMatchObject({ level: 'warn', state: 'open' });
    expect(byKey(r, 'basic:slow-route:GET /x')!.text).toBe(`GET /x is slow: 100 of its 100 requests in the last 5 min (100%) took longer than ${said}, so its 95th percentile is over that limit.`);
  });

  it('M2: the error level between two bucket bounds is judged on the exact count over it too', () => {
    const r = only([im('a', back(1), { requests: [['GET', '/x', exact(100, 650, [300, 600])]] })], manifest({ basics: { slowRouteMs: 300 } }));
    expect(byKey(r, 'basic:slow-route:GET /x')!.level).toBe('error');
  });

  it('M2: a minute without the exact counts (an older release) still counts its whole buckets, and the text says "at least"', () => {
    const r = only(
      [im('a', back(2), { requests: [['GET', '/x', exact(50, 1500, [1200, 2400])]] }), im('b', back(1), { requests: [['GET', '/x', fig(50, 0, 1500)]] })],
      manifest({ basics: { slowRouteMs: 1200 } }),
    );
    expect(byKey(r, 'basic:slow-route:GET /x')!.text).toMatch(/^GET \/x is slow: at least 50 of its 100 requests/);
  });

  it('L5: a route over the limit but not surely slow gets no drifting finding either', () => {
    const minutes: InstanceMinute[] = [];
    for (let n = 120; n >= 10; n--) minutes.push(im('a', back(n), { requests: [['GET', '/x', fig(10, 0, 90)]] }));
    for (let n = 4; n >= 1; n--) minutes.push(im('a', back(n), { requests: [['GET', '/x', fig(10, 0, 480)]] }));
    expect(basicsAndDrift(only(minutes))).toEqual(['drifting:route:GET /x']);
    expect(basicsAndDrift(only(minutes, manifest({ basics: { slowRouteMs: 400 } })))).toEqual([]);
  });

  it('round 4 L2: a route whose exact count says it is not slow still drifts, although its bucket p95 is over the limit', () => {
    const minutes: InstanceMinute[] = [];
    for (let n = 120; n >= 10; n--) minutes.push(im('a', back(n), { requests: [['GET', '/x', fig(10, 0, 90)]] }));
    // Limit 900 ms: 96 requests at 850 ms and 4 at 950 ms, counted exactly (4 of 100 over it: not slow), in one bucket up to 1 s.
    const a = fig(96, 0, 850);
    const b = fig(4, 0, 950);
    const mixed: Figures = { ...a, count: 100, p95Ms: 950, maxMs: 950, buckets: a.buckets!.map((x, i) => x + b.buckets![i]), over: { '900': 4, '1800': 0 } };
    minutes.push(im('a', back(1), { requests: [['GET', '/x', mixed]] }));
    expect(basicsAndDrift(only(minutes, manifest({ basics: { slowRouteMs: 900 } })))).toEqual(['drifting:route:GET /x']);
  });
});

describe('B9: a broken promise says when it first and last happened, in that order', () => {
  it('a within finding opened now over runs that became overdue earlier has firstAt at the first, lastAt at the last', async () => {
    // p2 became overdue at NOW - 2 h, p1 at NOW - 1 h; the finding opens at NOW.
    const store = await storeWith([im('a', back(1))], [['p1', 'bank.pending', NOW - 5 * H], ['p2', 'bank.pending', NOW - 6 * H]]);
    const one = await pass(store, manifest(), NOW);
    const f = byKey(one, 'promise:payout:pending-settles')!;
    expect(f).toMatchObject({ state: 'open', count: 2, firstAt: NOW - 2 * H, lastAt: NOW - H });
    // An open finding kept from before with a later firstAt (as the u5 report showed: first 08:58, last 03:58) keeps
    // the earlier time when the check names one.
    const kept = { ...f, firstAt: NOW + 5 * H };
    const two = await pass(store, manifest(), NOW + 5 * H, [kept], one.memory);
    const g = byKey(two, 'promise:payout:pending-settles')!;
    expect(g).toMatchObject({ state: 'open', firstAt: NOW - 2 * H, lastAt: NOW - H });
    expect(g.lastAt).toBeGreaterThanOrEqual(g.firstAt);
  });

  it('a once finding over several breaches has firstAt at the first breach and lastAt at the last', async () => {
    const store = await storeWith([im('a', back(1))], [['a1', 'ledger.debited', NOW - 3 * H], ['a1', 'ledger.debited', NOW - 3 * H + MIN], ['b1', 'ledger.debited', NOW - H], ['b1', 'ledger.debited', NOW - H + MIN]]);
    const f = byKey(await pass(store, manifest(), NOW), 'promise:payout:one-debit')!;
    expect(f).toMatchObject({ state: 'open', count: 2, firstAt: NOW - 3 * H + MIN, lastAt: NOW - H + MIN });
  });
});
