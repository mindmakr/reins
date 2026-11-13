// @mindmakr/reins/flight: the production-safe, report-only part of reins. Node only.
// It records, checks and reports; it has no actions, no pairing, no bridge client, no token handling and no
// DOM or state reading, and it opens no port (design section 7). Importing it does nothing: `flight.start()`
// is the opt-in. It records through the strict recorder shared with @mindmakr/reins/node (design C13, C16).
// Imports: Node built-ins and reins' shared modules only. Never import ./node.js, ./index.js or ./bridge here.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { check, type CheckResult, endsOf, notCheckedResult } from './flight/checker.js';
import { type Change, evaluate, type FindingsMemory, type FlightFinding, fromRecords, memoryFrom, memoryRecord, toRecord } from './flight/findings.js';
import { createNotifier, type Delivery, type FlightSink, type Notification, type Notifier, type NotifyOptions, type NotifyState, type SummaryFigures } from './flight/sinks.js';
import { DEFAULT_WINDOW_MS, MANIFEST_FILE, type ManifestResult, readManifest, validateManifest } from './flight/manifest.js';
import { createProbes, PROBE_TIMEOUT_MS } from './flight/probes.js';
import { createStepWriter, type StepWriter } from './flight/steps.js';
import { type FindingRecord, type FlightStore, type InstanceMinute, isStore, memoryStore, type Retention, RETENTION_DEFAULTS } from './flight/store.js';
import { basicsOf } from './flight/limits.js';
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

/** The last stamp given in this process: module-wide, so two flights in one process never give the same stamp. */
let lastStamp = 0;
/** `t`, or one more than the last stamp given in this process: what the store and the outage entries order by. */
function stamp(t: number): number {
  lastStamp = Math.max(t, lastStamp + 1);
  return lastStamp;
}

/** A finding that changed while the store could not be written, as this server last saw it, and when. */
interface OutageEntry {
  at: number;
  finding: FlightFinding;
}

/** The outage findings a server that does not hold the lock tells and keeps: only the store's own, which it saw itself. */
const STORE_KEYS = new Set(['blind:store-unreachable', 'blind:lock-unavailable']);

const CHANGE_TYPES = new Set(['opened', 'changed', 'resolved']);
/** Whether a delivery tells a change that `told` already shows: the same finding in the same state and level. */
const toldIn = (told: FlightFinding[], d: Delivery) => {
  const f = d.n.finding;
  return !!f && told.some((t) => t.key === f.key && t.state === f.state && t.level === f.level);
};

/** The stored findings, with the ones that changed during an outage laid over them where they are newer. */
function mergePrior(stored: FindingRecord[], outage: Map<string, OutageEntry>): FlightFinding[] {
  const out = new Map(fromRecords(stored).map((f) => [f.key, f]));
  const at = new Map(stored.map((r) => [r.key, r.updatedAt]));
  for (const [key, e] of outage) if (!at.has(key) || (at.get(key) as number) < e.at) out.set(key, e.finding);
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
    /**
     * Findings that changed while the store could not be written, by key: laid over the stored ones, and written
     * by the next pass that can write, or, when another server holds the lock by then, by this one before it
     * stands down, so whichever server next holds the lock resolves them, once.
     */
    outage: Map<string, OutageEntry>;
    /**
     * Whether this server held the lock at its last try (false until a try succeeds). A holder tells sinks of a
     * store outage at once; any other server only once the outage has lasted the lock's lease (`conclude`).
     */
    holder: boolean;
    /** When this server first found the store down in the current outage; null while it reaches the store. */
    downSince: number | null;
  } | null = null;
  let checkEvery = 60_000;
  let checkTimeout = CHECK_TIMEOUT_MS;
  /** The lock's lease: a lock its checker stopped renewing is taken over after three periods (at least three minutes). */
  const lease = () => 3 * Math.max(checkEvery, 60_000);

  /**
   * Whether this server still holds the lock, renewing it. Asked before a pass that is no longer live (it ran
   * past its time limit, maybe past the lease) writes or tells: another server may hold the lock by then, and
   * what it wrote and told is its own. False after stop(); a lock renewed while stop() ran is given back.
   */
  async function stillHolds(r: NonNullable<typeof run>): Promise<boolean> {
    if (run !== r) return false;
    const ok = await r.store.lock(r.owner, lease()).catch(() => false);
    if (run === r) return ok;
    if (ok) void r.store.unlock(r.owner).catch(() => {});
    return false;
  }

  /**
   * The findings step of a pass: findings from the check and the minutes, merged with the ones kept, written to
   * the store with the findings layer's memory, and only then sent to the sinks, so a change is told once even
   * with several instances on one store (only the lock holder runs a pass, and the next holder reads what was
   * written). The write is the commit point: once the store holds a change as told, it is told, even when the
   * pass ran past its time limit meanwhile (then only while this server still holds the lock, and only what the
   * time-out's own step did not already tell), but never after stop(). When the store cannot be written, this
   * server's own copy stands in, and the changes are kept in `outage` until a pass can write them. Never throws.
   */
  async function conclude(r: NonNullable<typeof run>, result: CheckResult, minutes: InstanceMinute[] | null, useStore: boolean, isLive: () => boolean): Promise<void> {
    try {
      const now = result.at;
      // The time the store records this pass's write under, and an outage entry's: strictly increasing in this
      // process, so a record and an entry of the same millisecond are never a tie.
      const at = stamp(now);
      const down = !useStore || result.blind.some((f) => f.kind === 'store-unreachable' || f.kind === 'lock-unavailable');
      let prior = r.findings;
      let memory = r.memory;
      let records: FindingRecord[] | null = null;
      if (!down) {
        try {
          records = await r.store.findings();
          prior = mergePrior(records, r.outage);
          memory = memoryFrom(records);
        } catch {}
      }
      const ev = evaluate({ check: result, minutes, manifest: r.manifest, prior, memory, now, extra: r.notifier.health() });
      const facts = notCheckedFacts();
      const plan = r.notifier.plan(ev.changes, ev.memory.notify as NotifyState | undefined, now, r.service, () => ({ findings: ev.findings, checked: summaryOf(ev.findings, result, facts) }));
      const mem: FindingsMemory = { ...ev.memory, notify: plan.state as Record<string, unknown> };
      const changed = new Set(ev.changes.map((c) => c.finding.key));
      if (records) {
        // A pass past its time limit writes only while this server still holds the lock: a newer holder's
        // records are not overwritten with older ones.
        if (!isLive() && !(await stillHolds(r))) return;
        // The open findings, the changed ones, and the ones that changed during an outage (one that resolved then,
        // and was told so, must not stay open in the store to be resolved and told again).
        const outageKeys = [...r.outage.keys()];
        const write = new Set([...changed, ...outageKeys]);
        await r.store.putFindings([...ev.findings.filter((f) => f.state === 'open' || write.has(f.key)).map((f) => toRecord(f, at)), memoryRecord(mem, at)]);
        // Written; an entry a time-out added while this write was on its way is newer, and stays.
        for (const k of outageKeys) if ((r.outage.get(k)?.at ?? Infinity) <= at) r.outage.delete(k);
        if (isLive()) {
          r.findings = ev.findings;
          r.memory = mem;
          r.notifier.dispatch(plan.deliveries);
          return;
        }
        // The pass ran past its time limit while writing, or flight stopped. After stop() nothing is sent. Else
        // the time-out's own findings step has already told, from the findings before this pass and from the same
        // memory, its changes and any digest or summary due: this write tells only the changes that step did not,
        // and only while this server still holds the lock (another holder tells its own).
        if (!(await stillHolds(r))) return;
        r.notifier.dispatch(plan.deliveries.filter((d) => CHANGE_TYPES.has(d.n.type) && !toldIn(r.findings, d)));
        return;
      }
      if (!isLive()) return;
      r.findings = ev.findings;
      if (down && r.downSince === null) r.downSince = now;
      if (r.holder) {
        // Kept until a pass can write them: what changed now, and the latest of what changed before.
        for (const f of ev.findings) if (changed.has(f.key) || r.outage.has(f.key)) r.outage.set(f.key, { at, finding: f });
        r.memory = mem;
        r.notifier.dispatch(plan.deliveries);
        return;
      }
      // A server that did not hold the lock at its last try tells sinks of the store outage only once it has
      // lasted the lock's lease: by then a holder, if there is one, has told it (a holder tells at once), and a
      // server whose store has been down since boot, with no holder at all, still tells it. During an outage the
      // servers cannot coordinate, so two of them may each tell the same opening once: a duplicate accepted, as
      // the price of an outage every sink hears of. A server that told an opening also tells that finding's
      // changes and end while it still cannot reach the store. It keeps only what it told, for the next lock
      // holder (itself, or another after `handOver`) to resolve and tell: an outage no sink heard of ends unheard.
      // These few notifications are planned outside the hourly count, which lives in the store it cannot reach.
      const tell: Change[] = ev.changes.filter((c) => STORE_KEYS.has(c.finding.key) && r.outage.has(c.finding.key));
      if (now - (r.downSince ?? now) >= lease())
        for (const f of ev.findings) if (STORE_KEYS.has(f.key) && f.state === 'open' && !r.outage.has(f.key)) tell.push({ event: 'opened', finding: f });
      const told = new Set([...r.outage.keys(), ...tell.map((c) => c.finding.key)]);
      for (const f of ev.findings) if (STORE_KEYS.has(f.key) && told.has(f.key)) r.outage.set(f.key, { at, finding: f });
      if (tell.length) r.notifier.dispatch(r.notifier.plan(tell, undefined, now, r.service).deliveries);
    } catch {
      // A store that refuses the write: nothing is sent, and the next pass finds the same changes again.
    }
  }

  /**
   * A server that no longer holds the lock writes the findings it kept from an outage (only what a sink was
   * told), where the store has nothing newer, so the server that holds the lock now resolves them and tells it,
   * once. Throws when the store does; the entries are then kept for the next pass.
   */
  async function handOver(r: NonNullable<typeof run>): Promise<void> {
    if (!r.outage.size) return;
    const at = new Map((await r.store.findings()).map((x) => [x.key, x.updatedAt]));
    const entries = [...r.outage.values()];
    const list = entries.filter((e) => !((at.get(e.finding.key) ?? -Infinity) >= e.at)).map((e) => toRecord(e.finding, e.at));
    if (list.length) await r.store.putFindings(list);
    for (const e of entries) if (r.outage.get(e.finding.key) === e) r.outage.delete(e.finding.key);
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
    // This pass is live until it ends or runs past its time limit; work that finishes later is ignored.
    const token = {};
    r.token = token;
    const live = () => run === r && r.token === token;
    // Past its time limit a pass is over: its own findings step is ignored, and the time-out result says why.
    let over = false;
    const current = () => live() && !over;
    const work = (async (): Promise<CheckResult | null> => {
      let held: boolean;
      try {
        held = await r.store.lock(r.owner, lease());
      } catch (e) {
        // Without the lock this checker neither checks nor prunes (another may hold it), and says why.
        const res = notCheckedResult(r.manifest, Date.now(), { kind: 'lock-unavailable', error: errorCode(e) }, 'lock-unavailable');
        await conclude(r, res, null, false, current);
        return res;
      }
      r.holder = held;
      r.downSince = null;
      if (!held) {
        // The lock answered, so this is not a lock failure: a hand-over the store refuses is tried again next pass.
        await handOver(r).catch(() => {});
        return null;
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
        // The slow-route limit and its error level in force: those that are not bucket bounds are counted exactly.
        const bs = basicsOf(manifest?.ok ? manifest.manifest.basics : undefined);
        r = createStrictRecorder(opts, [bs.slowRouteMs, bs.errorFactor * bs.slowRouteMs]);
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
          outage: new Map(),
          holder: false,
          downSince: null,
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
    /**
     * Stops recording, writing, checking and telling: no notification starts after this, also not for what a pass
     * still on its way writes to the store. Queued steps are written in the background; `flush()` first to wait.
     */
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
