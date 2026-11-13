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
  /** Steps, summaries and resolved findings older than this go. Default 7 days. */
  maxAgeMs?: number;
  /** At most this many steps; the oldest go first. Default 1,000,000. */
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
   * Removes what is past the retention bounds. With `ends` (the end steps per process), runs of those processes
   * removed whole while they had reached no end step are counted and written as `runsPruned`, so retention
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
 * Counts, per process named in `ends`, the runs whose steps are all in `removed` (none left in `kept`) and
 * that had reached no end step.
 */
export function countOpenRemoved(removed: Iterable<StepRecord>, kept: Iterable<StepRecord>, ends: Record<string, string[]> = {}): Record<string, number> {
  const id = (s: StepRecord) => `${s.process}\n${s.key}`;
  const left = new Set<string>();
  for (const s of kept) if (ends[s.process]) left.add(id(s));
  const runs = new Map<string, { process: string; ended: boolean }>();
  for (const s of removed) {
    const e = ends[s.process];
    if (!e || left.has(id(s))) continue;
    const r = runs.get(id(s)) || { process: s.process, ended: false };
    r.ended ||= e.includes(s.step);
    runs.set(id(s), r);
  }
  const out: Record<string, number> = {};
  for (const r of runs.values()) if (!r.ended) out[r.process] = (out[r.process] || 0) + 1;
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
 * The memory store: for tests and a single process. Two checkers given the same memory store share its lock.
 * It applies `maxSteps` as steps are added, so it cannot grow without limit even if nothing prunes it.
 */
export function memoryStore(r: Retention = {}): FlightStore {
  const keep = retention(r);
  let steps: Array<StepRecord & { seq: number }> = [];
  let seq = 0;
  const minutes = new Map<string, InstanceMinute>();
  const probes = new Map<string, ProbeResult>();
  const findings = new Map<string, FindingRecord>();
  let held: { owner: string; until: number } | null = null;
  /** The end steps the last prune was given, so the cap applied on add counts open runs it removes too. */
  let lastEnds: Record<string, string[]> = {};
  const self: FlightStore = {
    kind: 'memory',
    async addSteps(list) {
      for (const s of list) steps.push({ ...s, seq: seq++ });
      if (steps.length > keep.maxSteps) {
        const cut = steps.length - keep.maxSteps;
        const removed = steps.slice(0, cut);
        steps = steps.slice(cut);
        await recordPruned(self, countOpenRemoved(removed, steps, lastEnds), Date.now());
      }
    },
    async runSteps(process, since) {
      return selectRuns(steps, process, since)
        .sort(byTime)
        .map(({ seq: _, ...s }) => s);
    },
    async openRuns(process, ends) {
      return selectOpen(steps, process, ends)
        .sort(byTime)
        .map(({ seq: _, ...s }) => s);
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
      const before = steps;
      steps = steps.filter((s) => s.at >= cut);
      if (steps.length > k.maxSteps) steps = steps.slice(steps.length - k.maxSteps);
      const kept = new Set(steps);
      for (const [id, m] of minutes) if (m.minute < cut) minutes.delete(id);
      for (const [id, p] of probes) if (p.at < cut) probes.delete(id);
      for (const [id, f] of findings) if (f.state === 'resolved' && f.updatedAt < cut) findings.delete(id);
      await recordPruned(self, countOpenRemoved(before.filter((s) => !kept.has(s)), steps, ends), now);
    },
  };
  return self;
}
