// The flight report (design section 6): the data `flight.report()` returns and `reins flight report` prints.
// One pass over the store gives the service, the time window, the findings in report order, each process with its
// counts and step timings, each promise and probe with its state, the basics, what was checked and found fine,
// and what was not checked, so that an empty list has a meaning (design section 5). It reads only; it writes
// nothing to the store and tells no sink. The renderers are in render.ts.
// Imports: reins' shared modules only (the flight safety test walks this file).
import { type DevInstruments, errorCode, notCheckedFacts } from '../recorder.js';
import { check, type CheckResult, notCheckedResult } from './checker.js';
import { blindObservation, duration, evaluate, figuresIn, type FlightFinding, fromRecords, live, type Merged, pct, plural, sortFindings, STORE_KEYS } from './findings.js';
import { type Basics, basicsOf } from './limits.js';
import { DEFAULT_WINDOW_MS, type ManifestResult } from './manifest.js';
import { type CheckId } from './sources.js';
import { OTHER_PROCESS } from './steps.js';
import { type FlightStore, type InstanceMinute, PRUNED_STEP, type StepRecord } from './store.js';

/** Marks a saved report file, so `reins flight report <file>` knows it from other JSON. */
export const REPORT_FORMAT = 'reins-flight-report';
export const REPORT_VERSION = 1;
/** A report leads with at most this many findings; the rest are under "Everything else" (design section 5). */
export const REPORT_LEAD = 5;
/** Processes and steps per process listed at most; the report says how many more there were. */
export const MAX_PROCESSES = 50;
export const MAX_STEPS = 50;
/** Routes and upstream hosts listed in the basics at most, slowest first. */
export const MAX_ROUTES = 10;

/** One step of a process in the window: how often it was recorded and how long after its run's first step. */
export interface StepTiming {
  step: string;
  /** Times it was recorded in the window. */
  count: number;
  /** It is in the manifest's steps of this process. */
  declared: boolean;
  /** It is an end step of this process. */
  end: boolean;
  /** Time from the run's first step to this step, at the 50th and 95th percentile (nearest rank); null with no whole run. */
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface ProcessReport {
  name: string;
  /** It is in the manifest. */
  declared: boolean;
  /** Runs whose first step is inside the window. */
  started: number;
  /** Runs that have reached no end step, of any age; null when the process declares no end step. */
  inProgress: number | null;
  /** Runs that reached an end step inside the window. */
  ended: number;
  /** `ended`, by the end step each run reached first. */
  byEnd: Record<string, number>;
  /** Runs with a step in the window that retention removed part of: not timed. */
  partial: number;
  steps: StepTiming[];
  /** Steps past MAX_STEPS not listed. */
  moreSteps: number;
}

export interface PromiseReport {
  process: string;
  /** The promise id; for a declared retry limit, `retries:<step>`. */
  id: string;
  kind: string;
  state: 'held' | 'broken' | 'not-checked';
  windowMs: number;
  /** Runs checked in the window. */
  runs: number;
  /** For a broken promise: the runs that break it. */
  count?: number;
  /** Runs whose expected step came, but late. */
  lateCount?: number;
  /** Why it was not checked. */
  reason?: string;
  /** The manifest's `why`. */
  why?: string;
}

export interface ProbeReport {
  id: string;
  everyMs: number;
  state: 'held' | 'broken' | 'not-checked';
  reason?: string;
  lastAt: number | null;
  why?: string;
}

export interface BasicCheck {
  check: CheckId;
  /** `finding`: an open finding is about it; `fine`: checked and found fine; `not-judged`: too little to judge. */
  state: 'finding' | 'fine' | 'not-judged';
  text: string;
}

export interface FigureRow {
  name: string;
  count: number;
  errors: number;
  p95Ms: number;
}

export interface BasicsReport {
  /** The recent window the basics are measured over. */
  windowMs: number;
  /** Instances that reported in that window. */
  instances: number;
  requests: number;
  failed: number;
  /** Routes, slowest first (at most MAX_ROUTES). */
  routes: FigureRow[];
  /** Upstream hosts, slowest first (at most MAX_ROUTES). */
  upstream: FigureRow[];
  /** The worst 99th percentile event-loop delay of a minute in that window. */
  loopP99Ms: number | null;
  /** The largest heap an instance reported in its latest minute. */
  heapUsedMb: number | null;
  checks: BasicCheck[];
}

export interface DevReport {
  /** Development reins (@mindmakr/reins/node) is loaded nowhere this report can see. */
  off: boolean;
  /** This process, when the report is made in a server (`flight.report()`). */
  thisProcess?: DevInstruments;
  /** Instances in production that reported development reins loaded in the window. */
  instances: number;
}

export interface FlightReport {
  format: typeof REPORT_FORMAT;
  version: typeof REPORT_VERSION;
  service: string;
  /** When the report was made. */
  at: number;
  window: { from: number; to: number };
  /** When the newest finding was written by a checker pass; null with none. */
  findingsAt: number | null;
  manifest: 'ok' | 'none' | 'invalid';
  /** The open findings in report order: kind order, then level (design section 5). Process keys stay in `keys`. */
  findings: FlightFinding[];
  /** Findings that resolved inside the window, newest first. */
  resolved: FlightFinding[];
  processes: ProcessReport[];
  /** Processes past MAX_PROCESSES not listed. */
  moreProcesses: number;
  promises: PromiseReport[];
  probes: ProbeReport[];
  basics: BasicsReport;
  dev: DevReport;
  /** What was checked and found fine, in plain words. */
  checked: string[];
  /** What was not checked, in plain words. */
  notChecked: string[];
}

export interface CollectOptions {
  store: FlightStore;
  manifest: ManifestResult | null;
  service: string;
  /** The report's time. Default now. */
  now?: number;
  /** The window the report covers. Default 24 hours. */
  windowMs?: number;
  /** In a server: the findings it last held, shown when the store's findings cannot be read. */
  held?: FlightFinding[];
  /** In a server: findings only it holds (its own way to the store, sinks that keep failing). */
  own?: FlightFinding[];
  /** In a server: whether development reins is loaded in it. */
  dev?: DevInstruments;
  /** In a server: its Node version, for what it cannot record. */
  node?: string;
}

const MIN = 60_000;

/** Nearest-rank percentile of a sorted list, or null. */
function rank(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Each process's steps in the window, read from the store; what the counts and timings are made from. */
export interface ProcessSteps {
  name: string;
  steps: StepRecord[];
  /** Steps of its runs that reached no end step, of any age; null when it declares no end step. */
  open: StepRecord[] | null;
}

/** The processes a report covers: those of the manifest, then those seen in the window's minutes, most steps first. */
function processNames(manifest: ManifestResult | null, minutes: InstanceMinute[], from: number): { names: string[]; more: number } {
  const declared = manifest?.ok ? manifest.manifest.processes.map((p) => p.name) : [];
  const seen = new Map<string, number>();
  for (const m of minutes) {
    if (!live(m) || m.minute < from - (from % MIN) || !m.steps || typeof m.steps !== 'object') continue;
    for (const [k, v] of Object.entries(m.steps)) {
      const name = k.slice(0, k.indexOf(' ') < 0 ? k.length : k.indexOf(' '));
      if (!name || name === OTHER_PROCESS || declared.includes(name)) continue;
      seen.set(name, (seen.get(name) || 0) + (Number(v) || 0));
    }
  }
  const extra = [...seen].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => n);
  const all = [...declared, ...extra];
  return { names: all.slice(0, MAX_PROCESSES), more: Math.max(0, all.length - MAX_PROCESSES) };
}

/** Groups steps into runs by key, each in time order. */
function runsOf(steps: StepRecord[]): Map<string, StepRecord[]> {
  const out = new Map<string, StepRecord[]>();
  for (const s of steps) {
    const l = out.get(s.key);
    if (l) l.push(s);
    else out.set(s.key, [s]);
  }
  for (const l of out.values()) l.sort((a, b) => a.at - b.at);
  return out;
}

/** One process's counts and step timings, from its steps in the window (pure). */
export function processReport(p: ProcessSteps, manifest: ManifestResult | null, from: number, to: number): ProcessReport {
  const def = manifest?.ok ? manifest.manifest.processes.find((x) => x.name === p.name) : undefined;
  const ends = def ? def.ends : [];
  const runs = runsOf(p.steps);
  const timings = new Map<string, { count: number; took: number[] }>();
  let started = 0;
  let ended = 0;
  let partial = 0;
  const byEnd: Record<string, number> = {};
  for (const run of runs.values()) {
    const real = run.filter((s) => s.step !== PRUNED_STEP);
    if (!real.length) continue;
    const isPartial = real.length !== run.length;
    if (isPartial && real.some((s) => s.at >= from)) partial++;
    const first = real[0];
    if (!isPartial && first.at >= from && first.at <= to) started++;
    const end = real.find((s) => ends.includes(s.step));
    if (end && end.at >= from && end.at <= to) {
      ended++;
      byEnd[end.step] = (byEnd[end.step] || 0) + 1;
    }
    const timed = new Set<string>();
    for (const s of real) {
      if (s.at < from || s.at > to) continue;
      let t = timings.get(s.step);
      if (!t) timings.set(s.step, (t = { count: 0, took: [] }));
      t.count++;
      // The first time a whole run reached the step, from its first step.
      if (!isPartial && !timed.has(s.step)) {
        timed.add(s.step);
        t.took.push(s.at - first.at);
      }
    }
  }
  // Declared steps first, in the manifest's order and also when not seen in the window (a count of 0 shows a
  // silent step), then the others by name.
  const order = def ? def.steps : [];
  const names = [...order, ...[...timings.keys()].filter((s) => !order.includes(s)).sort()];
  const steps: StepTiming[] = names.slice(0, MAX_STEPS).map((step) => {
    const t = timings.get(step);
    const took = t ? [...t.took].sort((a, b) => a - b) : [];
    return { step, count: t ? t.count : 0, declared: order.includes(step), end: ends.includes(step), p50Ms: rank(took, 0.5), p95Ms: rank(took, 0.95) };
  });
  let inProgress: number | null = null;
  if (p.open && ends.length) {
    const open = runsOf(p.open);
    inProgress = [...open.values()].filter((r) => r.some((s) => s.step !== PRUNED_STEP)).length;
  }
  return { name: p.name, declared: !!def, started, inProgress, ended, byEnd, partial, steps, moreSteps: Math.max(0, names.length - MAX_STEPS) };
}

const rows = (m: Map<string, Merged>): FigureRow[] =>
  [...m]
    .filter(([name]) => !name.endsWith('(other)'))
    .map(([name, f]) => ({ name, count: f.count, errors: f.errors, p95Ms: f.p95Ms }))
    .sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count || (a.name < b.name ? -1 : 1))
    .slice(0, MAX_ROUTES);

/** The basics: the figures of the recent window and, for each built-in check, whether it found something (pure). */
export function basicsReport(minutes: InstanceMinute[], now: number, b: Basics, open: FlightFinding[]): BasicsReport {
  const from = now - b.recentMs;
  const window = duration(b.recentMs);
  const recent = figuresIn(minutes, from, Infinity);
  const all = recent.all;
  const mine = minutes.filter((m) => live(m) && m.minute >= from - (from % MIN));
  const runtime = mine.filter((m) => m.basics?.runtime);
  const instances = new Set(mine.map((m) => m.instance)).size;
  let loop: number | null = null;
  for (const m of runtime) loop = Math.max(loop ?? 0, Number(m.basics!.runtime!.eventLoop?.p99Ms) || 0);
  const latest = new Map<string, InstanceMinute>();
  for (const m of runtime) if ((latest.get(m.instance)?.minute ?? -Infinity) < m.minute) latest.set(m.instance, m);
  let heap: number | null = null;
  for (const m of latest.values()) heap = Math.max(heap ?? 0, Number(m.basics!.runtime!.heapUsedMb) || 0);

  const openOf = (...prefixes: string[]) => open.filter((f) => prefixes.some((p) => f.key === p || f.key.startsWith(p + ':')));
  const checks: BasicCheck[] = [];
  const add = (check: CheckId, prefixes: string[], judged: boolean, fine: string, notJudged: string) => {
    const n = openOf(...prefixes).length;
    if (n) checks.push({ check, state: 'finding', text: `${plural(n, 'open finding')}: see above.` });
    else checks.push({ check, state: judged ? 'fine' : 'not-judged', text: judged ? fine : notJudged });
  };
  add(
    'error-share',
    ['basic:error-share'],
    all.count >= b.minRequests,
    `Failed requests: ${all.errors} of ${all.count} in the last ${window} (${all.count ? pct(all.errors / all.count) : '0%'}), within the limit of ${pct(b.errorShare)}.`,
    `Failed requests: ${plural(all.count, 'request')} in the last ${window}, fewer than the ${b.minRequests} needed to judge the share.`,
  );
  const routes = [...recent.routes].filter(([n, f]) => !n.endsWith('(other)') && f.count >= b.minCalls);
  add(
    'slow-route',
    ['basic:slow-route'],
    routes.length > 0,
    `Slow routes: none of the ${plural(routes.length, 'route')} with ${b.minCalls} or more requests in the last ${window} has its 95th percentile over ${duration(b.slowRouteMs)}.`,
    `Slow routes: no route had ${b.minCalls} or more requests in the last ${window}.`,
  );
  const hosts = [...recent.hosts].filter(([n, f]) => n !== '(other)' && f.count >= b.minCalls);
  add(
    'upstream',
    ['basic:upstream'],
    hosts.length > 0,
    `Upstream hosts: none of the ${plural(hosts.length, 'host')} with ${b.minCalls} or more calls in the last ${window} failed more than ${pct(b.upstreamErrorShare)} of them.`,
    recent.hosts.size ? `Upstream hosts: no host had ${b.minCalls} or more calls in the last ${window}.` : `Upstream hosts: no upstream call was recorded in the last ${window}.`,
  );
  add(
    'event-loop',
    ['basic:event-loop'],
    runtime.length > 0,
    `Event loop: no instance had ${plural(b.loopMinutes, 'minute')} with its 99th percentile delay over ${duration(b.loopDelayMs)} in the last ${window} (worst minute ${duration(loop ?? 0)}).`,
    `Event loop: no instance reported runtime figures in the last ${window}.`,
  );
  // Memory is judged per instance over its own window, with enough minutes spread over most of it (findings.ts).
  const heapFrom = now - b.heapWindowMs;
  const perInstance = new Map<string, number[]>();
  for (const m of minutes) {
    if (!live(m) || !m.basics?.runtime || m.minute < heapFrom) continue;
    const l = perInstance.get(m.instance);
    if (l) l.push(m.minute);
    else perInstance.set(m.instance, [m.minute]);
  }
  const heapJudged = [...perInstance.values()].filter((l) => l.length >= b.heapMinutes && Math.max(...l) - Math.min(...l) >= b.heapSpread * b.heapWindowMs - MIN).length;
  add(
    'memory',
    ['basic:memory'],
    heapJudged > 0,
    `Memory: the heap did not rise steadily by ${pct(b.heapGrowth)} or more over the last ${duration(b.heapWindowMs)} on the ${plural(heapJudged, 'instance')} with enough heap figures.`,
    `Memory: no instance has heap figures over most of the last ${duration(b.heapWindowMs)} yet.`,
  );
  const refused = Object.values(all.refused).reduce((s, x) => s + x, 0);
  add(
    'refused',
    ['basic:refused'],
    all.count > 0,
    `Refused responses: ${refused} with status 401, 403 or 429 in the last ${window}, no spike.`,
    `Refused responses: no request was recorded in the last ${window}.`,
  );
  const base = figuresIn(minutes, now - DEFAULT_WINDOW_MS, from);
  add(
    'baseline',
    ['drifting:route', 'drifting:upstream'],
    base.all.count >= b.minRequests,
    `Baselines: no route or upstream host took ${b.baselineFactor} times its usual time over the day before.`,
    `Baselines: fewer than ${b.minRequests} requests in the day before the last ${window} to compare with.`,
  );
  add(
    'new-code',
    ['unusual:code'],
    mine.some((m) => m.basics),
    `Error codes: none was seen for the first time in the last ${duration(b.newCodeMs)}.`,
    `Error codes: no instance reported request figures in the last ${window}.`,
  );
  return { windowMs: b.recentMs, instances, requests: all.count, failed: all.errors, routes: rows(recent.routes), upstream: rows(recent.hosts), loopP99Ms: loop, heapUsedMb: heap, checks };
}

const REASON: Record<string, string> = {
  'steps-dropped': 'steps were dropped in its window',
  'store-unreachable': 'the store could not be read',
  'lock-unavailable': 'the checker lock could not be taken',
  'not-registered': 'no instance registered it with flight.probe()',
  'no-result': 'it has no result yet',
  stale: 'its last result is too old',
  'no-instance': 'no server instance has reported recently',
};
/** Why a promise or probe was not checked, in plain words. */
export const reasonText = (r: string | undefined) => (r && has(REASON, r) ? REASON[r] : 'it could not be checked');

/** The Node facts of each version the instances in the window run, and of this process's version. */
function nodeFacts(minutes: InstanceMinute[], from: number, node: string | undefined): { facts: string[]; known: boolean } {
  const versions = new Set<string>();
  if (node) versions.add(node);
  for (const m of minutes) {
    const v = m.basics?.runtime?.node;
    if (live(m) && m.minute >= from && typeof v === 'string' && /^v?\d+\.\d+/.test(v)) versions.add(v.replace(/^v/, ''));
  }
  const facts = [...new Set([...versions].sort().flatMap((v) => notCheckedFacts(v)))];
  return { facts, known: versions.size > 0 };
}

/** The input of `buildReport`: what was read from the store, or null where it could not be read. */
export interface ReportInput {
  service: string;
  now: number;
  windowMs: number;
  manifest: ManifestResult | null;
  check: CheckResult;
  minutes: InstanceMinute[];
  /** The findings records as read, as findings; null when they could not be read. */
  stored: FlightFinding[] | null;
  /** When the newest finding record was written. */
  storedAt: number | null;
  held?: FlightFinding[];
  own?: FlightFinding[];
  processes: ProcessSteps[] | null;
  moreProcesses: number;
  /** The code of the error that stopped the process reads, if any. */
  processError?: string;
  dev?: DevInstruments;
  node?: string;
}

/** Builds the report from what was read (pure: the same input gives the same report). */
export function buildReport(i: ReportInput): FlightReport {
  const { now, check: c, manifest } = i;
  const from = now - i.windowMs;
  const m = manifest?.ok ? manifest.manifest : undefined;
  const b = basicsOf(m?.basics);
  const checked: string[] = [];
  const notChecked: string[] = [];

  // Findings: as the last checker pass wrote them, with this server's own ones, and what this report could not see.
  const byKey = new Map<string, FlightFinding>();
  for (const f of i.stored ?? i.held ?? []) if (!STORE_KEYS.has(f.key)) byKey.set(f.key, f);
  for (const f of i.own || []) byKey.set(f.key, f);
  const down = c.blind.find((f) => f.kind === 'store-unreachable');
  if (down && ![...byKey.values()].some((f) => STORE_KEYS.has(f.key) && f.state === 'open')) {
    const seen = evaluate({ check: notCheckedResult(manifest, now, down, 'store-unreachable'), minutes: null, manifest, prior: [], memory: {}, now }).findings.find((f) => STORE_KEYS.has(f.key));
    if (seen) byKey.set(seen.key, seen);
  }
  if (!i.stored) notChecked.push(i.held ? 'The findings in the store could not be read, so this report shows the findings as this server last saw them.' : 'The findings in the store could not be read, so no finding of a checker pass is shown.');

  // Development instruments (design C12): this process, and the instances in production that reported them.
  const devInstances = new Set(i.minutes.filter((x) => live(x) && x.devModule === true && x.minute >= from).map((x) => x.instance)).size;
  const here = i.dev;
  const devOff = !here?.devModuleLoaded && devInstances === 0;
  if (here?.devModuleLoaded && byKey.get('security:dev-module')?.state !== 'open') {
    byKey.set('security:dev-module', {
      key: 'security:dev-module',
      kind: 'unusual',
      level: here.production ? 'error' : 'warn',
      tags: ['security'],
      text: `Development reins (@mindmakr/reins/node) is loaded in this process${here.production ? ' in production' : ` (NODE_ENV is not production)`}; only @mindmakr/reins/flight belongs in production.`,
      count: 1,
      firstAt: now,
      lastAt: now,
      state: 'open',
    });
  }
  if (devOff)
    checked.push(here ? 'Development instruments are off: @mindmakr/reins/node is not loaded in this process, and no instance in production reported it in the window.' : 'Development instruments are off: no instance in production reported @mindmakr/reins/node loaded in the window.');
  if (!here) notChecked.push('Development reins outside production is seen only in the server: flight.report() there says whether it is loaded.');

  const sorted = sortFindings([...byKey.values()]);
  const findings = sorted.filter((f) => f.state === 'open');
  const resolved = sorted.filter((f) => f.state === 'resolved' && typeof f.resolvedAt === 'number' && f.resolvedAt >= from).sort((x, y) => (y.resolvedAt || 0) - (x.resolvedAt || 0));

  // The manifest.
  if (c.manifest === 'none') notChecked.push('There is no manifest (reins.flight.json), so no promise or probe is checked; the basics still are.');
  else if (c.manifest === 'invalid') notChecked.push('The manifest is invalid, so no promise or probe is checked; the basics still are. Run `npx reins flight check`.');
  else if (m) checked.push(`The manifest is valid: ${plural(m.processes.length, 'process', 'processes')}, ${plural(c.promises.length, 'promise')}, ${plural(m.probes.length, 'probe')}.`);

  // Promises and probes, as checked now.
  const why = (process: string, id: string) => m?.processes.find((x) => x.name === process)?.promises.find((x) => x.id === id)?.why;
  const promises: PromiseReport[] = c.promises.map((x) => {
    const w = why(x.process, x.id);
    const head = { process: x.process, id: x.id, kind: x.kind, windowMs: x.windowMs, runs: x.runs, ...(w ? { why: w } : {}) };
    if (x.state === 'broken') return { ...head, state: 'broken', count: x.count, lateCount: x.lateCount };
    if (x.state === 'held') return { ...head, state: 'held', lateCount: x.lateCount };
    return { ...head, state: 'not-checked', reason: x.reason };
  });
  for (const x of promises) {
    if (x.state === 'held') checked.push(`Promise ${x.id} of ${x.process} held: ${plural(x.runs, 'run')} checked in the last ${duration(x.windowMs)}${x.lateCount ? `, ${x.lateCount} of them late but now arrived` : ''}.`);
    if (x.state === 'not-checked') notChecked.push(`Promise ${x.id} of ${x.process} is not checked: ${reasonText(x.reason)}.`);
  }
  const probes: ProbeReport[] = c.probes.map((x) => {
    const w = m?.probes.find((p) => p.id === x.id)?.why;
    return { id: x.id, everyMs: x.everyMs, state: x.state, lastAt: x.lastAt, ...(x.state !== 'held' ? { reason: x.reason } : {}), ...(w ? { why: w } : {}) };
  });
  for (const x of probes) {
    if (x.state === 'held') checked.push(`Probe ${x.id} returned { ok: true }${x.lastAt ? ` at ${new Date(x.lastAt).toISOString()}` : ''}.`);
    if (x.state === 'not-checked') notChecked.push(`Probe ${x.id} is not checked: ${reasonText(x.reason)}.`);
  }

  // What flight itself could not see (the blind facts), in plain words. A probe's own line above already says why
  // it is not checked.
  for (const f of c.blind) {
    if (f.kind === 'probe-not-registered' || f.kind === 'probe-stale') continue;
    const o = blindObservation(f, b);
    if (o && !notChecked.includes(o.text)) notChecked.push(o.text);
  }
  const nf = nodeFacts(i.minutes, from, i.node);
  notChecked.push(...nf.facts);
  if (!nf.known) notChecked.push('No instance reported its Node version in the window, so whether its node:http and node:https calls are recorded is not known.');

  // The basics.
  const basics = basicsReport(i.minutes, now, b, findings);
  for (const x of basics.checks) {
    if (x.state === 'fine') checked.push(x.text);
    if (x.state === 'not-judged') notChecked.push(x.text);
  }

  // Processes.
  let processes: ProcessReport[] = [];
  if (i.processes) {
    processes = i.processes.map((p) => processReport(p, manifest, from, now));
    for (const p of processes) if (p.inProgress === null) notChecked.push(`Runs of ${p.name} in progress are not counted: ${p.declared ? 'it declares no end step' : 'it is not in the manifest, so its end steps are not known'}.`);
  } else notChecked.push(`The steps in the store could not be read${i.processError ? ` (${i.processError})` : ''}, so no process is counted.`);
  if (i.moreProcesses) notChecked.push(`${plural(i.moreProcesses, 'more process', 'more processes')} recorded steps in the window but are not listed (at most ${MAX_PROCESSES}).`);

  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    service: i.service,
    at: now,
    window: { from, to: now },
    findingsAt: i.storedAt,
    manifest: c.manifest,
    findings,
    resolved,
    processes,
    moreProcesses: i.moreProcesses,
    promises,
    probes,
    basics,
    dev: { off: devOff, ...(here ? { thisProcess: { ...here } } : {}), instances: devInstances },
    checked,
    notChecked,
  };
}

/** How long the store may take to answer for one report. */
export const REPORT_TIMEOUT_MS = 30_000;

type Read = Pick<ReportInput, 'check' | 'minutes' | 'stored' | 'storedAt' | 'processes' | 'moreProcesses' | 'processError'>;

/** The store reads of one report. Never rejects. */
async function readStore(o: CollectOptions, now: number, from: number): Promise<Read> {
  let minutes: InstanceMinute[] = [];
  const c = await check(o.store, o.manifest, { now, minutes: (x) => (minutes = Array.isArray(x) ? x : []) });
  let stored: FlightFinding[] | null = null;
  let storedAt: number | null = null;
  try {
    const records = await o.store.findings();
    stored = fromRecords(records);
    for (const r of records) if (r && typeof r.updatedAt === 'number' && typeof r.key === 'string' && !r.key.startsWith('(')) storedAt = Math.max(storedAt ?? 0, r.updatedAt);
  } catch {}
  let processes: ProcessSteps[] | null = null;
  let processError: string | undefined;
  const { names, more } = processNames(o.manifest, minutes, from);
  if (!c.blind.some((f) => f.kind === 'store-unreachable')) {
    try {
      const m = o.manifest?.ok ? o.manifest.manifest : undefined;
      const list: ProcessSteps[] = [];
      for (const name of names) {
        const ends = m?.processes.find((x) => x.name === name)?.ends || [];
        const steps = await o.store.runSteps(name, from);
        const open = ends.length ? await o.store.openRuns(name, ends) : null;
        list.push({ name, steps: Array.isArray(steps) ? steps : [], open: ends.length ? (Array.isArray(open) ? open : []) : null });
      }
      processes = list;
    } catch (e) {
      processError = errorCode(e);
    }
  }
  return { check: c, minutes, stored, storedAt, processes, moreProcesses: more, processError };
}

/**
 * Reads the store once and builds the report: findings as the last checker pass wrote them, and the promises,
 * probes, basics and processes as they stand now. Never rejects: what cannot be read, or is not read within
 * `timeoutMs` (default 30 s), is listed as not checked, with the store-unreachable finding.
 */
export async function collectReport(o: CollectOptions & { timeoutMs?: number }): Promise<FlightReport> {
  const now = typeof o.now === 'number' && Number.isFinite(o.now) ? o.now : Date.now();
  const windowMs = typeof o.windowMs === 'number' && Number.isFinite(o.windowMs) && o.windowMs >= MIN ? Math.floor(o.windowMs) : DEFAULT_WINDOW_MS;
  const limit = typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : REPORT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Read>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          check: notCheckedResult(o.manifest, now, { kind: 'store-unreachable', error: 'timeout' }, 'store-unreachable'),
          minutes: [],
          stored: null,
          storedAt: null,
          processes: null,
          moreProcesses: 0,
          processError: 'timeout',
        }),
      limit,
    );
  });
  let read: Read;
  try {
    read = await Promise.race([readStore(o, now, now - windowMs), late]);
  } finally {
    clearTimeout(timer);
  }
  return buildReport({ service: o.service, now, windowMs, manifest: o.manifest, ...read, held: o.held, own: o.own, dev: o.dev, node: o.node });
}
