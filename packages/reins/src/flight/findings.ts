// Findings (design section 5): one line a person can act on, with the figures behind it. A checker pass and
// the instance minutes it read become findings of five kinds; each key has one finding, which opens, changes
// level and resolves as section 5 states. This module is pure: it reads nothing and writes nothing, so the same
// pass gives the same findings in a server or in the watcher. Keys of runs stay here and in the store; sinks
// get them only when the app opts in (C6, sinks.ts).
// Imports: reins' shared modules only (the flight safety test walks this file).
import type { Finding } from '../report.js';
import { bucketP95, bucketsOver, LATENCY_BOUNDS, type Figures } from '../recorder.js';
import type { BlindFact, CheckResult, PromiseCheck } from './checker.js';
import { type Basics, basicsOf } from './limits.js';
import { DEFAULT_WINDOW_MS, type FlightManifest, type ManifestResult } from './manifest.js';
import { type CheckId, sourceLine } from './sources.js';
import { type FindingRecord, type InstanceMinute, PRUNE_INSTANCE, storableText } from './store.js';

export type FindingKind = 'blind' | 'basic' | 'broken' | 'drifting' | 'unusual';
/** The order every report shows the kinds in (design section 5). */
export const KIND_ORDER: readonly FindingKind[] = ['blind', 'basic', 'broken', 'drifting', 'unusual'];

/** A flight finding: the report's `Finding` (key, level, text) and what section 5 adds. */
export interface FlightFinding extends Finding {
  kind: FindingKind;
  /** For example `security`. */
  tags?: string[];
  /**
   * How many times: the runs, steps, calls or responses behind the finding as last seen (overdue runs for
   * `within` and `ends`), or, for a finding with no such figure, the passes that have seen it while open.
   */
  count: number;
  /** When this finding (last) opened. */
  firstAt: number;
  /** When it was last seen: for a promise, its latest breach. */
  lastAt: number;
  state: 'open' | 'resolved';
  /** When it resolved, while it is resolved. */
  resolvedAt?: number;
  /** For a built-in check: the document its limit comes from and the date it was read (sources.ts). */
  source?: string;
  /** The process it is about, when there is one. */
  process?: string;
  /** For a promise: the manifest's `why`. */
  why?: string;
  /** Up to MAX_KEYS process keys behind it. Server-side only: a sink gets them only when it opts in (C6). */
  keys?: string[];
}

/** What a rule saw this pass, before it is merged with the finding of the same key. */
export interface Observation {
  key: string;
  kind: FindingKind;
  level: 'error' | 'warn';
  text: string;
  tags?: string[];
  /** The figure behind it; without one, `count` counts the passes that saw it. */
  n?: number;
  /** When it happened, if not now. */
  at?: number;
  source?: string;
  process?: string;
  why?: string;
  keys?: string[];
}

export type ChangeEvent = 'opened' | 'changed' | 'resolved';

/** A finding that opened, changed level or resolved in this pass: what a sink is told (design section 5). */
export interface Change {
  event: ChangeEvent;
  finding: FlightFinding;
  /** For `changed`: the level before. */
  from?: 'error' | 'warn';
}

/** What the findings layer keeps between passes, in the store beside the findings (STATE_KEY). */
export interface FindingsMemory {
  /** Error codes seen, with when each was first seen. */
  codes?: Record<string, number>;
  /** The sinks' hourly counts, held notifications and the time of the last daily summary (sinks.ts). */
  notify?: Record<string, unknown>;
}

/** The store record that holds FindingsMemory. Finding keys never start with `(`, so it is never a finding. */
export const STATE_KEY = '(flight-state)';
/** Error codes remembered at most; the longest known go first. */
const MAX_CODES = 500;
/** Keys listed per finding at most (the checker's own bound). */
const MAX_KEYS = 20;
const MIN = 60_000;
const HOUR = 3_600_000;

export interface EvaluateInput {
  check: CheckResult;
  /** The instance minutes the pass read; null when they could not be read. */
  minutes: InstanceMinute[] | null;
  manifest: ManifestResult | null;
  /** The findings as last kept (store, or this instance's own copy while the store is down). */
  prior: FlightFinding[];
  memory: FindingsMemory;
  now?: number;
  /** Observations from outside the checker, such as sinks that keep failing (key prefix `blind:sink:`). */
  extra?: Observation[];
}

export interface EvaluateResult {
  /** Every finding known, open and resolved, in report order. */
  findings: FlightFinding[];
  /** The findings that opened, changed level or resolved in this pass. */
  changes: Change[];
  memory: FindingsMemory;
}

// ---- formatting --------------------------------------------------------------------------------------

/** A duration in plain words: `850 ms`, `1.2 s`, `12 s`, `5 min`, `3.5 h`, `2 days`. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  // One decimal below 10 s, so a limit such as 1200 ms is not written as "1 s".
  if (ms < 10_000) return `${Math.round(ms / 100) / 10} s`;
  if (ms < MIN) return `${Math.round(ms / 1000)} s`;
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`;
  if (ms < 48 * HOUR) return `${Math.round((ms / HOUR) * 10) / 10} h`;
  return `${Math.round(ms / (24 * HOUR))} days`;
}
export const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
/** `1 step`, `2 steps`: a count and its noun. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const utc = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
/** A name from a record, made safe for a line of text and a key: no control characters, at most 120 characters. */
export const nm = (s: unknown) => storableText(String(s)).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);

// ---- merging figures across instances and minutes ---------------------------------------------------------

export interface Merged {
  count: number;
  errors: number;
  p95Ms: number;
  maxMs: number;
  refused: Record<string, number>;
}

const emptyMerged = (): Merged => ({ count: 0, errors: 0, p95Ms: 0, maxMs: 0, refused: {} });
const bucketsOf = new WeakMap<Merged, number[]>();
const fallbackP95 = new WeakMap<Merged, number>();
/** The added figures that have buckets, one per instance minute: their exact counts over a limit (`overCounts`). */
const partsOf = new WeakMap<Merged, Figures[]>();

/** Adds one minute's figures (design: figures from the instances are added before a limit applies). */
function addFigures(m: Merged, f: Figures) {
  const count = Number(f.count) || 0;
  m.count += count;
  m.errors += Number(f.errors) || 0;
  m.maxMs = Math.max(m.maxMs, Number(f.maxMs) || 0);
  if (f.refused && typeof f.refused === 'object') for (const [k, v] of Object.entries(f.refused)) m.refused[k] = (m.refused[k] || 0) + (Number(v) || 0);
  // Figures with another number of buckets (from a release with other bounds) are not added bucket by bucket:
  // only their p95Ms counts toward the 95th percentile, and none of them counts as surely over a limit.
  if (Array.isArray(f.buckets) && f.buckets.length === LATENCY_BOUNDS.length) {
    const b = bucketsOf.get(m) || LATENCY_BOUNDS.map(() => 0);
    f.buckets.forEach((v, i) => (b[i] += Number(v) || 0));
    bucketsOf.set(m, b);
    const parts = partsOf.get(m) || [];
    parts.push(f);
    partsOf.set(m, parts);
  } else fallbackP95.set(m, Math.max(fallbackP95.get(m) || 0, Number(f.p95Ms) || 0));
}

/** The 95th percentile of the added figures: the bound of the bucket that holds it, capped at the maximum. */
function p95(m: Merged): number {
  const b = bucketsOf.get(m);
  const out = fallbackP95.get(m) || 0;
  if (!b) return out;
  const total = b.reduce((a, x) => a + x, 0);
  return total ? Math.max(out, bucketP95(b, total, m.maxMs)) : out;
}

const sum = (l: readonly number[]) => l.reduce((a, x) => a + (Number(x) || 0), 0);

/** A minute's exact count over `ms`, kept by the recorder for flight's own limits (`Figures.over`), or null. */
function exactOver(f: Figures, ms: number): number | null {
  const v = f.over && typeof f.over === 'object' ? f.over[String(ms)] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, sum(f.buckets || [])) : null;
}

/**
 * Of the added figures kept in buckets (`total`), how many surely took longer than each of `limits`, in one pass:
 * a minute's exact count where the recorder kept one, else its buckets whose lower bound is the limit or more
 * (exact when the limit is a bound; between two bounds a floor, so `exact` is false). The 95th percentile is
 * surely over a limit (`is`) when more than 5% of them are. A bucket bound never overstates a time.
 */
function overCounts(m: Merged, limits: number[]): { total: number; over: Array<{ n: number; exact: boolean; is: boolean }> } {
  const b = bucketsOf.get(m);
  const total = b ? sum(b) : 0;
  const parts = partsOf.get(m) || [];
  const over = limits.map((ms) => {
    let n = 0;
    let exact = true;
    for (const p of parts) {
      const x = LATENCY_BOUNDS.includes(ms) ? null : exactOver(p, ms);
      if (x !== null) n += x;
      else {
        n += bucketsOver(p.buckets!, ms);
        if (!LATENCY_BOUNDS.includes(ms)) exact = false;
      }
    }
    return { n, exact, is: total > 0 && total - n < Math.ceil(total * 0.95) };
  });
  return { total, over };
}

export const live = (m: InstanceMinute) => m.instance !== PRUNE_INSTANCE;

/** Requests per `METHOD route`, and upstream calls per host, added over the minutes in [from, to). */
export function figuresIn(minutes: InstanceMinute[], from: number, to: number) {
  const routes = new Map<string, Merged>();
  const hosts = new Map<string, Merged>();
  const all = emptyMerged();
  const get = (map: Map<string, Merged>, k: string) => {
    let x = map.get(k);
    if (!x) map.set(k, (x = emptyMerged()));
    return x;
  };
  for (const m of minutes) {
    if (!live(m) || !m.basics || m.minute < from || m.minute >= to) continue;
    for (const r of Array.isArray(m.basics.requests) ? m.basics.requests : []) {
      addFigures(get(routes, `${nm(r.method)} ${nm(r.route)}`), r);
      addFigures(all, r);
    }
    for (const u of Array.isArray(m.basics.upstream) ? m.basics.upstream : []) addFigures(get(hosts, nm(u.host)), u);
  }
  for (const x of [...routes.values(), ...hosts.values(), all]) x.p95Ms = p95(x);
  return { routes, hosts, all };
}

// ---- the rules -------------------------------------------------------------------------------------------

export function blindObservation(f: BlindFact, b: Basics): Observation | undefined {
  switch (f.kind) {
    case 'manifest-invalid': {
      const first = f.problems[0];
      return {
        key: 'blind:manifest-invalid',
        kind: 'blind',
        level: 'error',
        n: f.problems.length,
        text: `The manifest is invalid, so no promise or probe is checked (the basics still are): ${plural(f.problems.length, 'problem')}${first ? `, the first at ${nm(first.path)}: ${nm(first.message)}` : ''}. Run \`npx reins flight check\`.`,
      };
    }
    case 'store-unreachable':
      return {
        key: 'blind:store-unreachable',
        kind: 'blind',
        level: 'error',
        text: f.error === 'timeout' ? 'The store did not answer within the time limit, so nothing was checked.' : `The store could not be read (${nm(f.error)}), so nothing was checked.`,
      };
    case 'lock-unavailable':
      return { key: 'blind:lock-unavailable', kind: 'blind', level: 'warn', text: `The checker lock could not be taken (${nm(f.error)}), so this checker did not check; is the lock table there?` };
    case 'steps-dropped':
      return {
        key: `blind:steps-dropped:${nm(f.process)}`,
        kind: 'blind',
        level: 'warn',
        n: f.count,
        process: f.process,
        text: `${plural(f.count, 'step')} of ${nm(f.process)} were dropped since ${utc(f.since)} (the queue was full or the store refused them), so its once, order and retries promises are not checked for that time.`,
      };
    case 'overdue-pruned':
      return { key: `blind:overdue-pruned:${nm(f.process)}`, kind: 'blind', level: 'warn', n: f.count, process: f.process, text: `Retention removed ${plural(f.count, 'run')} of ${nm(f.process)} that had not ended, so they may have been overdue unseen.` };
    case 'runs-partial':
      return { key: `blind:runs-partial:${nm(f.process)}`, kind: 'blind', level: 'warn', n: f.count, process: f.process, text: `${plural(f.count, 'run')} of ${nm(f.process)} lost earlier steps to retention, so their promises are not judged.` };
    case 'markers-dropped':
      return { key: `blind:markers-dropped:${nm(f.process)}`, kind: 'blind', level: 'warn', n: f.count, process: f.process, text: `Retention kept no trace of ${plural(f.count, 'removed run')} of ${nm(f.process)}, so a later step of one of them is judged as a new run.` };
    case 'store-write-failed':
      return { key: 'blind:store-write-failed', kind: 'blind', level: 'warn', n: f.count, text: `The store refused ${plural(f.count, 'write')} in the last ${duration(DEFAULT_WINDOW_MS)}, so some steps or results are missing.` };
    case 'no-instance':
      return { key: 'blind:no-instance', kind: 'blind', level: 'warn', text: `No server instance has reported in the last ${duration(Math.max(b.recentMs, 5 * MIN))}, so probes are not checked.` };
    case 'probe-stale':
      return { key: `blind:probe-stale:${nm(f.id)}`, kind: 'blind', level: 'warn', text: `Probe ${nm(f.id)} last ran ${utc(f.lastAt)}, more than two of its ${duration(f.everyMs)} periods ago.` };
    case 'probe-not-registered':
      return { key: `blind:probe-not-registered:${nm(f.id)}`, kind: 'blind', level: 'warn', text: `Probe ${nm(f.id)} is in the manifest but no instance registered it with flight.probe().` };
    case 'probe-not-declared':
      return { key: `blind:probe-not-declared:${nm(f.id)}`, kind: 'blind', level: 'warn', text: `Probe ${nm(f.id)} is registered but not in the manifest, so it does not run.` };
  }
}

function promiseText(c: PromiseCheck & { state: 'broken' }, m: FlightManifest): string {
  const p = m.processes.find((x) => x.name === c.process);
  const promise = p?.promises.find((x) => x.id === c.id);
  const runs = plural(c.count, `run of ${nm(c.process)}`, `runs of ${nm(c.process)}`);
  const tail = `(promise: ${nm(c.id)})`;
  switch (promise?.kind) {
    case 'within':
      return `${runs} ${c.count === 1 ? 'has' : 'have'} waited more than ${duration(promise.withinMs)} after ${nm(promise.after)} for ${promise.expect.map(nm).join(' or ')} ${tail}.`;
    case 'ends':
      return `${runs} ${c.count === 1 ? 'has' : 'have'} not ended within ${duration(promise.withinMs)} ${tail}.`;
    case 'once':
      return `${runs} recorded ${nm(promise.step)} more than once in the last ${duration(c.windowMs)}; the last at ${utc(c.lastBreachAt)} ${tail}.`;
    case 'order':
      return `${runs} recorded ${nm(promise.then)} before ${nm(promise.first)} in the last ${duration(c.windowMs)}; the last at ${utc(c.lastBreachAt)} ${tail}.`;
  }
  if (c.kind === 'retries') {
    const step = c.id.slice('retries:'.length);
    const n = p?.retries[step] ?? 0;
    return `${runs} recorded ${nm(step)} more than ${n + 1} times (1 attempt and ${plural(n, 'retry', 'retries')} are declared) in the last ${duration(c.windowMs)}; the last at ${utc(c.lastBreachAt)}.`;
  }
  return `${runs} broke promise ${nm(c.id)}.`;
}

function promiseRules(check: CheckResult, m: FlightManifest, b: Basics, out: Observation[], judged: Set<string>) {
  for (const c of check.promises) {
    const key = `promise:${nm(c.process)}:${nm(c.id)}`;
    const drift = `drifting:${key}`;
    if (c.state === 'not-checked') continue;
    judged.add(key);
    judged.add(drift);
    const promise = m.processes.find((x) => x.name === c.process)?.promises.find((x) => x.id === c.id);
    if (c.state === 'broken') {
      out.push({ key, kind: 'broken', level: 'error', n: c.count, at: c.lastBreachAt, process: c.process, keys: c.keys.slice(0, MAX_KEYS), text: promiseText(c, m), ...(promise?.why ? { why: promise.why } : {}) });
      continue;
    }
    // Held: drifting when the slowest 5% of the runs that finished take most of the time allowed (B5).
    if ((promise?.kind === 'within' || promise?.kind === 'ends') && c.took && c.took.p95Ms !== null && c.took.p95Ms >= b.driftShare * promise.withinMs) {
      out.push({
        key: drift,
        kind: 'drifting',
        level: 'warn',
        n: c.took.runs,
        process: c.process,
        source: sourceLine('promise-drift'),
        text: `Promise ${nm(c.id)} of ${nm(c.process)} still holds, but the slowest 5% of the ${plural(c.took.runs, 'run')} that finished in the last ${duration(c.windowMs)} took ${duration(c.took.p95Ms)} or more, ${c.took.p95Ms > promise.withinMs ? `longer than the ${duration(promise.withinMs)} allowed, so some came late` : `${pct(c.took.p95Ms / promise.withinMs)} of the ${duration(promise.withinMs)} allowed`}.`,
        ...(promise.why ? { why: promise.why } : {}),
      });
    }
  }
  for (const p of check.probes) {
    if (p.state === 'not-checked') continue;
    const key = `probe:${nm(p.id)}`;
    judged.add(key);
    if (p.state === 'broken') {
      const why = m.probes.find((x) => x.id === p.id)?.why;
      const how = p.reason === 'threw' ? 'threw' : p.reason === 'timeout' ? 'ran past its time limit' : 'returned something other than { ok: true }';
      out.push({ key, kind: 'broken', level: 'error', ...(p.lastAt ? { at: p.lastAt } : {}), text: `Probe ${nm(p.id)} failed: it ${how}.`, ...(why ? { why } : {}) });
    }
  }
}

/** The six basics (B2), from the minutes of all instances. */
function basicRules(minutes: InstanceMinute[], now: number, b: Basics, out: Observation[]) {
  const from = now - b.recentMs;
  const recent = figuresIn(minutes, from, Infinity);
  const window = duration(b.recentMs);

  // Failed-request share, across all routes and instances.
  const all = recent.all;
  if (all.count >= b.minRequests && all.errors / all.count > b.errorShare) {
    const share = all.errors / all.count;
    out.push({
      key: 'basic:error-share',
      kind: 'basic',
      level: b.errorShare > 0 && share >= Math.min(1, b.errorFactor * b.errorShare) ? 'error' : 'warn',
      n: all.errors,
      source: sourceLine('error-share', true),
      text: `${pct(share)} of requests failed in the last ${window} (${all.errors} of ${all.count}), over the limit of ${pct(b.errorShare)}.`,
    });
  }

  // Slow routes: the 95th percentile of each route over the window is surely over the limit (more than 5% of its
  // requests surely took longer). The latency buckets have bounds at the default limit and its error level, and the
  // recorder counts a manifest's own limit and error level exactly, so the count is exact; only from a minute
  // without that exact count (an older release) is it a floor, and the text says "at least".
  const slow = new Set<string>();
  // Routes whose count over the limit is a floor: one over the limit by its buckets may still be slow.
  const floor = new Set<string>();
  for (const [route, f] of recent.routes) {
    const {
      total,
      over: [s, e],
    } = overCounts(f, [b.slowRouteMs, b.errorFactor * b.slowRouteMs]);
    if (!s.exact) floor.add(route);
    if (total < b.minCalls || !s.is) continue;
    slow.add(route);
    out.push({
      key: `basic:slow-route:${route}`,
      kind: 'basic',
      level: e.is ? 'error' : 'warn',
      n: total,
      source: sourceLine('slow-route'),
      text: `${route} is slow: ${s.exact ? '' : 'at least '}${s.n} of its ${total} requests in the last ${window} (${pct(s.n / total)}) took longer than ${duration(b.slowRouteMs)}, so its 95th percentile is over that limit.`,
    });
  }

  // Failing upstream hosts.
  for (const [host, f] of recent.hosts) {
    if (host === '(other)' || f.count < b.minCalls || f.errors / f.count <= b.upstreamErrorShare) continue;
    const share = f.errors / f.count;
    out.push({
      key: `basic:upstream:${host}`,
      kind: 'basic',
      level: share >= Math.min(1, b.errorFactor * b.upstreamErrorShare) ? 'error' : 'warn',
      n: f.errors,
      source: sourceLine('upstream', true),
      text: `Upstream ${host} is failing: ${f.errors} of ${f.count} calls in the last ${window} failed (${pct(share)}), over the limit of ${pct(b.upstreamErrorShare)}.`,
    });
  }

  // A blocked event loop: per instance, minutes whose 99th percentile delay was over the limit.
  const perInstance = new Map<string, InstanceMinute[]>();
  for (const m of minutes) {
    if (!live(m) || !m.basics?.runtime) continue;
    const list = perInstance.get(m.instance);
    if (list) list.push(m);
    else perInstance.set(m.instance, [m]);
  }
  let blocked = 0;
  let worst = 0;
  let worstMinutes = 0;
  for (const list of perInstance.values()) {
    const over = list.filter((m) => m.minute >= from && Number(m.basics!.runtime!.eventLoop?.p99Ms) > b.loopDelayMs);
    if (over.length < b.loopMinutes) continue;
    blocked++;
    worstMinutes = Math.max(worstMinutes, over.length);
    // Loops, not a spread: a spread of a store-sized list throws.
    for (const m of over) worst = Math.max(worst, Number(m.basics!.runtime!.eventLoop.p99Ms) || 0);
  }
  if (blocked)
    out.push({
      key: 'basic:event-loop',
      kind: 'basic',
      level: 'warn',
      source: sourceLine('event-loop', true),
      text: `The event loop was blocked on ${plural(blocked, 'instance')}: its 99th percentile delay was over ${duration(b.loopDelayMs)} in ${worstMinutes} minutes of the last ${window} (worst ${duration(worst)}).`,
    });

  // Memory that keeps growing: per instance, the heap over the memory window rises steadily by the limit.
  let growing = 0;
  let line = '';
  for (const [instance, list] of perInstance) {
    const inWindow = list.filter((m) => m.minute >= now - b.heapWindowMs).sort((x, y) => x.minute - y.minute);
    const heap = inWindow.map((m) => Number(m.basics!.runtime!.heapUsedMb) || 0);
    // Enough minutes, spread over most of the window, so a warm-up is not read as a leak.
    if (heap.length < b.heapMinutes || inWindow[inWindow.length - 1].minute - inWindow[0].minute < b.heapSpread * b.heapWindowMs - MIN) continue;
    const third = Math.floor(heap.length / 3);
    const first = heap.slice(0, third);
    const last = heap.slice(-third);
    const a = first.reduce((s, x) => s + x, 0) / first.length;
    const z = last.reduce((s, x) => s + x, 0) / last.length;
    if (a > 0 && z / a - 1 >= b.heapGrowth && last.reduce((x, y) => Math.min(x, y), Infinity) > first.reduce((x, y) => Math.max(x, y), -Infinity)) {
      growing++;
      if (!line) line = ` (instance ${nm(instance)}: from about ${Math.round(a)} MB to ${Math.round(z)} MB)`;
    }
  }
  if (growing)
    out.push({
      key: 'basic:memory',
      kind: 'basic',
      level: 'warn',
      source: sourceLine('memory', true),
      text: `Memory keeps growing on ${plural(growing, 'instance')}: the heap rose steadily by ${pct(b.heapGrowth)} or more over the last ${duration(b.heapWindowMs)}${line}.`,
    });

  // A spike of refused responses (401, 403, 429), against the hour before: a security signal (B12).
  const refused = all.refused;
  const r = Object.values(refused).reduce((s, x) => s + x, 0);
  if (r >= b.refusedMin) {
    const look = b.refusedLookbackMs;
    const before = figuresIn(minutes, from - look, from);
    const covered = new Set(minutes.filter((m) => live(m) && m.basics && m.minute >= from - look && m.minute < from).map((m) => m.minute)).size;
    const past = Object.values(before.all.refused).reduce((s, x) => s + x, 0);
    const usual = covered ? (past / covered) * (b.recentMs / MIN) : 0;
    if (r >= b.refusedFactor * usual) {
      const parts = Object.keys(refused).sort().map((k) => `${k}: ${refused[k]}`).join(', ');
      out.push({
        key: 'basic:refused',
        kind: 'basic',
        level: 'warn',
        tags: ['security'],
        n: r,
        source: sourceLine('refused', true),
        text: `Refused responses spiked: ${r} with status 401, 403 or 429 in the last ${window} (${parts}), against about ${Math.round(usual)} in the same time over the ${look === HOUR ? 'hour' : duration(look)} before. Refused sign-ins or a client being rate limited?`,
      });
    }
  }

  // Drifting: a route or upstream host well above its own baseline over the day before (B5).
  const base = figuresIn(minutes, now - DEFAULT_WINDOW_MS, from);
  const compare = (kind: 'route' | 'upstream', now_: Map<string, Merged>, then: Map<string, Merged>) => {
    for (const [name, f] of now_) {
      const old = then.get(name);
      if (!old || name.endsWith('(other)') || f.count < b.minCalls || old.count < b.minRequests || old.p95Ms <= 0) continue;
      // A slow-route basic already, or over the limit by its buckets with only a floor of the count over it (it may
      // be slow): neither is drift. With an exact count, a route that is not slow is judged on its drift.
      if (kind === 'route' && (slow.has(name) || (floor.has(name) && f.p95Ms > b.slowRouteMs))) continue;
      if (f.p95Ms < b.baselineMinMs || f.p95Ms < b.baselineFactor * old.p95Ms) continue;
      out.push({
        key: `drifting:${kind}:${name}`,
        kind: 'drifting',
        level: 'warn',
        n: f.count,
        source: sourceLine('baseline', true),
        text: `${kind === 'route' ? name : `Upstream ${name}`} took up to ${duration(f.p95Ms)} at the 95th percentile in the last ${window}, ${Math.round((f.p95Ms / old.p95Ms) * 10) / 10} times its usual ${duration(old.p95Ms)} over the day before.`,
      });
    }
  };
  compare('route', recent.routes, base.routes);
  compare('upstream', recent.hosts, base.hosts);
}

/** Steps per `process step` added over the minutes, with the first and last minute each was seen in. */
function stepCounts(minutes: InstanceMinute[], since: number) {
  const out = new Map<string, { n: number; first: number; last: number }>();
  for (const m of minutes) {
    if (!live(m) || m.minute < since || !m.steps || typeof m.steps !== 'object') continue;
    for (const [k, v] of Object.entries(m.steps)) {
      const n = Number(v) || 0;
      if (!n) continue;
      const x = out.get(k);
      if (!x) out.set(k, { n, first: m.minute, last: m.minute });
      else {
        x.n += n;
        x.first = Math.min(x.first, m.minute);
        x.last = Math.max(x.last, m.minute);
      }
    }
  }
  return out;
}

/** Unusual findings that need the manifest (B4), and the blind `no-steps` one (B3). */
function manifestRules(minutes: InstanceMinute[], m: FlightManifest, check: CheckResult, now: number, b: Basics, out: Observation[]) {
  const since = now - DEFAULT_WINDOW_MS;
  const counts = stepCounts(minutes, since);
  const declared = new Map(m.processes.map((p) => [p.name, new Set(p.steps)]));
  for (const [k, c] of counts) {
    const [proc, step] = k.split(' ');
    if (step === undefined) continue; // the (other) bucket of a writer past its name limit
    const steps = declared.get(proc);
    if (!steps) out.push({ key: `unusual:process:${nm(proc)}`, kind: 'unusual', level: 'warn', n: c.n, process: proc, at: c.last, text: `Process ${nm(proc)} is not in the manifest, yet ${plural(c.n, 'step')} of it were recorded in the last ${duration(DEFAULT_WINDOW_MS)}.` });
    else if (!steps.has(step)) out.push({ key: `unusual:step:${nm(proc)}:${nm(step)}`, kind: 'unusual', level: 'warn', n: c.n, process: proc, at: c.last, text: `Step ${nm(step)} of ${nm(proc)} is not in the manifest, yet it was recorded ${plural(c.n, 'time')} in the last ${duration(DEFAULT_WINDOW_MS)}.` });
  }

  // How long flight has been recording: the oldest minute any instance wrote.
  let oldest = Infinity;
  for (const x of minutes) if (live(x) && x.minute < oldest) oldest = x.minute;
  for (const p of m.processes) {
    const mine = [...counts].filter(([k]) => k.startsWith(`${p.name} `));
    const runs = check.promises.filter((c) => c.process === p.name).reduce((s, c) => s + c.runs, 0);
    if (!mine.length && !runs && Number.isFinite(oldest) && now - oldest >= b.quietGraceMs) {
      out.push({ key: `blind:no-steps:${nm(p.name)}`, kind: 'blind', level: 'warn', process: p.name, text: `Process ${nm(p.name)} is in the manifest but no step of it was recorded in the last ${duration(Math.min(now - oldest, DEFAULT_WINDOW_MS))}: is flight.step() called for it?` });
    }
    // A declared step gone silent while its process goes on.
    for (const step of p.steps) {
      const c = counts.get(`${p.name} ${step}`);
      if (!c || c.n < b.silentMinCount) continue;
      const gap = Math.max(MIN, (c.last - c.first + MIN) / c.n);
      const quiet = now - (c.last + MIN);
      const after = mine.some(([k, o]) => k !== `${p.name} ${step}` && o.last > c.last);
      if (after && quiet >= Math.max(b.silentMinMs, b.silentFactor * gap)) {
        out.push({
          key: `unusual:silent:${nm(p.name)}:${nm(step)}`,
          kind: 'unusual',
          level: 'warn',
          process: p.name,
          at: c.last,
          source: sourceLine('silent-step'),
          text: `Step ${nm(step)} of ${nm(p.name)} has not been recorded for ${duration(quiet)}, though it came about every ${duration(gap)} before, while other ${nm(p.name)} steps still arrive.`,
        });
      }
    }
  }

  // Upstream hosts not in the manifest.
  const hosts = new Map<string, number>();
  for (const x of minutes) if (live(x) && x.basics && x.minute >= since) for (const u of Array.isArray(x.basics.upstream) ? x.basics.upstream : []) hosts.set(nm(u.host), (hosts.get(nm(u.host)) || 0) + (Number(u.count) || 0));
  const known = new Set(m.upstreams.map((h) => h.toLowerCase()));
  for (const [host, n] of hosts) {
    if (host === '(other)' || known.has(host)) continue;
    out.push({ key: `unusual:host:${host}`, kind: 'unusual', level: 'warn', n, text: `Upstream host ${host} is not in the manifest, yet it was called ${plural(n, 'time')} in the last ${duration(DEFAULT_WINDOW_MS)}.` });
  }
}

/** Error codes seen for the first time (B4), and development reins in production (B12). */
function codeRules(minutes: InstanceMinute[], now: number, b: Basics, memory: FindingsMemory, out: Observation[]) {
  const from = now - b.recentMs;
  const fresh = !memory.codes || typeof memory.codes !== 'object';
  const codes: Record<string, number> = Object.create(null);
  if (!fresh) for (const [k, v] of Object.entries(memory.codes!)) if (Number.isFinite(v)) codes[k] = v;
  // The minute each code was first seen in the minutes read.
  const firstIn = new Map<string, number>();
  for (const m of minutes) {
    if (!live(m) || !m.basics?.codes || typeof m.basics.codes !== 'object') continue;
    for (const [c, v] of Object.entries(m.basics.codes)) {
      if (c === '(other)' || !Number(v)) continue;
      const code = nm(c);
      firstIn.set(code, Math.min(firstIn.get(code) ?? Infinity, m.minute));
    }
  }
  // A code not known before is remembered with the minute it was first seen. With no memory yet (a new
  // store), a code already seen before the recent window is known from before (0), not new.
  for (const [code, first] of firstIn) if (!(code in codes)) codes[code] = fresh && first < from ? 0 : first;
  for (const [code, first] of Object.entries(codes)) {
    if (now - first >= b.newCodeMs) continue;
    let n = 0;
    for (const m of minutes) if (live(m) && m.minute >= first - MIN && m.basics?.codes && typeof m.basics.codes === 'object') n += Number((m.basics.codes as Record<string, number>)[code]) || 0;
    if (!n) continue;
    out.push({ key: `unusual:code:${code}`, kind: 'unusual', level: 'warn', n, source: sourceLine('new-code'), text: `Error code ${code} was seen for the first time ${duration(Math.max(0, now - first))} ago (${plural(n, 'time')} since).` });
  }
  // Bounded: the codes known longest go first.
  const kept = Object.entries(codes).sort((x, y) => y[1] - x[1]).slice(0, MAX_CODES);
  memory.codes = Object.fromEntries(kept);

  const dev = new Set(minutes.filter((m) => live(m) && m.devModule === true && m.minute >= from).map((m) => m.instance));
  if (dev.size)
    out.push({
      key: 'security:dev-module',
      kind: 'unusual',
      level: 'error',
      tags: ['security'],
      source: sourceLine('dev-module'),
      text: `Development reins (@mindmakr/reins/node) is loaded in a production process on ${plural(dev.size, 'instance')}; only @mindmakr/reins/flight belongs in production.`,
    });
}

// ---- merging with the findings kept ------------------------------------------------------------------------

const levelRank = (l: string) => (l === 'error' ? 0 : 1);

/**
 * The findings about one server's own way to the store. They live in that server only (B13): never written to the
 * store, never judged by another server.
 */
export const STORE_KEYS: ReadonlySet<string> = new Set(['blind:store-unreachable', 'blind:lock-unavailable']);

/** Blind keys every pass judges: the store, the lock and the manifest. */
const STORE_BLIND = ['blind:store-unreachable', 'blind:lock-unavailable', 'blind:manifest-invalid'];
/** Blind keys the checker knows only from a valid manifest (or knows to be gone, with none). */
const MANIFEST_BLIND = ['blind:steps-dropped:', 'blind:overdue-pruned:', 'blind:runs-partial:', 'blind:markers-dropped:', 'blind:no-instance', 'blind:probe-stale:', 'blind:probe-not-registered:', 'blind:probe-not-declared:'];
/** The keys of the rules that read the manifest and the minutes (manifestRules). */
const MANIFEST_RULES = ['unusual:process:', 'unusual:step:', 'unusual:silent:', 'unusual:host:', 'blind:no-steps:'];

/** Findings in report order: open first, then by kind order, level, and key. */
export function sortFindings(list: FlightFinding[]): FlightFinding[] {
  return [...list].sort(
    (a, b) =>
      (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      levelRank(a.level) - levelRank(b.level) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/**
 * One pass of the findings layer. Never throws. A finding not seen this pass resolves only when its check was
 * judged: a promise that was not checked (steps dropped, store down) keeps its finding as it was.
 */
export function evaluate(input: EvaluateInput): EvaluateResult {
  const now = typeof input.now === 'number' ? input.now : input.check.at;
  const memory: FindingsMemory = { ...(input.memory || {}) };
  const obs: Observation[] = [];
  const judged = new Set<string>();
  const judgedPrefixes: string[] = [];
  const check = input.check;
  const m = input.manifest?.ok ? input.manifest.manifest : undefined;
  const b = basicsOf(m?.basics);
  const blindOk = !check.blind.some((f) => f.kind === 'store-unreachable' || f.kind === 'lock-unavailable');
  // Each rule runs on its own and judges its keys only when it ran to its end: a rule that fails keeps its
  // findings as they were and never stops the others.
  const rule = (prefixes: string[], fn: () => void) => {
    try {
      fn();
      judgedPrefixes.push(...prefixes);
    } catch {}
  };

  // The blind facts the checker reports: those about the store, the lock and the manifest in every pass; the
  // store's write failures when it could be read; and the ones about processes and probes only when there is a
  // manifest to know them from (with none, there are no processes, so any left from before resolve).
  rule([...STORE_BLIND, ...(blindOk ? ['blind:store-write-failed'] : []), ...(blindOk && check.manifest !== 'invalid' ? MANIFEST_BLIND : [])], () => {
    for (const f of check.blind) {
      const o = blindObservation(f, b);
      if (o) obs.push(o);
    }
  });
  if (m)
    rule([], () => {
      const mine = new Set<string>();
      promiseRules(check, m, b, obs, mine);
      // A promise or probe no longer in the manifest: its finding resolves.
      if (blindOk) {
        const keys = new Set([...check.promises.map((c) => `promise:${nm(c.process)}:${nm(c.id)}`), ...check.probes.map((p) => `probe:${nm(p.id)}`)]);
        for (const f of input.prior) if ((f.key.startsWith('promise:') || f.key.startsWith('probe:') || f.key.startsWith('drifting:promise:')) && !keys.has(f.key.replace(/^drifting:/, ''))) mine.add(f.key);
      }
      for (const k of mine) judged.add(k);
    });
  else if (check.manifest === 'none' && blindOk) judgedPrefixes.push('promise:', 'probe:', 'drifting:promise:');
  if (input.minutes) {
    const minutes = input.minutes;
    rule(['basic:', 'drifting:route:', 'drifting:upstream:'], () => basicRules(minutes, now, b, obs));
    rule(['unusual:code:', 'security:'], () => codeRules(minutes, now, b, memory, obs));
    if (m) rule(MANIFEST_RULES, () => manifestRules(minutes, m, check, now, b, obs));
    else if (check.manifest === 'none') judgedPrefixes.push(...MANIFEST_RULES);
  }
  rule(['blind:sink:'], () => {
    for (const x of input.extra || []) obs.push(x);
  });

  const isJudged = (key: string) => judged.has(key) || judgedPrefixes.some((p) => key.startsWith(p));
  const prior = new Map(input.prior.map((f) => [f.key, f]));
  const seen = new Map<string, Observation>();
  for (const o of obs) if (!seen.has(o.key)) seen.set(o.key, o);
  const changes: Change[] = [];
  const out = new Map<string, FlightFinding>();

  for (const [key, o] of seen) {
    const p = prior.get(key);
    const open = p && p.state === 'open';
    const f: FlightFinding = {
      key,
      kind: o.kind,
      level: o.level,
      text: o.text,
      ...(o.tags?.length ? { tags: [...o.tags] } : {}),
      count: typeof o.n === 'number' ? o.n : open ? (p.count || 0) + 1 : 1,
      firstAt: open ? p.firstAt : now,
      lastAt: typeof o.at === 'number' ? o.at : now,
      state: 'open',
      ...(o.source ? { source: o.source } : {}),
      ...(o.process ? { process: o.process } : {}),
      ...(o.why ? { why: o.why } : {}),
      ...(o.keys?.length ? { keys: o.keys } : {}),
    };
    out.set(key, f);
    if (!open) changes.push({ event: 'opened', finding: f });
    else if (p.level !== f.level) changes.push({ event: 'changed', finding: f, from: p.level });
  }
  for (const [key, p] of prior) {
    if (out.has(key)) continue;
    if (p.state === 'open' && isJudged(key)) {
      const f: FlightFinding = { ...p, state: 'resolved', resolvedAt: now };
      out.set(key, f);
      changes.push({ event: 'resolved', finding: f });
    } else out.set(key, p);
  }
  return { findings: sortFindings([...out.values()]), changes, memory };
}

// ---- store records -----------------------------------------------------------------------------------------

const FINDING_KINDS = new Set<string>(KIND_ORDER);

/** A finding as a store record: key and state, and the rest as data. */
export function toRecord(f: FlightFinding, now: number): FindingRecord {
  const { key, state, ...data } = f;
  return { key, state, updatedAt: now, data: data as unknown as Record<string, unknown> };
}

/** The findings in store records, without the state record and records of the wrong shape. */
export function fromRecords(records: FindingRecord[]): FlightFinding[] {
  const out: FlightFinding[] = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || r.key === STATE_KEY || typeof r.key !== 'string' || !r.data || typeof r.data !== 'object') continue;
    const d = r.data as Record<string, any>;
    if (!FINDING_KINDS.has(d.kind) || (d.level !== 'error' && d.level !== 'warn') || typeof d.text !== 'string') continue;
    out.push({ ...(d as object), key: r.key, state: r.state, kind: d.kind, level: d.level, text: d.text, count: Number(d.count) || 0, firstAt: Number(d.firstAt) || 0, lastAt: Number(d.lastAt) || 0 } as FlightFinding);
  }
  return out;
}

/** The findings layer's memory from the store records, or an empty one. */
export function memoryFrom(records: FindingRecord[]): FindingsMemory {
  const r = (Array.isArray(records) ? records : []).find((x) => x && x.key === STATE_KEY);
  return r && r.data && typeof r.data === 'object' ? (r.data as FindingsMemory) : {};
}

/** The state record that keeps the findings layer's memory in the store. Open, so retention never removes it. */
export const memoryRecord = (memory: FindingsMemory, now: number): FindingRecord => ({ key: STATE_KEY, state: 'open', updatedAt: now, data: memory as Record<string, unknown> });

export type { CheckId };
