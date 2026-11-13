// The checker (design sections 4, 5 and 8). It reads only the store, so the same pass gives the same answer
// in a server or in a separate watcher process. Its output is a plain result per promise and per probe, and
// the blind facts: what flight itself could not see. Turning these into findings is the next layer's job.
// Imports: Node built-ins and reins' shared modules only (the flight safety test walks this file).
import { DEFAULT_WINDOW_MS, type FlightManifest, type FlightProcess, type FlightPromise, type ManifestProblem, type ManifestResult, type PromiseKind } from './manifest.js';
import { type FlightStore, type InstanceMinute, PRUNE_INSTANCE, type ProbeFailure, type ProbeResult, type StepRecord } from './store.js';
import { errorCode } from '../recorder.js';
import { OTHER_PROCESS } from './steps.js';

/** Keys listed per result at most; `count` always has the full number. */
export const MAX_KEYS = 20;
/** An instance counts as reporting when it wrote a minute this recently. */
export const RECENT_MS = 5 * 60_000;
/** A probe result older than this many of its periods is too old. */
export const STALE_PERIODS = 2;

export type NotCheckedReason = 'steps-dropped' | 'store-unreachable' | 'lock-unavailable';

/** A run whose expected step came, but late (within, ends). It is not a breach now (design section 5). */
export interface LateRun {
  key: string;
  /** How far past the time it arrived, in ms. */
  lateMs: number;
  /** When it arrived. */
  at: number;
}

interface CheckBase {
  process: string;
  /** The promise id; for a declared retry limit, `retries:<step>`. */
  id: string;
  kind: PromiseKind | 'retries';
  windowMs: number;
  /** Start of the look-back window: `now - windowMs`. */
  since: number;
  /** Runs checked: those with a step inside the window. */
  runs: number;
  /** Steps of this process dropped inside the window (0 when none). */
  stepsDropped: number;
}

export type PromiseCheck = CheckBase &
  (
    | { state: 'held'; late: LateRun[]; lateCount: number }
    | {
        state: 'broken';
        /** Breaching runs: overdue now (within, ends) or with a breach (once, order, retries). */
        count: number;
        /** Up to MAX_KEYS of them, oldest breach first. Keys stay server-side (design C6). */
        keys: string[];
        /** The latest breach: when a run became overdue, or when the breaching step was recorded. */
        lastBreachAt: number;
        late: LateRun[];
        lateCount: number;
      }
    | { state: 'not-checked'; reason: NotCheckedReason }
  );

export type ProbeCheck = { id: string; everyMs: number; lastAt: number | null } & (
  | { state: 'held' }
  | { state: 'broken'; reason: ProbeFailure }
  | { state: 'not-checked'; reason: 'not-registered' | 'no-result' | 'stale' | 'no-instance' | 'store-unreachable' | 'lock-unavailable' }
);

export type BlindFact =
  | { kind: 'manifest-invalid'; problems: ManifestProblem[] }
  /** The store could not be read; `error` is a code only, `timeout` when the pass ran past its time limit. */
  | { kind: 'store-unreachable'; error: string }
  /** Taking the checker lock failed (say, the lock table is missing): this checker did not check or prune. */
  | { kind: 'lock-unavailable'; error: string }
  | { kind: 'steps-dropped'; process: string; count: number; since: number }
  /** Runs retention removed while they had reached no end step, so they may have been overdue (B7). */
  | { kind: 'overdue-pruned'; process: string; count: number; since: number }
  | { kind: 'store-write-failed'; count: number; since: number }
  | { kind: 'no-instance'; since: number }
  | { kind: 'probe-stale'; id: string; lastAt: number; everyMs: number }
  | { kind: 'probe-not-registered'; id: string }
  | { kind: 'probe-not-declared'; id: string };

export interface CheckResult {
  at: number;
  /** Whether promise checks ran: false with no manifest or an invalid one. */
  manifest: 'ok' | 'none' | 'invalid';
  promises: PromiseCheck[];
  probes: ProbeCheck[];
  blind: BlindFact[];
}

export interface CheckOptions {
  /** The time of the pass. Default now. */
  now?: number;
}

const minuteOf = (t: number) => t - (t % 60_000);

/**
 * Steps dropped for `process` in minutes that overlap `[since, now]`. Drops a writer counted under
 * OTHER_PROCESS (past its limit of process names in one minute) may be of any process, so they count for each.
 */
function droppedIn(minutes: InstanceMinute[], process: string, since: number): number {
  let n = 0;
  for (const m of minutes) {
    if (m.minute < minuteOf(since) || !m.stepsDropped) continue;
    n += Number(own(m.stepsDropped, process)) || 0;
    if (process !== OTHER_PROCESS) n += Number(own(m.stepsDropped, OTHER_PROCESS)) || 0;
  }
  return n;
}

const own = (o: Record<string, unknown>, k: string) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/**
 * A result with every promise and probe of the manifest not checked, for `reason`, and `fact` as a blind fact:
 * what a pass gives when the store cannot be read, the pass runs past its time, or the lock cannot be taken.
 */
export function notCheckedResult(manifest: ManifestResult | null, now: number, fact: BlindFact, reason: 'store-unreachable' | 'lock-unavailable', done: PromiseCheck[] = []): CheckResult {
  const out: CheckResult = { at: now, manifest: !manifest ? 'none' : manifest.ok ? 'ok' : 'invalid', promises: [...done], probes: [], blind: [] };
  if (manifest && !manifest.ok) out.blind.push({ kind: 'manifest-invalid', problems: manifest.problems });
  out.blind.push(fact);
  const m = manifest?.ok ? manifest.manifest : undefined;
  if (!m) return out;
  const seen = new Set(done.map((x) => `${x.process} ${x.id}`));
  for (const p of m.processes) {
    const all = [...p.promises.map((x) => ({ id: x.id, kind: x.kind, windowMs: x.windowMs })), ...Object.keys(p.retries || {}).map((s) => ({ id: `retries:${s}`, kind: 'retries' as const, windowMs: DEFAULT_WINDOW_MS }))];
    for (const x of all) {
      if (seen.has(`${p.name} ${x.id}`)) continue;
      out.promises.push({ process: p.name, ...x, since: now - x.windowMs, runs: 0, stepsDropped: 0, state: 'not-checked', reason });
    }
  }
  out.probes = m.probes.map((x) => ({ id: x.id, everyMs: x.everyMs, lastAt: null, state: 'not-checked', reason }));
  return out;
}

/** The window of each check of a process: its promises' windows, and the default one for retries. */
const windowsOf = (p: FlightProcess) => [...p.promises.map((x) => x.windowMs), ...(Object.keys(p.retries || {}).length ? [DEFAULT_WINDOW_MS] : [])];

/**
 * One pass. Never throws: a store that cannot be read gives `store-unreachable`, and every promise and probe is
 * then not checked. `manifest` is the result of reading the manifest, or null when the app has none (basics only).
 */
export async function check(store: FlightStore, manifest: ManifestResult | null, o: CheckOptions = {}): Promise<CheckResult> {
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const out: CheckResult = { at: now, manifest: !manifest ? 'none' : manifest.ok ? 'ok' : 'invalid', promises: [], probes: [], blind: [] };
  if (manifest && !manifest.ok) out.blind.push({ kind: 'manifest-invalid', problems: manifest.problems });
  const m: FlightManifest | undefined = manifest?.ok ? manifest.manifest : undefined;
  const widest = Math.max(DEFAULT_WINDOW_MS, ...(m?.processes || []).flatMap(windowsOf));
  try {
    const minutes = await store.minutes(minuteOf(now - widest));
    const failed = minutes.filter((x) => x.minute >= minuteOf(now - DEFAULT_WINDOW_MS)).reduce((n, x) => n + (Number(x.storeErrors) || 0), 0);
    if (failed) out.blind.push({ kind: 'store-write-failed', count: failed, since: now - DEFAULT_WINDOW_MS });
    if (!m) return out;
    for (const p of m.processes) {
      const windows = windowsOf(p);
      if (!windows.length) continue;
      const since = now - Math.max(...windows);
      const dropped = droppedIn(minutes, p.name, since);
      if (dropped) out.blind.push({ kind: 'steps-dropped', process: p.name, count: dropped, since });
      const runs = group(await store.runSteps(p.name, since));
      const timed = p.promises.some((x) => x.kind === 'within' || x.kind === 'ends');
      const open = timed ? group(await store.openRuns(p.name, p.ends)) : new Map<string, StepRecord[]>();
      if (timed) {
        // Kept for as long as the widest promise window (at least a day), so the fact does not vanish a day
        // after the prune while a longer window still covers it.
        const pruned = minutes.reduce((n, x) => n + (Number(x.runsPruned && own(x.runsPruned, p.name)) || 0), 0);
        if (pruned) out.blind.push({ kind: 'overdue-pruned', process: p.name, count: pruned, since: now - widest });
      }
      for (const promise of p.promises) out.promises.push(checkPromise(p, promise, runs, open, minutes, now));
      for (const [step, n] of Object.entries(p.retries || {})) out.promises.push(checkRetries(p.name, step, n, runs, minutes, now));
    }
    out.probes = checkProbes(m, minutes, await store.probes(), now, out.blind);
  } catch (e) {
    return notCheckedResult(manifest, now, { kind: 'store-unreachable', error: errorCode(e) }, 'store-unreachable', out.promises);
  }
  return out;
}

/**
 * End steps of each process with a `within` or `ends` promise: what `store.prune` needs to count the open runs
 * it removes. A watcher passes the same to its prune.
 */
export function endsOf(m: ManifestResult | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (m?.ok) for (const p of m.manifest.processes) if (p.promises.some((x) => x.kind === 'within' || x.kind === 'ends')) out[p.name] = p.ends;
  return out;
}

/** Steps grouped per key, each run in order. */
function group(steps: StepRecord[]): Map<string, StepRecord[]> {
  const runs = new Map<string, StepRecord[]>();
  for (const s of steps) {
    const r = runs.get(s.key);
    if (r) r.push(s);
    else runs.set(s.key, [s]);
  }
  return runs;
}

/** Runs with at least one step at or after `since` (design C15). */
function inWindow(runs: Map<string, StepRecord[]>, since: number): Array<[string, StepRecord[]]> {
  return [...runs].filter(([, steps]) => steps.some((s) => s.at >= since));
}

interface Breach {
  key: string;
  at: number;
}

function verdict(base: CheckBase, breaches: Breach[], late: LateRun[]): PromiseCheck {
  const lates = { late: late.sort((a, b) => a.at - b.at).slice(-MAX_KEYS), lateCount: late.length };
  if (!breaches.length) return { ...base, state: 'held', ...lates };
  breaches.sort((a, b) => a.at - b.at);
  return { ...base, state: 'broken', count: breaches.length, keys: breaches.slice(0, MAX_KEYS).map((b) => b.key), lastBreachAt: breaches[breaches.length - 1].at, ...lates };
}

/**
 * `within` and `ends` count the runs overdue now, whatever their age (B7): an open run older than the window is
 * checked too, until it reaches its expected or end step or retention removes it. The window still limits
 * which late arrivals are listed. `once` and `order` check only runs with a step inside the window.
 */
function checkPromise(p: FlightProcess, promise: FlightPromise, runs: Map<string, StepRecord[]>, open: Map<string, StepRecord[]>, minutes: InstanceMinute[], now: number): PromiseCheck {
  const since = now - promise.windowMs;
  const checked = inWindow(runs, since);
  if (promise.kind === 'within' || promise.kind === 'ends') {
    const seen = new Set(checked.map(([k]) => k));
    for (const [k, steps] of open) if (!seen.has(k)) checked.push([k, steps]);
  }
  const base: CheckBase = { process: p.name, id: promise.id, kind: promise.kind, windowMs: promise.windowMs, since, runs: checked.length, stepsDropped: droppedIn(minutes, p.name, since) };
  const breaches: Breach[] = [];
  const late: LateRun[] = [];

  // Design section 7: with steps dropped, a count-based promise cannot be said to hold for the window.
  if ((promise.kind === 'once' || promise.kind === 'order') && base.stepsDropped > 0) return { ...base, state: 'not-checked', reason: 'steps-dropped' };

  for (const [key, steps] of checked) {
    switch (promise.kind) {
      case 'within': {
        // From the run's first `after` step, the first of `expect` that follows it.
        const a = steps.findIndex((s) => s.step === promise.after);
        if (a < 0) break;
        const start = steps[a].at;
        const done = steps.slice(a + 1).find((s) => promise.expect.includes(s.step));
        if (done) {
          if (done.at - start > promise.withinMs && done.at >= since) late.push({ key, lateMs: done.at - start - promise.withinMs, at: done.at });
        } else if (now - start > promise.withinMs) breaches.push({ key, at: start + promise.withinMs });
        break;
      }
      case 'ends': {
        const start = steps[0].at;
        const end = steps.find((s) => p.ends.includes(s.step));
        if (end) {
          if (end.at - start > promise.withinMs && end.at >= since) late.push({ key, lateMs: end.at - start - promise.withinMs, at: end.at });
        } else if (now - start > promise.withinMs) breaches.push({ key, at: start + promise.withinMs });
        break;
      }
      case 'once': {
        const seen = steps.filter((s) => s.step === promise.step);
        if (seen.length > 1) breaches.push({ key, at: seen[1].at });
        break;
      }
      case 'order': {
        let first = false;
        for (const s of steps) {
          if (s.step === promise.first) first = true;
          else if (s.step === promise.then && !first) {
            breaches.push({ key, at: s.at });
            break;
          }
        }
        break;
      }
    }
  }
  return verdict(base, breaches, late);
}

/** `retries: { step: n }`: one first attempt and up to n retries, so n + 1 records per key; one more is a breach. */
function checkRetries(process: string, step: string, n: number, runs: Map<string, StepRecord[]>, minutes: InstanceMinute[], now: number): PromiseCheck {
  const since = now - DEFAULT_WINDOW_MS;
  const checked = inWindow(runs, since);
  const base: CheckBase = { process, id: `retries:${step}`, kind: 'retries', windowMs: DEFAULT_WINDOW_MS, since, runs: checked.length, stepsDropped: droppedIn(minutes, process, since) };
  if (base.stepsDropped > 0) return { ...base, state: 'not-checked', reason: 'steps-dropped' };
  const breaches: Breach[] = [];
  for (const [key, steps] of checked) {
    const seen = steps.filter((s) => s.step === step);
    if (seen.length > n + 1) breaches.push({ key, at: seen[n + 1].at });
  }
  return verdict(base, breaches, []);
}

function checkProbes(m: FlightManifest, minutes: InstanceMinute[], results: ProbeResult[], now: number, blind: BlindFact[]): ProbeCheck[] {
  const recent = minutes.filter((x) => x.minute >= minuteOf(now - RECENT_MS) && x.instance !== PRUNE_INSTANCE);
  const registered = new Set(recent.flatMap((x) => (Array.isArray(x.probes) ? x.probes : [])));
  const declared = new Set(m.probes.map((p) => p.id));
  const latest = new Map(results.map((r) => [r.id, r]));
  if (m.probes.length && !recent.length) blind.push({ kind: 'no-instance', since: now - RECENT_MS });
  for (const id of [...registered].sort()) if (!declared.has(id)) blind.push({ kind: 'probe-not-declared', id });
  return m.probes.map((p): ProbeCheck => {
    const r = latest.get(p.id);
    const head = { id: p.id, everyMs: p.everyMs, lastAt: r ? r.at : null };
    if (!recent.length) return { ...head, state: 'not-checked', reason: 'no-instance' };
    if (!registered.has(p.id)) {
      blind.push({ kind: 'probe-not-registered', id: p.id });
      return { ...head, state: 'not-checked', reason: 'not-registered' };
    }
    if (!r) return { ...head, state: 'not-checked', reason: 'no-result' };
    if (now - r.at > STALE_PERIODS * p.everyMs) {
      blind.push({ kind: 'probe-stale', id: p.id, lastAt: r.at, everyMs: p.everyMs });
      return { ...head, state: 'not-checked', reason: 'stale' };
    }
    return r.ok ? { ...head, state: 'held' } : { ...head, state: 'broken', reason: r.reason || 'returned' };
  });
}
