// Probes (design section 3 step 4, section 4): a check on the app's own data, registered in code under the id
// the manifest declares. A run that returns `{ ok: true }` holds; anything else it returns, a throw, or a run
// past its time is a breach. Only `ok` is kept: what the function returned beyond that is never stored,
// because it may hold the app's data. Probes run in the server (they read the app's data) and write their
// latest result to the store, where the checker reads it.
// Imports: Node built-ins and reins' shared modules only (the flight safety test walks this file).
import type { FlightProbe } from './manifest.js';
import { isName } from './manifest.js';
import type { FlightStore, ProbeResult } from './store.js';

export type ProbeFn = () => unknown;
export const PROBE_TIMEOUT_MS = 10_000;
/** Probes registered at most, so a loop calling `flight.probe` cannot grow the registry without limit. */
const MAX_PROBES = 200;

export function createProbes() {
  const fns = new Map<string, ProbeFn>();
  let running: { stop(): void } | null = null;
  let onRegister: ((id: string) => void) | null = null;

  return {
    /** Registers `fn` under `id`. Returns whether it was registered; never throws. A second call replaces it. */
    register(id: unknown, fn: unknown): boolean {
      try {
        if (!isName(id) || typeof fn !== 'function') return false;
        if (!fns.has(id) && fns.size >= MAX_PROBES) return false;
        fns.set(id, fn as ProbeFn);
        onRegister?.(id);
        return true;
      } catch {
        return false;
      }
    },
    ids: () => [...fns.keys()],
    get: (id: string) => fns.get(id),
    /** Runs every declared probe that is registered, at once and then every `everyMs`, writing results. */
    start(o: { store: FlightStore; instance: string; declared: FlightProbe[]; timeoutMs?: number; onError?: () => void }) {
      running?.stop();
      const timers = new Map<string, ReturnType<typeof setInterval>>();
      /** Probes with a call to the app's function that has not settled, and when it started. */
      const busy = new Map<string, number>();
      const every = new Map(o.declared.map((p) => [p.id, p.everyMs]));
      const timeoutMs = Math.max(1, o.timeoutMs ?? PROBE_TIMEOUT_MS);
      /** Probes with a store write that has not settled. At most one write per probe is outstanding: while
       * one hangs (a lock on the probes table, a full pool), a newer result is skipped and counted as a store
       * error, so a hung store never collects one more pending write, and one more pool connection, per period. */
      const putting = new Set<string>();
      const put = (r: ProbeResult): Promise<void> => {
        if (putting.has(r.id)) {
          o.onError?.();
          return Promise.resolve();
        }
        putting.add(r.id);
        let write: Promise<unknown>;
        try {
          write = Promise.resolve(o.store.putProbe(r));
        } catch (e) {
          write = Promise.reject(e);
        }
        return write.then(
          () => {
            putting.delete(r.id);
          },
          () => {
            putting.delete(r.id);
            o.onError?.();
          },
        );
      };
      const tick = (id: string) => {
        const fn = fns.get(id);
        if (!fn) return;
        const started = busy.get(id);
        if (started !== undefined) {
          // The last call has not settled: it is not called again (it may hold one of the app's database
          // connections), and while it is past its time the probe stays reported as broken by timeout.
          const now = Date.now();
          if (now - started >= timeoutMs) void put({ id, instance: o.instance, at: now, ok: false, reason: 'timeout', ms: now - started });
          return;
        }
        busy.set(id, Date.now());
        let settled!: () => void;
        const done = new Promise<void>((resolve) => (settled = resolve));
        const watched: ProbeFn = () => {
          try {
            const v = fn();
            Promise.resolve(v).then(settled, settled);
            return v;
          } catch (e) {
            settled();
            throw e;
          }
        };
        void runProbe(id, watched, o.instance, timeoutMs)
          .then(put)
          .then(() => done)
          .finally(() => busy.delete(id));
      };
      const schedule = (id: string) => {
        const ms = every.get(id);
        if (ms === undefined || timers.has(id) || !fns.has(id)) return;
        const t = setInterval(() => tick(id), ms);
        (t as any).unref?.();
        timers.set(id, t);
        const first = setTimeout(() => tick(id), 0);
        (first as any).unref?.();
      };
      for (const id of every.keys()) schedule(id);
      onRegister = schedule;
      running = {
        stop() {
          for (const t of timers.values()) clearInterval(t);
          timers.clear();
          onRegister = null;
        },
      };
    },
    stop() {
      running?.stop();
      running = null;
    },
  };
}

/** Runs one probe. Never rejects: a throw or a timeout is a result. */
export async function runProbe(id: string, fn: ProbeFn, instance: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ fail: 'timeout' }>((res) => {
    timer = setTimeout(() => res({ fail: 'timeout' }), Math.max(1, timeoutMs));
    (timer as any).unref?.();
  });
  const call = new Promise<unknown>((res) => res(fn())).then(
    (value) => ({ value }),
    () => ({ fail: 'threw' as const }),
  );
  const out: any = await Promise.race([call, timeout]);
  clearTimeout(timer);
  const at = Date.now();
  let ok = false;
  try {
    ok = !out.fail && !!out.value && typeof out.value === 'object' && out.value.ok === true;
  } catch {}
  return { id, instance, at, ok, ...(ok ? {} : { reason: out.fail || 'returned' }), ms: at - t0 };
}

export type Probes = ReturnType<typeof createProbes>;
