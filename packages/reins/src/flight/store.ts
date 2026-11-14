// The flight store interface and the memory store (design C3, section 8). A store holds four things: steps;
// a summary per instance per minute (the basics, plus flight's own counts); the latest result of each probe;
// and findings with their state. It also holds the lock that lets one checker at a time run a pass. Everything
// the checker needs is read from the store, so a separate process (the watcher) gets the same answer.
// Imports: Node built-ins and reins' shared modules only (the flight safety test walks this file).
import type { MinuteSummary } from '../recorder.js';
import { isName } from './manifest.js';

/** The longest process key kept. A longer key is refused as invalid, not cut, so two runs never merge. */
export const MAX_KEY = 200;

/** Control characters (U+0000-U+001F, U+007F), and a surrogate that is not one half of a pair. */
const BAD_KEY = /[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * The key as stored: a non-empty string up to MAX_KEY, or a finite number as text. Anything else is invalid,
 * and so is a key with a control character or a lone surrogate: Postgres refuses a NUL byte (and with it the
 * whole batch) and turns a lone surrogate into U+FFFD, which could merge two runs, so every store gets only
 * keys all three keep the same.
 */
export function stepKey(key: unknown): string | undefined {
  if (typeof key === 'number') return Number.isFinite(key) ? String(key) : undefined;
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY && !BAD_KEY.test(key) ? key : undefined;
}

/**
 * The check at the door of every store's `addSteps` (and of the step writer): process and step are manifest
 * names, key and instance are keys as `stepKey` keeps them, and the time is a whole number of ms. A row that
 * fails it is left out, so a bad row from any caller never costs the rest of its batch. The reserved name
 * PRUNED_STEP is not a manifest name, so no caller can write a retention marker.
 */
export const goodStep = (s: StepRecord): boolean =>
  !!s && isName(s.process) && isName(s.step) && typeof s.key === 'string' && stepKey(s.key) === s.key && typeof s.instance === 'string' && stepKey(s.instance) === s.instance && Number.isSafeInteger(s.at) && s.at >= 0;

/** The rows of `steps` that pass `goodStep`. */
export const goodSteps = (steps: StepRecord[]): StepRecord[] => (Array.isArray(steps) ? steps.filter(goodStep) : []);

/** One step of one run of a process (design C7): a bare fact, with no free text and no outcome. */
export interface StepRecord {
  process: string;
  /** Identifies one run for good (C18). */
  key: string;
  step: string;
  /** Wall-clock time in ms (section 8), so instances and restarts compare. */
  at: number;
  /** The server instance that recorded it. */
  instance: string;
}

/** What one server instance saw in one minute. Rewritten as the minute fills; the last write wins. */
export interface InstanceMinute {
  instance: string;
  /** Wall-clock start of the minute, in ms. */
  minute: number;
  /** Requests, upstream calls and runtime from the strict recorder, or null when it was not running. */
  basics: MinuteSummary | null;
  /** Steps lost in this minute, per process: the buffer was full, or the store refused the write. */
  stepsDropped: Record<string, number>;
  /** `flight.step` calls with bad arguments in this minute. They are not steps, so no process is named. */
  stepsInvalid: number;
  /** Steps recorded in this minute, by `process step` (counts only, never keys). Absent when there were none. */
  steps?: Record<string, number>;
  /** Present when development reins is loaded in this instance and NODE_ENV is production (design C12). */
  devModule?: true;
  /**
   * Runs of each process that retention removed whole while they had reached no end step: they may still have
   * been overdue. Written by `prune`, under the instance PRUNE_INSTANCE, so a checker in any process sees it.
   */
  runsPruned?: Record<string, number>;
  /**
   * Markers of each process that retention removed, or did not leave, because more runs held only a marker than
   * its count bound allows (not because of their age): a later step for one of those keys starts a run with no
   * trace of the part removed. Written by `prune` under PRUNE_INSTANCE, beside `runsPruned`.
   */
  markersDropped?: Record<string, number>;
  /** Step writes the store refused in this minute. */
  storeErrors: number;
  /** Probe ids registered on this instance (sorted). */
  probes: string[];
}

/** The latest result of one probe. Only `ok` is kept: whatever else the function returned is never stored. */
export interface ProbeResult {
  id: string;
  instance: string;
  /** When the run finished, in ms. */
  at: number;
  ok: boolean;
  /** Why it is not ok: it returned something other than `{ ok: true }`, threw, or ran past its time. */
  reason?: ProbeFailure;
  /** How long it ran. */
  ms: number;
}
export type ProbeFailure = 'returned' | 'threw' | 'timeout';

/** A finding with its state. The fields beyond these belong to the findings layer and are kept as given. */
export interface FindingRecord {
  key: string;
  state: 'open' | 'resolved';
  updatedAt: number;
  data: Record<string, unknown>;
}

const NUL_ALL = /\u0000/g;
const LONE_ALL = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Text every store keeps the same: U+0000 removed (Postgres refuses it), a lone surrogate made U+FFFD. */
export const storableText = (s: string): string => s.replace(NUL_ALL, '').replace(LONE_ALL, '�');

/** A JSON value with every string and object key made storable; what JSON cannot hold is left out, as JSON.stringify would. */
function storableJson(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return storableText(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return v;
  if (depth > 32 || typeof v !== 'object') return undefined;
  // As JSON.stringify does: a value with toJSON (a Date) is kept as what toJSON gives. Only below the top level:
  // the top level is a finding's `data`, which stays an object (a Date there keeps its own fields: none).
  if (depth > 0 && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    try {
      return storableJson((v as { toJSON: () => unknown }).toJSON(), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(v)) return v.map((x) => storableJson(x, depth + 1) ?? null);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const y = storableJson(x, depth + 1);
    if (y !== undefined) Object.defineProperty(out, storableText(k), { value: y, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * The findings as every store keeps them (the door of each store's `putFindings`): records of the wrong shape are
 * left out, and the key and every string in `data` are made storable, so a finding whose text holds U+0000 or a
 * lone surrogate is kept, cleaned the same way, by memory, file and Postgres alike.
 */
export function storableFindings(list: FindingRecord[]): FindingRecord[] {
  if (!Array.isArray(list)) return [];
  const out: FindingRecord[] = [];
  for (const f of list) {
    if (!f || typeof f !== 'object' || typeof f.key !== 'string' || (f.state !== 'open' && f.state !== 'resolved') || !Number.isFinite(f.updatedAt)) continue;
    const key = storableText(f.key);
    if (!key) continue;
    const data = f.data && typeof f.data === 'object' && !Array.isArray(f.data) ? (storableJson(f.data) as Record<string, unknown>) : {};
    out.push({ key, state: f.state, updatedAt: f.updatedAt, data });
  }
  return out;
}

/** Bounds on what a store keeps. Applied by `prune`, which the lock holder calls. */
export interface Retention {
  /** Runs whose newest step is older than this go whole; so do summaries and resolved findings older than this. Default 7 days. */
  maxAgeMs?: number;
  /**
   * At most this many steps; whole runs go, those with the oldest newest step first. Default 1,000,000 (memory
   * store 100,000). Each run removed leaves one marker step (PRUNED_STEP); markers are not counted here but have
   * their own bounds: at most this many runs holding only a marker, each kept for MARKER_AGE_FACTOR times maxAgeMs.
   * Runs that hold real steps and a marker (part of them was removed, then a step came again) hold one more
   * marker each, so the worst case after a prune is about 3 x maxSteps rows: maxSteps real steps (up to maxSteps
   * runs, each with a marker) and maxSteps marker-only runs. Measured: 12 rows at maxSteps 4.
   */
  maxSteps?: number;
}

export const RETENTION_DEFAULTS: Required<Retention> = { maxAgeMs: 7 * 86_400_000, maxSteps: 1_000_000 };

/**
 * The longest lease a checker lock can have. A longer `ttlMs` is cut to it, and a lock whose time is later than
 * now plus this (planted, or written by a checker whose clock runs ahead) is treated as stale and taken over.
 */
export const MAX_LOCK_MS = 86_400_000;

/** The time a lock taken now for `ttlMs` lasts until: at least 1 ms, at most MAX_LOCK_MS. */
export const lockUntil = (now: number, ttlMs: number) => now + Math.min(MAX_LOCK_MS, Math.max(1, Number.isFinite(ttlMs) ? ttlMs : 1));

/** Whether a lock with this `until` still holds at `now`: not past its time, and not impossibly far ahead. */
export const lockHeld = (until: unknown, now: number) => typeof until === 'number' && until > now && until <= now + MAX_LOCK_MS;

export interface FlightStore {
  /** `memory`, `file` or `postgres`. */
  readonly kind: string;
  addSteps(steps: StepRecord[]): Promise<void>;
  /**
   * Every step of every run of `process` that has at least one step at or after `since`, including that run's
   * steps from before `since` and after its end (design C15, C18). Ordered by time, then by the order written.
   */
  runSteps(process: string, since: number): Promise<StepRecord[]>;
  /**
   * Every step of every run of `process`, of any age, that has reached none of the `ends` steps: the runs that
   * may be overdue for a `within` or `ends` promise however old they are. Same order as `runSteps`.
   */
  openRuns(process: string, ends: string[]): Promise<StepRecord[]>;
  /** Writes one instance's minute, replacing an earlier write of the same instance and minute. */
  putMinute(m: InstanceMinute): Promise<void>;
  /** Instance minutes at or after `since`, oldest first. */
  minutes(since: number): Promise<InstanceMinute[]>;
  /** Keeps the result as the latest for its probe id, unless a later one is already stored. */
  putProbe(r: ProbeResult): Promise<void>;
  /** The latest result of each probe. */
  probes(): Promise<ProbeResult[]>;
  /** Writes findings, replacing earlier ones with the same key. */
  putFindings(f: FindingRecord[]): Promise<void>;
  findings(): Promise<FindingRecord[]>;
  /**
   * Takes or renews the checker lock for `owner` until `now + ttlMs`. Returns true when `owner` holds it. A lock
   * whose time has passed (its checker died) is taken over. Only one owner can hold it at a time.
   */
  lock(owner: string, ttlMs: number, now?: number): Promise<boolean>;
  /** Gives the lock up, if `owner` holds it. */
  unlock(owner: string): Promise<void>;
  /**
   * Removes what is past the retention bounds, always whole runs, each leaving a marker (see PRUNED_STEP and
   * `Retention.maxSteps`); `runSteps` returns markers like other steps. With `ends` (the end steps per process), runs of those
   * processes removed while they had reached no end step are counted and written as `runsPruned`, so retention
   * never silently drops a run that may be overdue.
   */
  prune(r?: Retention, now?: number, ends?: Record<string, string[]>): Promise<void>;
}

/** A store must have every method; anything else is refused by `flight.start`. */
export function isStore(s: unknown): s is FlightStore {
  const o = s as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return false;
  for (const m of ['addSteps', 'runSteps', 'openRuns', 'putMinute', 'minutes', 'putProbe', 'probes', 'putFindings', 'findings', 'lock', 'unlock', 'prune']) {
    if (typeof o[m] !== 'function') return false;
  }
  return true;
}

export const retention = (r: Retention = {}): Required<Retention> => ({
  maxAgeMs: posInt(r.maxAgeMs, RETENTION_DEFAULTS.maxAgeMs),
  maxSteps: posInt(r.maxSteps, RETENTION_DEFAULTS.maxSteps),
});

const posInt = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : d);

/** Orders steps by time, keeping the order written for equal times. */
export const byTime = (a: { at: number; seq: number }, b: { at: number; seq: number }) => a.at - b.at || a.seq - b.seq;

/** Selects the runs of `process` with a step at or after `since`, and returns all their steps in order. */
export function selectRuns<T extends StepRecord>(all: Iterable<T>, process: string, since: number): T[] {
  const keys = new Set<string>();
  const mine: T[] = [];
  for (const s of all) {
    if (s.process !== process) continue;
    mine.push(s);
    if (s.at >= since) keys.add(s.key);
  }
  return mine.filter((s) => keys.has(s.key));
}

/** Selects the runs of `process` that have reached none of `ends`, and returns all their steps in order. */
export function selectOpen<T extends StepRecord>(all: Iterable<T>, process: string, ends: string[]): T[] {
  const ended = new Set<string>();
  const mine: T[] = [];
  for (const s of all) {
    if (s.process !== process) continue;
    mine.push(s);
    if (ends.includes(s.step)) ended.add(s.key);
  }
  return mine.filter((s) => !ended.has(s.key));
}

/** The minute records `prune` writes its counts under. */
export const PRUNE_INSTANCE = '(prune)';

/**
 * The step name of a retention marker. When retention removes a run it leaves this one step in its place, at the
 * time of the run's newest step, so a key keeps naming one run while its marker stays (C18): a later step for that
 * key joins a run known to be partial, which once, order and retries do not judge (blind fact `runs-partial`).
 * A marker goes after MARKER_AGE_FACTOR times the age bound, with no trace, or earlier when more runs hold only a
 * marker than the count bound allows, which is counted (blind fact `markers-dropped`). No manifest
 * name can equal it (names are lowercase letters, digits, dots and hyphens), so `goodStep` refuses it from callers.
 */
export const PRUNED_STEP = '(pruned)';

/** A run holding only its marker goes when the marker is older than this many times the age bound. */
export const MARKER_AGE_FACTOR = 2;

/** One run as retention sees it. */
export interface RunSummary<S extends StepRecord = StepRecord> {
  process: string;
  key: string;
  /** Time of its newest step, marker included. */
  last: number;
  /** Its number of steps other than a marker. */
  real: number;
  /** Whether it holds a marker: part of it was removed before. */
  marked: boolean;
  /** Its steps. */
  steps: S[];
}

/** One id per run: the process and key, without any way for two pairs to give the same text. */
export const runId = (process: string, key: string) => `${process.length}:${process}${key}`;

/** Groups steps into runs for retention. */
export function summarize<S extends StepRecord>(steps: Iterable<S>): Map<string, RunSummary<S>> {
  const runs = new Map<string, RunSummary<S>>();
  for (const s of steps) {
    const id = runId(s.process, s.key);
    let r = runs.get(id);
    if (!r) runs.set(id, (r = { process: s.process, key: s.key, last: s.at, real: 0, marked: false, steps: [] }));
    r.steps.push(s);
    if (s.step === PRUNED_STEP) r.marked = true;
    else r.real++;
    if (s.at > r.last) r.last = s.at;
  }
  return runs;
}

export interface PrunePlan<R> {
  /** Runs whose every step (marker included) is removed. */
  gone: R[];
  /** Those of `gone` that get one marker at their `last` in their place. */
  mark: R[];
  /** Runs left with no marker by the count bound on markers (not by their age): removed ones, or marker-only ones. */
  unmarked: R[];
}

/**
 * Which runs retention removes (design B3, B7), always whole. A run goes when its newest step is before `cut`;
 * then, while more than `maxSteps` steps other than markers are left, the runs whose newest step is oldest go
 * first. Each run that goes leaves a marker. Markers have their own bounds, applied after the cap on real steps:
 * a run holding only its marker goes, with no trace, when the marker is before `markCut`, or when more than
 * `maxMarks` such runs are left (oldest first). `fixed` runs (the file store's segments still being written) are
 * left as they are this time.
 */
export function planPrune<R extends RunSummary<any>>(runs: Iterable<R>, o: { cut: number; markCut: number; maxSteps: number; maxMarks: number }, fixed: (r: R) => boolean = () => false): PrunePlan<R> {
  const gone: R[] = [];
  const left: R[] = [];
  /** Runs that hold only a marker after this prune. */
  const marks: R[] = [];
  let total = 0;
  for (const r of runs) {
    if (!r.real) marks.push(r);
    else if (r.last < o.cut && !fixed(r)) gone.push(r);
    else {
      left.push(r);
      total += r.real;
    }
  }
  if (total > o.maxSteps) {
    left.sort((a, b) => a.last - b.last);
    for (const r of left) {
      if (total <= o.maxSteps) break;
      if (fixed(r)) continue;
      gone.push(r);
      total -= r.real;
    }
  }
  const removed = new Set(gone);
  // One at a time: spread into push, a prune of some hundred thousand runs passes more arguments than a call takes (B8).
  for (const r of gone) marks.push(r);
  marks.sort((a, b) => b.last - a.last);
  const mark: R[] = [];
  const unmarked: R[] = [];
  let kept = 0;
  for (const r of marks) {
    if (fixed(r) || (r.last >= o.markCut && kept < o.maxMarks)) {
      kept++;
      if (removed.has(r)) mark.push(r);
    } else {
      if (!removed.has(r)) gone.push(r);
      if (r.last >= o.markCut) unmarked.push(r);
    }
  }
  return { gone, mark, unmarked };
}

/** The bounds `planPrune` takes, from a retention and the time of the prune. */
export const pruneBounds = (k: Required<Retention>, now: number, maxSteps = k.maxSteps) => ({ cut: now - k.maxAgeMs, markCut: now - MARKER_AGE_FACTOR * k.maxAgeMs, maxSteps, maxMarks: k.maxSteps });

/**
 * Counts, per process named in `ends`, the removed runs that had reached no end step: they may have been overdue.
 * A run that held a marker is not counted again (it was counted when its first part was removed), nor is a run
 * that holds only a marker.
 */
export function countOpen(gone: Iterable<Pick<RunSummary, 'process' | 'steps' | 'real' | 'marked'>>, ends: Record<string, string[]> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of gone) {
    const e = Object.prototype.hasOwnProperty.call(ends, r.process) ? ends[r.process] : undefined;
    if (Array.isArray(e) && r.real && !r.marked && !r.steps.some((s) => e.includes(s.step))) out[r.process] = (out[r.process] || 0) + 1;
  }
  return out;
}

/** Counts runs per process. */
export function perProcess(runs: Iterable<Pick<RunSummary, 'process'>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs) out[r.process] = (out[r.process] || 0) + 1;
  return out;
}

/** The marker step left for a removed run. */
export const markerOf = (r: Pick<RunSummary, 'process' | 'key' | 'last'>): StepRecord => ({ process: r.process, key: r.key, step: PRUNED_STEP, at: r.last, instance: PRUNE_INSTANCE });

/**
 * Adds pruned-run counts (`runsPruned`) and dropped-marker counts (`markersDropped`) to this minute's
 * PRUNE_INSTANCE record in the store.
 */
export async function recordPruned(store: Pick<FlightStore, 'minutes' | 'putMinute'>, counts: Record<string, number>, now: number, markers: Record<string, number> = {}): Promise<void> {
  if (!Object.keys(counts).length && !Object.keys(markers).length) return;
  const minute = now - (now % 60_000);
  const old = (await store.minutes(minute)).find((m) => m.instance === PRUNE_INSTANCE && m.minute === minute);
  const add = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [p, n] of Object.entries(from)) into[p] = (Number(into[p]) || 0) + n;
    return into;
  };
  const runsPruned = add({ ...(old?.runsPruned || {}) }, counts);
  const markersDropped = add({ ...(old?.markersDropped || {}) }, markers);
  await store.putMinute({
    instance: PRUNE_INSTANCE,
    minute,
    basics: null,
    stepsDropped: {},
    stepsInvalid: 0,
    storeErrors: 0,
    probes: [],
    runsPruned,
    ...(Object.keys(markersDropped).length && { markersDropped }),
  });
}

/** Keeps the later of two probe results. */
export const laterProbe = (old: ProbeResult | undefined, r: ProbeResult) => !old || r.at >= old.at;

/**
 * The memory store's default cap on steps, where the file and Postgres stores keep RETENTION_DEFAULTS.maxSteps.
 * 100,000 steps with 200-character keys measured about 47 MB of heap on their own; with the markers that can come
 * on top (up to 3 x maxSteps rows in all, see `Retention.maxSteps`) the worst case measured about 118 MB of heap.
 * `memoryStore({ maxSteps })` sets it.
 */
export const MEMORY_MAX_STEPS = 100_000;

/**
 * The memory store: for tests and a single process. Two checkers given the same memory store share its lock.
 * Steps are held per process and per run, so reads touch only the runs of one process. It applies `maxSteps`
 * as steps are added (removing whole runs, oldest first, down to nine tenths of the cap so that this happens
 * seldom), so it cannot grow without limit even if nothing prunes it.
 */
export function memoryStore(r: Retention & { ends?: Record<string, string[]> } = {}): FlightStore {
  const keep = { maxAgeMs: retention(r).maxAgeMs, maxSteps: posInt(r?.maxSteps, MEMORY_MAX_STEPS) };
  type Stored = StepRecord & { seq: number };
  type Run = RunSummary<Stored>;
  const runs = new Map<string, Map<string, Run>>();
  /** Steps held, markers not counted. */
  let total = 0;
  let seq = 0;
  const minutes = new Map<string, InstanceMinute>();
  const probes = new Map<string, ProbeResult>();
  const findings = new Map<string, FindingRecord>();
  let held: { owner: string; until: number } | null = null;
  /**
   * The end steps of each process with a within or ends promise, so the cap applied on add counts the open runs
   * it removes: given when flight starts (`ends`), and by each prune.
   */
  let lastEnds: Record<string, string[]> = r?.ends && typeof r.ends === 'object' ? r.ends : {};

  const allRuns = function* () {
    for (const m of runs.values()) yield* m.values();
  };
  /** Removes whole runs, leaves the markers planned, and records the open runs among those removed. */
  const remove = async (plan: PrunePlan<Run>, ends: Record<string, string[]>, now: number) => {
    for (const run of plan.gone) {
      const m = runs.get(run.process);
      if (!m?.delete(run.key)) continue;
      total -= run.real;
      if (!m.size) runs.delete(run.process);
    }
    for (const run of plan.mark) {
      let m = runs.get(run.process);
      if (!m) runs.set(run.process, (m = new Map()));
      m.set(run.key, { process: run.process, key: run.key, last: run.last, real: 0, marked: true, steps: [{ ...markerOf(run), seq: seq++ }] });
    }
    await recordPruned(self, countOpen(plan.gone, ends), now, perProcess(plan.unmarked));
  };
  const read = (process: string, pick: (run: Run) => boolean): StepRecord[] => {
    const out: Stored[] = [];
    for (const run of runs.get(process)?.values() || []) if (pick(run)) out.push(...run.steps);
    return out.sort(byTime).map(({ seq: _, ...s }) => s);
  };

  const self: FlightStore = {
    kind: 'memory',
    async addSteps(list) {
      for (const s of goodSteps(list)) {
        let m = runs.get(s.process);
        if (!m) runs.set(s.process, (m = new Map()));
        let run = m.get(s.key);
        if (!run) m.set(s.key, (run = { process: s.process, key: s.key, last: s.at, real: 0, marked: false, steps: [] }));
        run.steps.push({ process: s.process, key: s.key, step: s.step, at: s.at, instance: s.instance, seq: seq++ });
        run.real++;
        if (s.at > run.last) run.last = s.at;
        total++;
      }
      if (total > keep.maxSteps) {
        const plan = planPrune(allRuns(), { cut: -Infinity, markCut: -Infinity, maxSteps: keep.maxSteps - Math.floor(keep.maxSteps / 10), maxMarks: keep.maxSteps });
        await remove(plan, lastEnds, Date.now());
      }
    },
    async runSteps(process, since) {
      return read(process, (run) => run.last >= since);
    },
    async openRuns(process, ends) {
      return read(process, (run) => !run.steps.some((s) => ends.includes(s.step)));
    },
    async putMinute(m) {
      minutes.set(`${m.instance} ${m.minute}`, structuredClone(m));
    },
    async minutes(since) {
      return [...minutes.values()].filter((m) => m.minute >= since).sort((a, b) => a.minute - b.minute).map((m) => structuredClone(m));
    },
    async putProbe(p) {
      if (laterProbe(probes.get(p.id), p)) probes.set(p.id, { ...p });
    },
    async probes() {
      return [...probes.values()].map((p) => ({ ...p }));
    },
    async putFindings(list) {
      for (const f of storableFindings(list)) findings.set(f.key, f);
    },
    async findings() {
      return [...findings.values()].map((f) => structuredClone(f));
    },
    async lock(owner, ttlMs, now = Date.now()) {
      if (held && held.owner !== owner && lockHeld(held.until, now)) return false;
      held = { owner, until: lockUntil(now, ttlMs) };
      return true;
    },
    async unlock(owner) {
      if (held?.owner === owner) held = null;
    },
    async prune(r2 = {}, now = Date.now(), ends = {}) {
      lastEnds = ends;
      const k = retention({ ...keep, ...r2 });
      const cut = now - k.maxAgeMs;
      for (const [id, m] of minutes) if (m.minute < cut) minutes.delete(id);
      for (const [id, p] of probes) if (p.at < cut) probes.delete(id);
      for (const [id, f] of findings) if (f.state === 'resolved' && f.updatedAt < cut) findings.delete(id);
      await remove(planPrune(allRuns(), pruneBounds(k, now)), ends, now);
    },
  };
  return self;
}
