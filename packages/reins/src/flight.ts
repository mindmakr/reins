// @mindmakr/reins/flight: the production-safe, report-only part of reins. Node only.
// It records, checks and reports; it has no actions, no pairing, no bridge client, no token handling and no
// DOM or state reading, and it opens no port (design section 7). Importing it does nothing: `flight.start()`
// is the opt-in. It records through the strict recorder shared with @mindmakr/reins/node (design C13, C16).
// Imports: Node built-ins and reins' shared modules only. Never import ./node.js, ./index.js or ./bridge here.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { check, type CheckResult, endsOf, notCheckedResult } from './flight/checker.js';
import { evaluate, type FindingsMemory, type FlightFinding, fromRecords, memoryFrom, memoryRecord, toRecord } from './flight/findings.js';
import { createNotifier, type FlightSink, type Notification, type Notifier, type NotifyOptions, type NotifyState, type SummaryFigures } from './flight/sinks.js';
import { DEFAULT_WINDOW_MS, MANIFEST_FILE, type ManifestResult, readManifest, validateManifest } from './flight/manifest.js';
import { createProbes, PROBE_TIMEOUT_MS } from './flight/probes.js';
import { createStepWriter, type StepWriter } from './flight/steps.js';
import { type FindingRecord, type FlightStore, type InstanceMinute, isStore, memoryStore, type Retention, RETENTION_DEFAULTS } from './flight/store.js';
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
  errorCode,
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
  /** How long a checker pass (lock, reads, prune) may take; past it the pass ends with a `store-unreachable` (timeout) blind fact and a late result is ignored. Default 30 s. */
  checkTimeoutMs?: number;
  /** How long a probe may run before its run is a timeout. Default 10 s. */
  probeTimeoutMs?: number;
  /**
   * Where findings go: webhook, file and function sinks (`webhookSink`, `fileSink`, `functionSink`), or plain
   * functions. A sink is told when a finding opens, changes level or resolves. Secrets and addresses come from the
   * environment, never from the manifest.
   */
  sinks?: Array<FlightSink | ((n: Notification) => unknown)>;
  /** The hourly limit per sink (default 5), the daily summary (default on, after 08:00 UTC) and when a failing sink is reported. */
  notify?: NotifyOptions;
  /** The service name in notifications. Default the manifest's `service`, else `server`. */
  service?: string;
  /** What the store keeps. Default 7 days (or the widest promise window and a day, if longer), and the store's own step cap: 100,000 steps in memory, 1,000,000 in a file or Postgres store. Whole runs go, never single steps. */
  retention?: Retention;
}

export type { DevInstruments, MinuteSummary, StrictCall, StrictRequest, StrictSpan, StrictStats } from './recorder.js';
export type { FindingRecord, FlightStore, InstanceMinute, ProbeResult, Retention, StepRecord } from './flight/store.js';
export type { BlindFact, CheckResult, LateRun, ProbeCheck, PromiseCheck } from './flight/checker.js';
export type { FlightManifest, ManifestProblem, ManifestResult } from './flight/manifest.js';
export type { Change, FindingKind, FlightFinding, Observation } from './flight/findings.js';
export type { FileSinkOptions, FlightSink, Notification, NotifyOptions, SinkFinding, SummaryFigures, WebhookOptions } from './flight/sinks.js';
export { evaluate, KIND_ORDER, sortFindings } from './flight/findings.js';
export { fileSink, functionSink, signWebhook, webhookSink } from './flight/sinks.js';
export { BASICS, DEFAULT_BASICS, LIMITS, SINK_LIMITS } from './flight/limits.js';
export { CHECKS, SOURCES } from './flight/sources.js';
export type { QueryFn } from './flight/pg-store.js';
export { MAX_LOCK_MS, MEMORY_MAX_STEPS, memoryStore, RETENTION_DEFAULTS } from './flight/store.js';
export { fileStore } from './flight/file-store.js';
export { PG_TABLES, pgStore } from './flight/pg-store.js';
export { check, endsOf } from './flight/checker.js';

const INSTANCE = /^[A-Za-z0-9._-]{1,64}$/;
/** How often the lock holder prunes the store. */
const PRUNE_EVERY_MS = 3_600_000;
/** How long a checker pass may take before it ends as store-unreachable (timeout). */
const CHECK_TIMEOUT_MS = 30_000;

/** Reads the manifest option: an object is validated, a string is a file; none means the default file, if any. */
function loadManifest(m: unknown): ManifestResult | null {
  if (m === undefined || m === null) {
    const file = join(process.cwd(), MANIFEST_FILE);
    return existsSync(file) ? readManifest(file) : null;
  }
  return typeof m === 'string' ? readManifest(m) : validateManifest(m);
}

const SERVICE = /^[\x20-\x7e]{1,64}$/;

/** Findings kept while the store could not be written, laid over the stored ones until a pass writes again. */
function mergePrior(stored: FindingRecord[], outage: { at: number; findings: FlightFinding[] } | null): FlightFinding[] {
  const out = new Map(fromRecords(stored).map((f) => [f.key, f]));
  if (outage) {
    const at = new Map(stored.map((r) => [r.key, r.updatedAt]));
    for (const f of outage.findings) if (!at.has(f.key) || (at.get(f.key) as number) < outage.at) out.set(f.key, f);
  }
  return [...out.values()];
}

/** What a daily summary says was checked. */
function summaryOf(findings: FlightFinding[], c: CheckResult, notChecked: string[]): SummaryFigures {
  const tally = (l: Array<{ state: string }>) => ({ held: l.filter((x) => x.state === 'held').length, broken: l.filter((x) => x.state === 'broken').length, notChecked: l.filter((x) => x.state === 'not-checked').length });
  const open: Record<string, number> = { blind: 0, basic: 0, broken: 0, drifting: 0, unusual: 0 };
  for (const f of findings) if (f.state === 'open') open[f.kind] = (open[f.kind] || 0) + 1;
  const extra = c.manifest === 'none' ? ['There is no manifest, so no promise is checked.'] : c.manifest === 'invalid' ? ['The manifest is invalid, so no promise is checked.'] : [];
  return { promises: tally(c.promises), probes: tally(c.probes), open, notChecked: [...extra, ...notChecked] };
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
    /** The live pass; work of a pass that ran past its time limit is ignored. */
    token: object | null;
    /** The store work of a pass that ran past its time limit, while it has not settled: no new store work starts. */
    hung: Promise<unknown> | null;
    notifier: Notifier;
    service: string;
    /** The findings as this server last knew them, and the findings layer's memory. */
    findings: FlightFinding[];
    memory: FindingsMemory;
    /** Findings of passes that could not write the store, laid over the stored ones until a pass writes again. */
    outage: { at: number; findings: FlightFinding[] } | null;
    /** Whether this server held the lock at its last try, or has not tried yet: only then does it report a store outage itself. */
    holder: boolean;
  } | null = null;
  let checkEvery = 60_000;
  let checkTimeout = CHECK_TIMEOUT_MS;

  /**
   * The findings step of a pass: findings from the check and the minutes, merged with the ones kept, written to
   * the store with the findings layer's memory, and only then sent to the sinks, so a change is told once even
   * with several instances on one store (only the lock holder runs a pass, and the next holder reads what was
   * written). When the store cannot be used, this server's own copy stands in, and only the last lock holder
   * (or a server that never tried) reports the outage. Never throws.
   */
  async function conclude(r: NonNullable<typeof run>, result: CheckResult, minutes: InstanceMinute[] | null, useStore: boolean, isLive: () => boolean): Promise<void> {
    try {
      const now = result.at;
      const down = !useStore || result.blind.some((f) => f.kind === 'store-unreachable' || f.kind === 'lock-unavailable');
      let prior = r.outage ? mergePrior([], r.outage) : r.findings;
      let memory = r.memory;
      let persist = false;
      if (!down) {
        try {
          const records = await r.store.findings();
          prior = mergePrior(records, r.outage);
          memory = memoryFrom(records);
          persist = true;
        } catch {}
      }
      if (!persist && !r.holder) return;
      const ev = evaluate({ check: result, minutes, manifest: r.manifest, prior, memory, now, extra: r.notifier.health() });
      const facts = notCheckedFacts();
      const plan = r.notifier.plan(ev.changes, ev.memory.notify as NotifyState | undefined, now, r.service, () => ({ findings: ev.findings, checked: summaryOf(ev.findings, result, facts) }));
      const mem: FindingsMemory = { ...ev.memory, notify: plan.state as Record<string, unknown> };
      if (persist) {
        const changed = new Set(ev.changes.map((c) => c.finding.key));
        await r.store.putFindings([...ev.findings.filter((f) => f.state === 'open' || changed.has(f.key)).map((f) => toRecord(f, now)), memoryRecord(mem, now)]);
      }
      if (!isLive()) return;
      r.findings = ev.findings;
      r.memory = mem;
      r.outage = persist ? null : { at: now, findings: ev.findings };
      r.notifier.dispatch(plan.deliveries);
    } catch {
      // A store that refuses the write: nothing is sent, and the next pass finds the same changes again.
    }
  }

  /** One checker pass, when this server holds the store lock; null when another checker holds it. */
  async function pass(): Promise<CheckResult | null> {
    const r = run;
    if (!r) return null;
    if (r.passing) return r.passing;
    if (r.hung) {
      // The last pass's store calls never came back: calling the store again would only pile up more (with pg,
      // waiters in the app's own pool). This period says so without calling it.
      r.lastCheck = notCheckedResult(r.manifest, Date.now(), { kind: 'store-unreachable', error: 'timeout' }, 'store-unreachable');
      await conclude(r, r.lastCheck, null, false, () => run === r);
      return r.lastCheck;
    }
    // A lock its checker stopped renewing is taken over after three periods (at least three minutes).
    const ttl = 3 * Math.max(checkEvery, 60_000);
    // This pass is live until it ends or runs past its time limit; work that finishes later is ignored.
    const token = {};
    r.token = token;
    const live = () => run === r && r.token === token;
    // Past its time limit a pass is over: its own findings step is ignored, and the time-out result says why.
    let over = false;
    const current = () => live() && !over;
    const work = (async (): Promise<CheckResult | null> => {
      try {
        r.holder = await r.store.lock(r.owner, ttl);
        if (!r.holder) return null;
      } catch (e) {
        // Without the lock this checker neither checks nor prunes (another may hold it), and says why.
        const res = notCheckedResult(r.manifest, Date.now(), { kind: 'lock-unavailable', error: errorCode(e) }, 'lock-unavailable');
        await conclude(r, res, null, false, current);
        return res;
      }
      let minutes: InstanceMinute[] | null = null;
      const result = await check(r.store, r.manifest, { minutes: (m) => (minutes = m) });
      await conclude(r, result, minutes, true, current);
      if (live() && Date.now() - r.lastPrune >= PRUNE_EVERY_MS) {
        r.lastPrune = Date.now();
        await r.store.prune(r.retention, Date.now(), endsOf(r.manifest)).catch(() => {});
      }
      return result;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<CheckResult>((resolve) => {
      timer = setTimeout(() => {
        r.hung = work;
        const settled = () => {
          if (r.hung === work) r.hung = null;
        };
        work.then(settled, settled);
        const res = notCheckedResult(r.manifest, Date.now(), { kind: 'store-unreachable', error: 'timeout' }, 'store-unreachable');
        // The timed-out pass is over: its own findings step is ignored, and this one says why. With no store
        // work, this findings step runs to its end before `conclude` returns.
        over = true;
        void conclude(r, res, null, false, live);
        resolve(res);
      }, checkTimeout);
      (timer as any).unref?.();
    });
    const p: Promise<CheckResult | null> = Promise.race([work, limit])
      .then((res) => {
        if (res && live()) r.lastCheck = res;
        return res;
      })
      .catch(() => null)
      .finally(() => {
        clearTimeout(timer);
        if (r.token === token) r.token = null;
        if (r.passing === p) r.passing = null;
      });
    r.passing = p;
    return p;
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
        // The memory store is told the end steps now, so its cap on add counts the open runs it removes before the first prune.
        const store = opts.store || memoryStore({ ...(opts.retention && typeof opts.retention === 'object' ? opts.retention : {}), ends: endsOf(manifest) });
        const instance = opts.instance || randomBytes(6).toString('hex');
        r = createStrictRecorder(opts);
        r.start();
        const rr = r;
        const writer = createStepWriter({
          store,
          instance,
          bufferSize: opts.stepBuffer,
          flushMs: opts.flushMs,
          basics: () => rr.summaries(),
          probes: () => probes.ids(),
          devModule: () => {
            const d = devInstruments(env);
            return d.production && d.devModuleLoaded;
          },
        });
        writer.start();
        const m = manifest?.ok ? manifest.manifest : undefined;
        const widest = Math.max(DEFAULT_WINDOW_MS, ...(m?.processes || []).flatMap((p) => p.promises.map((x) => x.windowMs)));
        const keep: Retention = { maxAgeMs: Math.max(RETENTION_DEFAULTS.maxAgeMs, widest + 86_400_000), ...(opts.retention && typeof opts.retention === 'object' ? opts.retention : {}) };
        const service = typeof opts.service === 'string' && SERVICE.test(opts.service) ? opts.service : m?.service || 'server';
        const notifier = createNotifier(opts.sinks, opts.notify && typeof opts.notify === 'object' ? opts.notify : {});
        run = {
          store,
          writer,
          manifest,
          owner: `${instance}-${randomBytes(4).toString('hex')}`,
          retention: keep,
          timer: null,
          lastCheck: null,
          lastPrune: 0,
          passing: null,
          token: null,
          hung: null,
          notifier,
          service,
          findings: [],
          memory: {},
          outage: null,
          holder: true,
        };
        probes.start({ store, instance, declared: m?.probes || [], timeoutMs: nonNeg(opts.probeTimeoutMs, PROBE_TIMEOUT_MS) || PROBE_TIMEOUT_MS, onError: () => writer.storeError() });
        checkEvery = nonNeg(opts.checkEveryMs, 60_000);
        checkTimeout = Math.min(nonNeg(opts.checkTimeoutMs, CHECK_TIMEOUT_MS) || CHECK_TIMEOUT_MS, 3 * Math.max(checkEvery, 60_000));
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
    /** The findings as of the last pass this server ran, open and resolved, in report order (design section 5). */
    findings: (): FlightFinding[] => (run ? run.findings.map((f) => ({ ...f })) : []),
    /** Resolves when every notification started so far has been delivered or has failed. */
    sinksIdle: async (): Promise<void> => {
      await run?.notifier.idle();
    },
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
