// The flight store interface and the memory store (design C3, section 8). A store holds four things: steps;
// a summary per instance per minute (the basics, plus flight's own counts); the latest result of each probe;
// and findings with their state. It also holds the lock that lets one checker at a time run a pass. Everything
// the checker needs is read from the store, so a separate process (the watcher) gets the same answer.
// Imports: Node built-ins and reins' shared modules only (the flight safety test walks this file).
import type { MinuteSummary } from '../recorder.js';

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
  /**
   * Runs of each process that retention removed whole while they had reached no end step: they may still have
   * been overdue. Written by `prune`, under the instance PRUNE_INSTANCE, so a checker in any process sees it.
   */
  runsPruned?: Record<string, number>;
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

/** Bounds on what a store keeps. Applied by `prune`, which the lock holder calls. */
export interface Retention {
  /** Runs whose newest step is older than this go whole; so do summaries and resolved findings older than this. Default 7 days. */
  maxAgeMs?: number;
  /** At most this many steps; whole runs go, those with the oldest newest step first. Default 1,000,000 (memory store 100,000). */
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
   * Removes what is past the retention bounds, always whole runs. With `ends` (the end steps per process), runs of those
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

/** One run as retention sees it. */
export interface RunSummary {
  process: string;
  key: string;
  /** Time of its newest step. */
  last: number;
  /** Its number of steps. */
  size: number;
  /** Its steps. */
  steps: StepRecord[];
}

/** One id per run: the process and key, without any way for two pairs to give the same text. */
export const runId = (process: string, key: string) => `${process.length}:${process}${key}`;

/**
 * Which runs retention removes (design B3, B7). Retention works on whole runs, never single steps, so no
 * promise is ever judged on a run missing part of its steps: a run goes when its newest step is before `cut`;
 * then, while more than `maxSteps` steps are left, the runs whose newest step is oldest go first.
 */
export function planPrune<R extends Pick<RunSummary, 'last' | 'size'>>(runs: Iterable<R>, cut: number, maxSteps: number): R[] {
  const gone: R[] = [];
  const left: R[] = [];
  let total = 0;
  for (const r of runs) {
    if (r.last < cut) gone.push(r);
    else {
      left.push(r);
      total += r.size;
    }
  }
  if (total > maxSteps) {
    left.sort((a, b) => a.last - b.last);
    for (const r of left) {
      if (total <= maxSteps) break;
      gone.push(r);
      total -= r.size;
    }
  }
  return gone;
}

/** Counts, per process named in `ends`, the removed runs that had reached no end step: they may have been overdue. */
export function countOpen(gone: Iterable<Pick<RunSummary, 'process' | 'steps'>>, ends: Record<string, string[]> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of gone) {
    const e = Object.prototype.hasOwnProperty.call(ends, r.process) ? ends[r.process] : undefined;
    if (Array.isArray(e) && !r.steps.some((s) => e.includes(s.step))) out[r.process] = (out[r.process] || 0) + 1;
  }
  return out;
}

/** Adds pruned-run counts to this minute's PRUNE_INSTANCE record in the store. */
export async function recordPruned(store: Pick<FlightStore, 'minutes' | 'putMinute'>, counts: Record<string, number>, now: number): Promise<void> {
  if (!Object.keys(counts).length) return;
  const minute = now - (now % 60_000);
  const old = (await store.minutes(minute)).find((m) => m.instance === PRUNE_INSTANCE && m.minute === minute);
  const runsPruned: Record<string, number> = { ...(old?.runsPruned || {}) };
  for (const [p, n] of Object.entries(counts)) runsPruned[p] = (runsPruned[p] || 0) + n;
  await store.putMinute({ instance: PRUNE_INSTANCE, minute, basics: null, stepsDropped: {}, stepsInvalid: 0, storeErrors: 0, probes: [], runsPruned });
}

/** Keeps the later of two probe results. */
export const laterProbe = (old: ProbeResult | undefined, r: ProbeResult) => !old || r.at >= old.at;

/**
 * The memory store's default cap on steps: small enough that the app does not feel it (some tens of MB at
 * most), where the file and Postgres stores keep RETENTION_DEFAULTS.maxSteps. `memoryStore({ maxSteps })` sets it.
 */
export const MEMORY_MAX_STEPS = 100_000;

/**
 * The memory store: for tests and a single process. Two checkers given the same memory store share its lock.
 * Steps are held per process and per run, so reads touch only the runs of one process. It applies `maxSteps`
 * as steps are added (removing whole runs, oldest first, down to nine tenths of the cap so that this happens
 * seldom), so it cannot grow without limit even if nothing prunes it.
 */
export function memoryStore(r: Retention = {}): FlightStore {
  const keep = { maxAgeMs: retention(r).maxAgeMs, maxSteps: posInt(r?.maxSteps, MEMORY_MAX_STEPS) };
  type Stored = StepRecord & { seq: number };
  type Run = { process: string; key: string; last: number; size: number; steps: Stored[] };
  const runs = new Map<string, Map<string, Run>>();
  let total = 0;
  let seq = 0;
  const minutes = new Map<string, InstanceMinute>();
  const probes = new Map<string, ProbeResult>();
  const findings = new Map<string, FindingRecord>();
  let held: { owner: string; until: number } | null = null;
  /** The end steps the last prune was given, so the cap applied on add counts open runs it removes too. */
  let lastEnds: Record<string, string[]> = {};

  const allRuns = function* () {
    for (const m of runs.values()) yield* m.values();
  };
  /** Removes whole runs and records the open ones among them. */
  const remove = async (gone: Run[], ends: Record<string, string[]>, now: number) => {
    for (const run of gone) {
      const m = runs.get(run.process);
      if (!m?.delete(run.key)) continue;
      total -= run.size;
      if (!m.size) runs.delete(run.process);
    }
    await recordPruned(self, countOpen(gone, ends), now);
  };
  const read = (process: string, pick: (run: Run) => boolean): StepRecord[] => {
    const out: Stored[] = [];
    for (const run of runs.get(process)?.values() || []) if (pick(run)) out.push(...run.steps);
    return out.sort(byTime).map(({ seq: _, ...s }) => s);
  };

  const self: FlightStore = {
    kind: 'memory',
    async addSteps(list) {
      for (const s of list) {
        let m = runs.get(s.process);
        if (!m) runs.set(s.process, (m = new Map()));
        let run = m.get(s.key);
        if (!run) m.set(s.key, (run = { process: s.process, key: s.key, last: s.at, size: 0, steps: [] }));
        run.steps.push({ process: s.process, key: s.key, step: s.step, at: s.at, instance: s.instance, seq: seq++ });
        run.size++;
        if (s.at > run.last) run.last = s.at;
        total++;
      }
      if (total > keep.maxSteps) {
        await remove(planPrune(allRuns(), -Infinity, keep.maxSteps - Math.floor(keep.maxSteps / 10)), lastEnds, Date.now());
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
      for (const f of list) findings.set(f.key, structuredClone(f));
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
      await remove(planPrune(allRuns(), cut, k.maxSteps), ends, now);
    },
  };
  return self;
}
