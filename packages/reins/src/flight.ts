// @mindmakr/reins/flight: the production-safe, report-only part of reins. Node only.
// It records, checks and reports; it has no actions, no pairing, no bridge client, no token handling and no
// DOM or state reading, and it opens no port (design section 7). Importing it does nothing: `flight.start()`
// is the opt-in. It records through the strict recorder shared with @mindmakr/reins/node (design C13, C16).
// Imports: Node built-ins and reins' shared modules only. Never import ./node.js, ./index.js or ./bridge here.
import { randomBytes } from 'node:crypto';
import { check, type CheckResult, endsOf, notCheckedResult } from './flight/checker.js';
import { type Change, evaluate, type FindingsMemory, type FlightFinding, fromRecords, memoryFrom, memoryRecord, sortFindings, STORE_KEYS, toRecord } from './flight/findings.js';
import { createNotifier, type FlightSink, type Notification, type Notifier, type NotifyOptions, type NotifyState, type SummaryFigures } from './flight/sinks.js';
import { DEFAULT_WINDOW_MS, loadManifest, type ManifestResult, serviceOf } from './flight/manifest.js';
import { createProbes, PROBE_TIMEOUT_MS } from './flight/probes.js';
import { createStepWriter, type StepWriter } from './flight/steps.js';
import { type FindingRecord, type FlightStore, type InstanceMinute, isStore, memoryStore, type Retention, RETENTION_DEFAULTS } from './flight/store.js';
import { basicsOf } from './flight/limits.js';
import { collectReport, type FlightReport } from './flight/report.js';
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
export type { BasicCheck, BasicsReport, DevReport, FigureRow, FlightReport, ProbeReport, ProcessReport, PromiseReport, StepTiming } from './flight/report.js';
export { REPORT_FORMAT, REPORT_LEAD, REPORT_VERSION } from './flight/report.js';
export type { FlightCompare } from './flight/render.js';
export { compareFlightReports, findingMarkdown, parseFlightReport, renderFlightHtml, renderFlightMarkdown } from './flight/render.js';

const INSTANCE = /^[A-Za-z0-9._-]{1,64}$/;
/** How often the lock holder prunes the store. */
const PRUNE_EVERY_MS = 3_600_000;
/** How long a checker pass may take before it ends as store-unreachable (timeout). */
const CHECK_TIMEOUT_MS = 30_000;

/** The last stamp given in this process: module-wide, so two flights in one process never give the same stamp. */
let lastStamp = 0;
/** `t`, or one more than the last stamp given in this process: what the store's records and own writes order by. */
function stamp(t: number): number {
  lastStamp = Math.max(t, lastStamp + 1);
  return lastStamp;
}

/** A finding as this server wrote it to the store, and the time it was written under. */
interface Written {
  at: number;
  finding: FlightFinding;
}

/** The store-unreachable or lock-unavailable fact of a result, if any: this server could not reach the store. */
const storeFact = (c: CheckResult) => c.blind.find((f) => f.kind === 'store-unreachable' || f.kind === 'lock-unavailable');

/**
 * The stored findings, without any about a server's own way to the store, and with this server's own writes laid
 * over them where a late write of an older state has since overwritten one. Also the writes laid over (`won`).
 */
function mergeWritten(stored: FindingRecord[], written: Map<string, Written>): { findings: FlightFinding[]; won: Map<string, Written> } {
  const out = new Map(fromRecords(stored).filter((f) => !STORE_KEYS.has(f.key)).map((f) => [f.key, f]));
  const at = new Map(stored.map((r) => [r.key, r.updatedAt]));
  const won = new Map<string, Written>();
  for (const [key, e] of written)
    if ((at.get(key) ?? -Infinity) < e.at) {
      out.set(key, e.finding);
      won.set(key, e);
    }
  return { findings: [...out.values()], won };
}

/**
 * This server's outage finding for a pass that could not reach the store: a new one, or the open one counted again.
 * One outage is one finding, whichever of the two kinds each pass met: it keeps the key it was told under.
 */
function outageFinding(result: CheckResult, open: FlightFinding | null, manifest: ManifestResult | null, now: number): FlightFinding | null {
  const seen = evaluate({ check: result, minutes: null, manifest, prior: [], memory: {}, now }).findings.find((f) => STORE_KEYS.has(f.key)) || null;
  if (!open) return seen;
  const same = seen && seen.key === open.key ? seen : open;
  return { ...same, key: open.key, count: (open.count || 0) + 1, firstAt: open.firstAt, lastAt: now, state: 'open' };
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
    /** The findings about the app as this server last wrote them to the store. */
    shared: FlightFinding[];
    /**
     * This server's own outage finding (B13): open while it cannot reach the store, then resolved until the next
     * outage. Only this server holds it; another server's view of the store never changes it.
     */
    outage: FlightFinding | null;
    /**
     * This server's own notify state, in memory only: the counter for what it tells about its own way to the store,
     * with the same hourly limit and digest as the store's shared one.
     */
    own: NotifyState | undefined;
    /**
     * What this server last wrote, by key, for a lock's lease: a record older than it in the store is a late write
     * of an older state (a pass that ran past its time limit, read before this write and landed after it), so this
     * server's own write stands and is written again, and nothing is told twice.
     */
    written: Map<string, Written>;
  } | null = null;
  let checkEvery = 60_000;
  let checkTimeout = CHECK_TIMEOUT_MS;
  /** The lock's lease: a lock its checker stopped renewing is taken over after three periods (at least three minutes). */
  const lease = () => 3 * Math.max(checkEvery, 60_000);

  /**
   * Whether this server still holds the lock, renewing it. Asked before a pass that is no longer live (it ran
   * past its time limit, maybe past the lease) writes or tells: another server may hold the lock by then, and
   * what it wrote and told is its own. False after stop(); a lock renewed while stop() ran is given back. When
   * the lock call itself fails, `unsure` is the answer: false before a write (do not overwrite), true after one
   * (the store holds the changes as told, so they are told).
   */
  async function stillHolds(r: NonNullable<typeof run>, unsure = false): Promise<boolean> {
    if (run !== r) return false;
    const ok = await r.store.lock(r.owner, lease()).then(
      (v) => v,
      () => unsure,
    );
    if (run === r) return ok;
    if (ok) void r.store.unlock(r.owner).catch(() => {});
    return false;
  }

  /**
   * This server's own way to the store, after each live step (B13). `down` is the result that could not reach the
   * store, or null when this step reached it. The first step that cannot opens this server's outage finding and
   * tells its sinks that flight cannot see; the first that can again resolves it and tells that. Nothing in
   * between is told: one outage, one of each, whichever kind each pass met. Each server does this on its own, from
   * its own memory, with no hand-over: two servers that both lose the store each tell it. What it tells is planned
   * from its own counter, so the hourly limit and the digest hold; every step plans, so a digest due goes even
   * with nothing new to tell.
   */
  function sight(r: NonNullable<typeof run>, down: CheckResult | null, now: number): void {
    if (run !== r) return;
    const changes: Change[] = [];
    const open = r.outage?.state === 'open' ? r.outage : null;
    if (down) {
      const f = outageFinding(down, open, r.manifest, now);
      if (f && !open) changes.push({ event: 'opened', finding: f });
      if (f) r.outage = f;
    } else if (open) {
      r.outage = { ...open, state: 'resolved', resolvedAt: now };
      changes.push({ event: 'resolved', finding: r.outage });
    }
    if (!changes.length && !r.own) return;
    const p = r.notifier.plan(changes, r.own, now, r.service);
    r.own = p.state;
    r.notifier.dispatch(p.deliveries);
  }

  /**
   * The findings step of a pass: findings from the check and the minutes, merged with the ones the store holds,
   * written to the store with the findings layer's memory, and only then sent to the sinks, so a change about the
   * app is told once even with several instances on one store (only the lock holder runs a pass, plans from the
   * store's notify state, and the next holder reads what was written). The write is the commit point: once the
   * store holds a change as told, it is told, even when the pass ran past its time limit meanwhile (then only while
   * this server still holds the lock), but never after stop(). A step that cannot reach the store (or read its
   * findings) tells nothing about the app: only this server's own outage (`sight`). Never throws.
   */
  async function conclude(r: NonNullable<typeof run>, result: CheckResult, minutes: InstanceMinute[] | null, useStore: boolean, isLive: () => boolean): Promise<void> {
    try {
      const now = result.at;
      let down: CheckResult | null = !useStore || storeFact(result) ? result : null;
      let records: FindingRecord[] | null = null;
      if (!down) {
        try {
          records = await r.store.findings();
        } catch (e) {
          down = notCheckedResult(r.manifest, now, { kind: 'store-unreachable', error: errorCode(e) }, 'store-unreachable');
        }
      }
      if (!records) {
        if (isLive()) sight(r, down, now);
        return;
      }
      // Own writes go once another server has written that finding since, or after a lease.
      const storedAt = new Map(records.map((x) => [x.key, x.updatedAt]));
      for (const [k, w] of r.written) if (now - w.at >= lease() || (storedAt.get(k) ?? -Infinity) > w.at) r.written.delete(k);
      const { findings: prior, won } = mergeWritten(records, r.written);
      const memory = memoryFrom(records);
      const ev = evaluate({ check: result, minutes, manifest: r.manifest, prior, memory, now, extra: r.notifier.health() });
      const facts = notCheckedFacts();
      const summary = () => ({ findings: ev.findings, checked: summaryOf(ev.findings, result, facts) });
      const changed = new Set(ev.changes.map((c) => c.finding.key));
      // From the store's notify state alone: while the store is reachable, the one count every server shares.
      const plan = r.notifier.plan(ev.changes, memory.notify as NotifyState | undefined, now, r.service, summary);
      const mem: FindingsMemory = { ...ev.memory, notify: plan.state as Record<string, unknown> };
      // A pass past its time limit writes only while this server still holds the lock: a newer holder's
      // records are not overwritten with older ones.
      if (!isLive() && !(await stillHolds(r))) return;
      // Stamped as it is written: what a pass that ran past its time limit writes is told now.
      const at = stamp(Date.now());
      // The open findings, the changed ones, and this server's own writes a late write had overwritten. A record's
      // time is when its state was told: this pass's for what it tells or keeps open, and the own write's for a
      // resolved one it only carries again.
      const told = (f: FlightFinding) => (won.has(f.key) && !changed.has(f.key) && f.state !== 'open' ? won.get(f.key)!.at : at);
      const list = ev.findings.filter((f) => f.state === 'open' || changed.has(f.key) || won.has(f.key));
      await r.store.putFindings([...list.map((f) => toRecord(f, told(f))), memoryRecord(mem, at)]);
      if (run === r) for (const f of list) r.written.set(f.key, { at: told(f), finding: f });
      // A pass that ran past its time limit while writing tells what it wrote only while this server still holds
      // the lock (another holder tells its own), and never after stop(). The time-out step told only this server's
      // own outage, and no store work starts while this pass is on its way, so what it planned is still due: it
      // is sent as planned, the same as what the store now holds. A lock call that fails here is no reason to lose
      // what the store holds as told.
      const live = isLive();
      if (!live && !(await stillHolds(r, true))) return;
      // The changes this write tells are kept under the time they are told: a record stamped while this write was
      // on its way does not undo what this server tells.
      const toldAt = stamp(Date.now());
      for (const f of list) if (changed.has(f.key) && r.written.get(f.key)?.finding === f) r.written.set(f.key, { at: toldAt, finding: f });
      r.shared = ev.findings;
      r.notifier.dispatch(plan.deliveries);
      // This server reached the store: if it could not before, it says it can see again.
      if (live) sight(r, null, now);
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
      if (!held) {
        // The lock answered: this server reaches the store, and another server checks.
        if (current()) sight(r, null, Date.now());
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
        const service = serviceOf(opts.service, manifest);
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
          shared: [],
          outage: null,
          own: undefined,
          written: new Map(),
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
    /** The findings as of the last pass this server ran, open and resolved, with its own outage finding (B13), in report order (design section 5). */
    findings: (): FlightFinding[] => (run ? sortFindings([...run.shared, ...(run.outage ? [run.outage] : [])]).map((f) => ({ ...f })) : []),
    /**
     * The report (design section 6): the service, the time window (default the last 24 hours), the open findings in
     * report order with the process keys behind them, the findings resolved in the window, each process with its
     * counts and step timings, each promise and probe with its state, the basics, whether development instruments
     * are off, what was checked and found fine, and what was not checked. Reads the store; writes nothing and tells
     * no sink. Never rejects; null when flight is off. Render it with `renderFlightMarkdown` or `renderFlightHtml`.
     */
    report: async (o: { windowMs?: number } = {}): Promise<FlightReport | null> => {
      const r = run;
      if (!r) return null;
      return collectReport({
        store: r.store,
        manifest: r.manifest,
        service: r.service,
        windowMs: o && typeof o === 'object' ? o.windowMs : undefined,
        held: r.shared,
        own: r.outage ? [r.outage] : [],
        dev: devInstruments(env),
        node: process.versions.node,
      });
    },
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
