// @mindmakr/reins/flight: the production-safe, report-only part of reins. Node only.
// It records, checks and reports; it has no actions, no pairing, no bridge client, no token handling and no
// DOM or state reading, and it opens no port (design section 7). Importing it does nothing: `flight.start()`
// is the opt-in. It records through the strict recorder shared with @mindmakr/reins/node (design C13, C16).
// Imports: Node built-ins and reins' shared modules only. Never import ./node.js, ./index.js or ./bridge here.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { check, type CheckResult, endsOf } from './flight/checker.js';
import { DEFAULT_WINDOW_MS, MANIFEST_FILE, type ManifestResult, readManifest, validateManifest } from './flight/manifest.js';
import { createProbes, PROBE_TIMEOUT_MS } from './flight/probes.js';
import { createStepWriter, type StepWriter } from './flight/steps.js';
import { type FlightStore, isStore, memoryStore, type Retention, RETENTION_DEFAULTS } from './flight/store.js';
import {
  createStrictRecorder,
  type DevInstruments,
  devInstruments,
  fastify,
  middleware,
  notCheckedFacts,
  span,
  type StrictOptions,
  type StrictRecorder,
  wrapHandler,
} from './recorder.js';

export const VERSION = '0.1.0';

export interface FlightOptions extends StrictOptions {
  /**
   * The manifest: an object, or the path of a JSON file. Default `reins.flight.json` in the current directory
   * when that file exists; without one, flight records the basics and checks no promises. An invalid manifest
   * never stops the basics: promise checks stop and the check result says so (design C8).
   */
  manifest?: unknown;
  /** Throw from `start()` when the manifest is invalid, instead of carrying on with the basics. */
  strict?: boolean;
  /** Where steps, minutes, probe results and findings are kept. Default a memory store. */
  store?: FlightStore;
  /** This server instance's name in the store. Letters, digits, `.`, `_` and `-`. Default a random id. */
  instance?: string;
  /** Steps queued at most before they are written; more are dropped and counted. Default 10,000. */
  stepBuffer?: number;
  /** How often queued steps are written. Default 1 s. */
  flushMs?: number;
  /** How often the checker runs a pass, if it holds the store lock. Default 60 s; 0 turns the checker off here. */
  checkEveryMs?: number;
  /** How long a probe may run before its run is a timeout. Default 10 s. */
  probeTimeoutMs?: number;
  /** What the store keeps. Default 7 days (or the widest promise window and a day, if longer), and the store's own step cap: 100,000 steps in memory, 1,000,000 in a file or Postgres store. Whole runs go, never single steps. */
  retention?: Retention;
}

export type { DevInstruments, MinuteSummary, StrictCall, StrictRequest, StrictSpan, StrictStats } from './recorder.js';
export type { FindingRecord, FlightStore, InstanceMinute, ProbeResult, Retention, StepRecord } from './flight/store.js';
export type { BlindFact, CheckResult, LateRun, ProbeCheck, PromiseCheck } from './flight/checker.js';
export type { FlightManifest, ManifestProblem, ManifestResult } from './flight/manifest.js';
export type { QueryFn } from './flight/pg-store.js';
export { memoryStore, RETENTION_DEFAULTS } from './flight/store.js';
export { fileStore } from './flight/file-store.js';
export { PG_TABLES, pgStore } from './flight/pg-store.js';
export { check, endsOf } from './flight/checker.js';

const INSTANCE = /^[A-Za-z0-9._-]{1,64}$/;
/** How often the lock holder prunes the store. */
const PRUNE_EVERY_MS = 3_600_000;

/** Reads the manifest option: an object is validated, a string is a file; none means the default file, if any. */
function loadManifest(m: unknown): ManifestResult | null {
  if (m === undefined || m === null) {
    const file = join(process.cwd(), MANIFEST_FILE);
    return existsSync(file) ? readManifest(file) : null;
  }
  return typeof m === 'string' ? readManifest(m) : validateManifest(m);
}

const nonNeg =(v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);

/** Creates an instance. Apps use the `flight` singleton; this is for tests. */
export function createFlight(env: Record<string, string | undefined> = process.env) {
  let rec: StrictRecorder | null = null;
  const probes = createProbes();
  let run: {
    store: FlightStore;
    writer: StepWriter;
    manifest: ManifestResult | null;
    owner: string;
    retention: Retention;
    timer: ReturnType<typeof setInterval> | null;
    lastCheck: CheckResult | null;
    lastPrune: number;
    passing: Promise<CheckResult | null> | null;
  } | null = null;
  let checkEvery = 60_000;

  /** One checker pass, when this server holds the store lock; null when another checker holds it. */
  async function pass(): Promise<CheckResult | null> {
    const r = run;
    if (!r) return null;
    if (r.passing) return r.passing;
    // A lock its checker stopped renewing is taken over after three periods (at least three minutes).
    const ttl = 3 * Math.max(checkEvery, 60_000);
    r.passing = (async () => {
      try {
        if (!(await r.store.lock(r.owner, ttl))) return null;
      } catch {
        // The store cannot be reached: the pass still runs, and says so.
      }
      const result = await check(r.store, r.manifest);
      r.lastCheck = result;
      if (Date.now() - r.lastPrune >= PRUNE_EVERY_MS) {
        r.lastPrune = Date.now();
        await r.store.prune(r.retention, Date.now(), endsOf(r.manifest)).catch(() => {});
      }
      return result;
    })()
      .catch(() => null)
      .finally(() => {
        r.passing = null;
      });
    return r.passing;
  }

  return {
    /**
     * Starts the strict recorder, the step writer, the probes and the checker. Never throws, except with
     * `strict: true` and an invalid manifest. On a bad option it starts nothing and returns false. Calling it
     * again while started does nothing and returns true.
     */
    start(o: FlightOptions = {}): boolean {
      if (rec) return true;
      const opts: FlightOptions = o && typeof o === 'object' ? o : {};
      let manifest: ManifestResult | null = null;
      try {
        manifest = loadManifest(opts.manifest);
      } catch {
        manifest = { ok: false, problems: [{ path: '(root)', message: 'could not be read' }] };
      }
      if (opts.strict === true && manifest && !manifest.ok) {
        throw new Error(`reins flight: the manifest is invalid: ${manifest.problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
      }
      let r: StrictRecorder | null = null;
      try {
        if (opts.store !== undefined && !isStore(opts.store)) return false;
        if (opts.instance !== undefined && !(typeof opts.instance === 'string' && INSTANCE.test(opts.instance))) return false;
        const store = opts.store || memoryStore(opts.retention);
        const instance = opts.instance || randomBytes(6).toString('hex');
        r = createStrictRecorder(opts);
        r.start();
        const rr = r;
        const writer = createStepWriter({ store, instance, bufferSize: opts.stepBuffer, flushMs: opts.flushMs, basics: () => rr.summaries(), probes: () => probes.ids() });
        writer.start();
        const m = manifest?.ok ? manifest.manifest : undefined;
        const widest = Math.max(DEFAULT_WINDOW_MS, ...(m?.processes || []).flatMap((p) => p.promises.map((x) => x.windowMs)));
        const keep: Retention = { maxAgeMs: Math.max(RETENTION_DEFAULTS.maxAgeMs, widest + 86_400_000), ...(opts.retention && typeof opts.retention === 'object' ? opts.retention : {}) };
        run = { store, writer, manifest, owner: `${instance}-${randomBytes(4).toString('hex')}`, retention: keep, timer: null, lastCheck: null, lastPrune: 0, passing: null };
        probes.start({ store, instance, declared: m?.probes || [], timeoutMs: nonNeg(opts.probeTimeoutMs, PROBE_TIMEOUT_MS) || PROBE_TIMEOUT_MS });
        checkEvery = nonNeg(opts.checkEveryMs, 60_000);
        if (checkEvery > 0) {
          run.timer = setInterval(() => void pass(), checkEvery);
          (run.timer as any).unref?.();
        }
        rec = r;
        return true;
      } catch {
        try {
          r?.stop();
        } catch {}
        run?.writer.stop();
        probes.stop();
        run = null;
        return false;
      }
    },
    /** Stops recording, writing and checking. Queued steps are written in the background; `flush()` first to wait. */
    stop(): void {
      try {
        rec?.stop();
      } catch {}
      rec = null;
      const r = run;
      run = null;
      if (!r) return;
      try {
        if (r.timer) clearInterval(r.timer);
        r.writer.stop();
        probes.stop();
        void r.writer.flush().then(() => r.store.unlock(r.owner)).catch(() => {});
      } catch {}
    },
    isStarted: () => !!rec,
    /**
     * Records that run `key` of `process` reached `step` (design C7). Returns at once with whether it was queued;
     * never throws and never waits for the store. Before `start()` it does nothing.
     */
    step: (process: string, key: string | number, step: string): boolean => {
      try {
        return run ? run.writer.step(process, key, step) : false;
      } catch {
        return false;
      }
    },
    /**
     * Registers a probe: `fn` returns `{ ok: true }` when the app's data holds, under the id the manifest
     * declares. Returns whether it was registered; never throws. May be called before `start()`.
     */
    probe: (id: string, fn: () => unknown): boolean => probes.register(id, fn),
    /** Writes queued steps and this instance's minute now. Never rejects. */
    flush: async (): Promise<void> => {
      await run?.writer.flush();
    },
    /** Runs a checker pass now, if this server holds the store lock; null when it does not or flight is off. */
    checkNow: (): Promise<CheckResult | null> => pass(),
    /** The result of the last pass this server ran, or null. */
    lastCheck: (): CheckResult | null => run?.lastCheck || null,
    /** Internal, for the findings layer and the watcher: the store in use, or null. */
    store: (): FlightStore | null => run?.store || null,
    /** Internal: the manifest as read at start (null when none), for the findings layer. */
    manifest: (): ManifestResult | null => run?.manifest || null,
    /** Step counts of this instance: queued, written, dropped, invalid, store errors. */
    stepStats: () => run?.writer.stats() || null,
    /** Express/Connect middleware. The same hook as `reinsNode.middleware()`; install one of them, once. */
    middleware: () => middleware(),
    /** Wraps a plain `(req, res)` handler. */
    wrapHandler: <H extends (req: any, res: any, ...rest: any[]) => any>(handler: H): H => wrapHandler(handler),
    /** Fastify hooks. */
    fastify,
    /** Times `fn` as a span of the current request. Returns what `fn` returns; flight never changes it. */
    span,
    /** Whether development reins is loaded or recording in this process, and whether it is production (design C12). */
    devInstruments: (): DevInstruments => devInstruments(env),
    /** Facts this Node version cannot check, for reports to carry as "not checked". */
    notChecked: (): string[] => notCheckedFacts(),
    /** Internal, for the checker, store and report: the started recorder, or null. */
    recorder: (): StrictRecorder | null => rec,
  };
}

export type Flight = ReturnType<typeof createFlight>;

export const flight = createFlight();
export default flight;
