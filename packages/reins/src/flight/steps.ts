// The step writer (design section 3, C7, section 7 "Cannot hurt the app"). `step()` checks its arguments,
// puts the step in a bounded queue and returns at once; it never throws and never waits for the store. A timer
// writes the queue to the store. A step that does not fit (the queue is full) or that the store refuses is
// counted as dropped for its process, in the minute it was lost. Those counts, with this instance's basics
// and its registered probes, go to the store as one record per minute, so a checker in another process can
// see them (section 8).
// Imports: Node built-ins and reins' shared modules only (the flight safety test walks this file).
import type { MinuteSummary } from '../recorder.js';
import { isName } from './manifest.js';
import type { FlightStore, InstanceMinute, StepRecord } from './store.js';

export const STEP_DEFAULTS = { bufferSize: 10_000, flushMs: 1000, minuteMs: 15_000 };
/** The longest process key kept. A longer key is refused as invalid, not cut, so two runs never merge. */
export const MAX_KEY = 200;
/** Distinct process names counted per minute; beyond this, drops are counted under OTHER_PROCESS. */
const MAX_PROCESSES = 200;
export const OTHER_PROCESS = '(other)';
/** Minutes of drop counts kept in memory after they were written. */
const KEEP_MINUTES = 5;

export interface StepWriterOptions {
  store: FlightStore;
  instance: string;
  /** Steps queued at most. Default 10,000. */
  bufferSize?: number;
  /** How often the queue is written. Default 1 s. */
  flushMs?: number;
  /** How often this instance's minute records are written. Default 15 s. */
  minuteMs?: number;
  /** The strict recorder's minute summaries, when it runs. */
  basics?: () => MinuteSummary[];
  /** Probe ids registered on this instance. */
  probes?: () => string[];
}

interface Facts {
  dropped: Record<string, number>;
  invalid: number;
  storeErrors: number;
}

const int = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : d);
const minuteOf = (t: number) => t - (t % 60_000);

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

/** Store calls spent at most on saving the good rows of one refused batch (it is split in halves). */
const SALVAGE_CALLS = 64;

export function createStepWriter(o: StepWriterOptions) {
  const store = o.store;
  const size = int(o.bufferSize, STEP_DEFAULTS.bufferSize, 1, 1_000_000);
  const flushMs = int(o.flushMs, STEP_DEFAULTS.flushMs, 10, 3_600_000);
  const minuteMs = int(o.minuteMs, STEP_DEFAULTS.minuteMs, 10, 3_600_000);
  let queue: StepRecord[] = [];
  const facts = new Map<number, Facts>();
  const totals = { accepted: 0, written: 0, dropped: 0, invalid: 0, storeErrors: 0 };
  let timers: Array<ReturnType<typeof setInterval>> = [];
  let flushing: Promise<void> | null = null;
  let minuting: Promise<void> | null = null;

  const factsOf = (t: number) => {
    const m = minuteOf(t);
    let f = facts.get(m);
    if (!f) facts.set(m, (f = { dropped: {}, invalid: 0, storeErrors: 0 }));
    return f;
  };

  function drop(process: string, n: number, t: number) {
    const f = factsOf(t);
    const name = process in f.dropped || Object.keys(f.dropped).length < MAX_PROCESSES ? process : OTHER_PROCESS;
    f.dropped[name] = (f.dropped[name] || 0) + n;
    totals.dropped += n;
  }

  /** Counts the steps of `lost` as dropped for their processes. */
  function dropAll(lost: StepRecord[], now: number) {
    const per = new Map<string, number>();
    for (const s of lost) per.set(s.process, (per.get(s.process) || 0) + 1);
    for (const [p, n] of per) drop(p, n, now);
  }

  /**
   * A batch the store refused: one bad row must not cost the others. The batch is split in halves and each half
   * tried again, down to single rows, within SALVAGE_CALLS store calls; what is still unsaved is counted as
   * dropped, row for row. Returns whether every row was saved.
   */
  async function salvage(batch: StepRecord[]): Promise<boolean> {
    let calls = 0;
    const lost: StepRecord[] = [];
    const parts: StepRecord[][] = [batch.slice(0, batch.length >> 1), batch.slice(batch.length >> 1)];
    while (parts.length) {
      const part = parts.shift()!;
      if (!part.length) continue;
      if (calls >= SALVAGE_CALLS) {
        lost.push(...part);
        continue;
      }
      calls++;
      try {
        await store.addSteps(part);
        totals.written += part.length;
      } catch {
        if (part.length === 1) lost.push(part[0]);
        else parts.unshift(part.slice(0, part.length >> 1), part.slice(part.length >> 1));
      }
    }
    if (lost.length) dropAll(lost, Date.now());
    return !lost.length;
  }

  async function writeSteps(): Promise<void> {
    while (queue.length) {
      const batch = queue;
      queue = [];
      try {
        await store.addSteps(batch);
        totals.written += batch.length;
      } catch {
        // One store error per refused batch, however many calls saving its good rows takes.
        factsOf(Date.now()).storeErrors++;
        totals.storeErrors++;
        if (batch.length === 1) dropAll(batch, Date.now());
        else if (await salvage(batch)) continue;
        return;
      }
    }
  }

  async function writeMinutes(): Promise<void> {
    const now = Date.now();
    const current = minuteOf(now);
    const wanted = new Set<number>([current, current - 60_000, ...facts.keys()]);
    let basics: MinuteSummary[] = [];
    try {
      basics = o.basics ? o.basics() : [];
    } catch {}
    let probes: string[] = [];
    try {
      probes = o.probes ? [...o.probes()].sort() : [];
    } catch {}
    for (const minute of [...wanted].sort((a, b) => a - b)) {
      const f = facts.get(minute);
      const m: InstanceMinute = {
        instance: o.instance,
        minute,
        basics: basics.find((b) => b.minute === minute) || null,
        stepsDropped: { ...(f?.dropped || {}) },
        stepsInvalid: f?.invalid || 0,
        storeErrors: f?.storeErrors || 0,
        probes,
      };
      try {
        await store.putMinute(m);
      } catch {
        // The counts stay in memory and are written on the next pass.
        factsOf(Date.now()).storeErrors++;
        totals.storeErrors++;
        return;
      }
    }
    for (const m of facts.keys()) if (m < current - KEEP_MINUTES * 60_000) facts.delete(m);
  }

  const once = <T>(get: () => Promise<T> | null, set: (p: Promise<T> | null) => void, run: () => Promise<T>) => {
    const cur = get();
    if (cur) return cur;
    const p = run().finally(() => set(null));
    set(p);
    return p;
  };
  const flushSteps = () => once(() => flushing, (p) => (flushing = p), writeSteps);
  const flushMinutes = () => once(() => minuting, (p) => (minuting = p), writeMinutes);

  return {
    /**
     * Records one step. Returns at once with whether the step was queued; never throws and never waits.
     * Bad arguments are counted as invalid; a full queue counts the step as dropped for its process.
     */
    step(process: unknown, key: unknown, step: unknown): boolean {
      try {
        const now = Date.now();
        const k = stepKey(key);
        if (!isName(process) || !isName(step) || k === undefined) {
          factsOf(now).invalid++;
          totals.invalid++;
          return false;
        }
        if (queue.length >= size) {
          drop(process, 1, now);
          return false;
        }
        queue.push({ process, key: k, step, at: now, instance: o.instance });
        totals.accepted++;
        return true;
      } catch {
        return false;
      }
    },
    start() {
      if (timers.length) return;
      timers = [setInterval(() => void flushSteps().catch(() => {}), flushMs), setInterval(() => void flushMinutes().catch(() => {}), minuteMs)];
      for (const t of timers) (t as any).unref?.();
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
    },
    /** Writes the queue and this instance's minute records now. Never rejects. */
    async flush(): Promise<void> {
      try {
        if (flushing) await flushing;
        await flushSteps();
        if (minuting) await minuting;
        await flushMinutes();
      } catch {}
    },
    stats: () => ({ ...totals, queued: queue.length }),
  };
}

export type StepWriter = ReturnType<typeof createStepWriter>;
