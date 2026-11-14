// @mindmakr/reins/flight: the production-safe, report-only part of reins. Node only.
// It records, checks and reports; it has no actions, no pairing, no bridge client, no token handling and no
// DOM or state reading, and it opens no port (design section 7). Importing it does nothing: `flight.start()`
// is the opt-in. It records through the strict recorder shared with @mindmakr/reins/node (design C13, C16).
// Imports: Node built-ins and reins' shared modules only. Never import ./node.js, ./index.js or ./bridge here.
import { randomBytes } from 'node:crypto';
import { check, type CheckResult, endsOf, notCheckedResult } from './flight/checker.js';
import { type Change, duration, evaluate, type FindingsMemory, type FlightFinding, fromRecords, HEALTH_KEY, memoryFrom, memoryRecord, type Observation, sortFindings, STORE_KEYS, toRecord } from './flight/findings.js';
import { createNotifier, type FlightSink, type Notification, type Notifier, type NotifyOptions, type NotifyState, type SummaryFigures } from './flight/sinks.js';
import { DEFAULT_WINDOW_MS, loadManifest, type ManifestResult, serviceOf } from './flight/manifest.js';
import { createProbes, PROBE_TIMEOUT_MS } from './flight/probes.js';
import { createStepWriter, type StepWriter } from './flight/steps.js';
import { type FindingRecord, type FlightStore, type InstanceMinute, isStore, memoryStore, type Retention, RETENTION_DEFAULTS } from './flight/store.js';
import { basicsOf } from './flight/limits.js';
import { collectReport, type FlightReport } from './flight/report.js';
import { sourceLine } from './flight/sources.js';
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
  /**
   * The server's health address (`http:` or `https:`, with no user or password, as fetch refuses those), for
   * `reins flight watch` only: the watcher polls it each period (within 10 s, and at most half of
   * `checkTimeoutMs`) and opens a basic finding while it does not answer with a 2xx status. A server ignores it,
   * and resolves that finding once no watcher polls the address. It comes from the environment, like the sinks,
   * never from the manifest.
   */
  healthUrl?: string;
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

/**
 * How long one poll of the health address may take: 10 s, and at most half the pass's time limit. The poll runs
 * beside the store work, inside that limit, so a server that does not answer is told as such, never as a store
 * that does not answer.
 */
const HEALTH_TIMEOUT_MS = 10_000;
const healthTimeoutOf =(checkTimeoutMs: number) => Math.max(1, Math.min(HEALTH_TIMEOUT_MS, Math.floor(checkTimeoutMs / 2)));

/** How long stop() waits for the store to take the queued steps and the lock back, after the pass on its way. */
const STOP_STORE_MS = 5_000;

/** `p`, or undefined once `ms` have passed. The timer does not hold the process open. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    (timer as any).unref?.();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * The ports fetch never connects to (the Fetch standard's "bad port" list): a health address on one of them could
 * never answer, so it is refused at start.
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512,
  513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

/**
 * The health address as a URL string, null when none is given, false when fetch could never poll it: not an http
 * or https URL, one with a user or password (fetch refuses those), or a port fetch never connects to.
 */
function healthUrlOf(v: unknown): string | null | false {
  if (v === undefined) return null;
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    if (u.port && BAD_PORTS.has(Number(u.port))) return false;
    return u.href;
  } catch {
    return false;
  }
}

/**
 * Polls the server's health address once, with GET, no redirects and a time limit: null when it answers with a 2xx
 * status, else the basic finding that it does not. Report only: it reads the answer's status and nothing else, and
 * calls nothing else. Never throws.
 */
async function pollHealth(url: string, timeoutMs: number): Promise<Observation | null> {
  let why: string;
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return null;
    why = `it answered with status ${res.status}`;
  } catch (e) {
    const code = errorCode(e);
    why = code === 'TimeoutError' || code === 'AbortError' ? `it did not answer within ${duration(timeoutMs)}` : `it did not answer (${code})`;
  }
  return { key: HEALTH_KEY, kind: 'basic', level: 'error', source: sourceLine('health'), text: `The server's health address failed: ${why}. The server may be down.` };
}

const nonNeg =(v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);

/** Creates an instance. Apps use the `flight` singleton; this is for tests. */
export function createFlight(env: Record<string, string | undefined> = process.env) {
  let rec: StrictRecorder | null = null;
  const probes = createProbes();
  let run: {
    store: FlightStore;
    /** The step writer of a server; null in a watcher, which records nothing. */
    writer: StepWriter | null;
    /** A watcher's poll of the server's health address (design section 5), or null. */
    health: (() => Promise<Observation | null>) | null;
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
  /** Resolves when the last stop() has written queued steps and given the lock back (true), or could not (false). */
  let closing: Promise<boolean> = Promise.resolve(true);
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
  async function conclude(r: NonNullable<typeof run>, result: CheckResult, minutes: InstanceMinute[] | null, useStore: boolean, isLive: () => boolean, health?: Observation | null): Promise<void> {
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
      const ev = evaluate({ check: result, minutes, manifest: r.manifest, prior, memory, now, extra: r.notifier.health(), health });
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
      try {
        await r.store.putFindings([...list.map((f) => toRecord(f, told(f))), memoryRecord(mem, at)]);
      } catch (e) {
        // The store answered the lock and the reads but refused the write (B10): nothing about the app is told,
        // and this server tells its own sinks once that flight cannot save what it finds, as for an outage.
        if (isLive()) sight(r, { at: now, manifest: result.manifest, promises: [], probes: [], blind: [{ kind: 'findings-unsaved', error: errorCode(e) }] }, now);
        return;
      }
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
      if (run !== r) {
        // Stopped while the lock was being taken: it is given back, so another checker takes over at once.
        await r.store.unlock(r.owner).catch(() => {});
        return null;
      }
      let minutes: InstanceMinute[] | null = null;
      // A watcher polls the health address beside the check; a server leaves it unjudged.
      const [result, health] = await Promise.all([check(r.store, r.manifest, { minutes: (m) => (minutes = m) }), r.health ? r.health() : undefined]);
      await conclude(r, result, minutes, true, current, health);
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

  /** The manifest of the options, as start() and watch() read it. Throws only with `strict: true` and an invalid manifest. */
  function manifestOf(opts: FlightOptions, cwd?: string): ManifestResult | null {
    let manifest: ManifestResult | null = null;
    try {
      manifest = loadManifest(opts.manifest, cwd);
    } catch {
      manifest = { ok: false, problems: [{ path: '(root)', message: 'could not be read' }] };
    }
    let strict = false;
    try {
      strict = opts.strict === true;
    } catch {}
    if (strict && manifest && !manifest.ok) {
      throw new Error(`reins flight: the manifest is invalid: ${manifest.problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
    }
    return manifest;
  }

  /**
   * The checker of a server (with its step writer) or of a watcher (with its health poll and no writer): one and the
   * same pass over the store, so both give the same findings from the same store (design section 8). Starts its timer.
   */
  function launch(opts: FlightOptions, manifest: ManifestResult | null, store: FlightStore, instance: string, writer: StepWriter | null, health: (() => Promise<Observation | null>) | null): void {
    const m = manifest?.ok ? manifest.manifest : undefined;
    const widest = Math.max(DEFAULT_WINDOW_MS, ...(m?.processes || []).flatMap((p) => p.promises.map((x) => x.windowMs)));
    const keep: Retention = { maxAgeMs: Math.max(RETENTION_DEFAULTS.maxAgeMs, widest + 86_400_000), ...(opts.retention && typeof opts.retention === 'object' ? opts.retention : {}) };
    const r: NonNullable<typeof run> = {
      store,
      writer,
      health,
      manifest,
      owner: `${instance}-${randomBytes(4).toString('hex')}`,
      retention: keep,
      timer: null,
      lastCheck: null,
      lastPrune: 0,
      passing: null,
      token: null,
      hung: null,
      notifier: createNotifier(opts.sinks, opts.notify && typeof opts.notify === 'object' ? opts.notify : {}),
      service: serviceOf(opts.service, manifest),
      shared: [],
      outage: null,
      own: undefined,
      written: new Map(),
    };
    run = r;
    checkEvery = nonNeg(opts.checkEveryMs, 60_000);
    checkTimeout = Math.min(nonNeg(opts.checkTimeoutMs, CHECK_TIMEOUT_MS) || CHECK_TIMEOUT_MS, 3 * Math.max(checkEvery, 60_000));
    if (checkEvery > 0) {
      r.timer = setInterval(() => void pass(), checkEvery);
      (r.timer as any).unref?.();
    }
  }

  /** Undoes launch() when a start fails after it. */
  function drop(): void {
    if (run?.timer) clearInterval(run.timer);
    run = null;
  }

  return {
    /**
     * Starts the strict recorder, the step writer, the probes and the checker. Never throws, except with
     * `strict: true` and an invalid manifest. On a bad option it starts nothing and returns false. Calling it
     * again while started does nothing and returns true; while this instance watches, it returns false.
     */
    start(o: FlightOptions = {}): boolean {
      if (run) return !!rec;
      const opts: FlightOptions = o && typeof o === 'object' ? o : {};
      const manifest = manifestOf(opts);
      let r: StrictRecorder | null = null;
      let writer: StepWriter | null = null;
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
        const w = createStepWriter({
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
        writer = w;
        w.start();
        const m = manifest?.ok ? manifest.manifest : undefined;
        launch(opts, manifest, store, instance, w, null);
        probes.start({ store, instance, declared: m?.probes || [], timeoutMs: nonNeg(opts.probeTimeoutMs, PROBE_TIMEOUT_MS) || PROBE_TIMEOUT_MS, onError: () => w.storeError() });
        rec = r;
        return true;
      } catch {
        try {
          r?.stop();
        } catch {}
        drop();
        writer?.stop();
        probes.stop();
        return false;
      }
    },
    /**
     * The watcher (design C5, sections 6 and 8; `npx reins flight watch`): runs the same checker as a server, on the
     * store of the same options, beside the server instead of in it, and delivers to their sinks. It records no
     * steps or requests, runs no probes and opens no port. Each period it also polls `healthUrl`, when given, and
     * keeps a basic finding open while the server does not answer it. It is the checker while it holds the store
     * lock, and the servers' checkers stand down; once stopped it gives the lock back, and a server checker takes
     * over at its next pass (after a crash, or a store that does not take the lock back within 5 s of stop(), within
     * the lease: three periods, at least three minutes). Runs its
     * first pass at once. `cwd` is where a manifest path, or `reins.flight.json`, is read from. Never throws, except
     * with `strict: true` and an invalid manifest. Returns false, starting nothing, without a store, on a bad
     * option or while this instance is started as a server; true while it watches.
     */
    watch(o: FlightOptions = {}, cwd?: string): boolean {
      if (run) return !rec;
      const opts: FlightOptions = o && typeof o === 'object' ? o : {};
      const manifest = manifestOf(opts, cwd);
      // An option that cannot be read (a getter that throws) is a bad option: what it threw is not passed on.
      try {
        const store = opts.store;
        if (!isStore(store)) return false;
        const instance = opts.instance;
        if (instance !== undefined && !(typeof instance === 'string' && INSTANCE.test(instance))) return false;
        const url = healthUrlOf(opts.healthUrl);
        if (url === false) return false;
        // The poll's own time limit, read when it runs: at most half the pass's limit, so it ends inside it.
        launch(opts, manifest, store, instance || `watch-${randomBytes(6).toString('hex')}`, null, url ? () => pollHealth(url, healthTimeoutOf(checkTimeout)) : null);
        void pass();
        return true;
      } catch {
        drop();
        return false;
      }
    },
    /** Whether this instance is watching (`watch()`), not started as a server. */
    isWatching: () => !!run && !rec,
    /**
     * Stops recording, writing, checking and telling: no notification starts after this, also not for what a pass
     * still on its way writes to the store. Queued steps are written in the background, after the pass on its way,
     * and then the lock is given back; `closed()` resolves when that is done.
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
        if (r.writer) {
          r.writer.stop();
          probes.stop();
        }
        const w = r.writer;
        let given = false;
        // The pass on its way ends within its own time limit; the store then has STOP_STORE_MS to take the queued
        // steps and the lock back, so a store that hangs never holds stop() open (the lock's lease runs out instead).
        const giveBack = async () => {
          await w?.flush();
          await r.store.unlock(r.owner);
          given = true;
        };
        closing = Promise.resolve(r.passing)
          .catch(() => null)
          .then(() => within(giveBack(), STOP_STORE_MS))
          .catch(() => {})
          .then(() => r.notifier.idle())
          .catch(() => {})
          .then(() => given);
      } catch {}
    },
    /**
     * Resolves when the last `stop()` has let the pass on its way end, written the queued steps, given the store lock
     * back and delivered (or failed) what was already being told: true when the store took the steps and the lock
     * back, false when it refused or did not answer within 5 s (then the lock's lease runs out, and another
     * checker takes over after it). Never rejects.
     */
    closed: (): Promise<boolean> => closing,
    isStarted: () => !!rec,
    /**
     * Records that run `key` of `process` reached `step` (design C7). Returns at once with whether it was queued;
     * never throws and never waits for the store. Before `start()` it does nothing.
     */
    step: (process: string, key: string | number, step: string): boolean => {
      try {
        return run?.writer ? run.writer.step(process, key, step) : false;
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
      await run?.writer?.flush();
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
    stepStats: () => run?.writer?.stats() || null,
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
