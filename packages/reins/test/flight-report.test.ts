// Design section 6, unit u5 behaviours B1 to B6: flight.report(), its Markdown and HTML renderers, a finding's
// Markdown with its key, and `reins flight report` with --config, a saved file, --json and --compare.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareFlightReports, createFlight, type Flight, type FlightFinding, type FlightReport, findingMarkdown, parseFlightReport, renderFlightHtml, renderFlightMarkdown } from '../src/flight.js';
import type { CheckResult } from '../src/flight/checker.js';
import { buildReport, collectReport, REPORT_FORMAT } from '../src/flight/report.js';
import { validateManifest } from '../src/flight/manifest.js';
import { flightMain } from '../src/flight/check-cli.js';
import { fileStore } from '../src/flight/file-store.js';
import { type FlightStore, memoryStore } from '../src/flight/store.js';
import { fig, im, MIN } from './flight-fixtures.js';
import { step } from './flight-store-contract.js';

const H = 60 * MIN;
const flights: Flight[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of flights.splice(0)) f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete (globalThis as any).__reinsFlightReportTest;
  vi.useRealTimers();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'reins-flight-report-'));
  dirs.push(d);
  return d;
};
/**
 * A folder for config modules the CLI imports in this test. Under vitest on Windows, a module on another drive than
 * the project (the temp folder) cannot be imported, so these live in the project's ignored node_modules/.cache.
 */
const moduleDir = () => {
  const cache = fileURLToPath(new URL('../../../node_modules/.cache', import.meta.url));
  mkdirSync(cache, { recursive: true });
  const d = mkdtempSync(join(cache, 'reins-flight-report-'));
  dirs.push(d);
  return d;
};

const manifest = () => ({
  schema: 1,
  service: 'payday',
  processes: [
    {
      name: 'payout',
      key: 'the payout id',
      steps: ['requested', 'bank.sent', 'bank.pending', 'bank.settled', 'bank.failed', 'ledger.debited'],
      ends: ['ledger.debited', 'bank.failed'],
      promises: [
        { id: 'pending-settles', kind: 'within', after: 'bank.pending', expect: ['bank.settled', 'bank.failed'], within: '4h', why: 'A stuck transfer is money owed.' },
        { id: 'one-debit', kind: 'once', step: 'ledger.debited' },
      ],
    },
  ],
  probes: [{ id: 'pool-matches-ledger', every: '15m' }],
});

/**
 * A store with four payout runs (one overdue, one settled and debited, one failed, one just started), an
 * undeclared refund process, and a minute of traffic.
 */
async function seeded(now: number, store: FlightStore = memoryStore()) {
  await store.addSteps([
    step('p1', 'requested', now - 10 * H),
    step('p1', 'bank.sent', now - 10 * H + MIN),
    step('p1', 'bank.pending', now - 9 * H),
    step('p2', 'requested', now - 3 * H),
    step('p2', 'bank.sent', now - 3 * H + MIN),
    step('p2', 'bank.pending', now - 2 * H),
    step('p2', 'bank.settled', now - H),
    step('p2', 'ledger.debited', now - H + MIN),
    step('p3', 'requested', now - 2 * H),
    step('p3', 'bank.sent', now - 2 * H + MIN),
    step('p3', 'bank.failed', now - 90 * MIN),
    step('p4', 'requested', now - 30 * MIN),
    step('r1', 'started', now - 20 * MIN, 'refund'),
  ]);
  await store.putMinute(im('a', now - MIN, { requests: [['GET', '/api/pay', fig(100, 1, 20)]] }, { steps: { 'refund started': 1 } }));
  return store;
}

async function startedReport(now = Date.now()) {
  const store = await seeded(now);
  const f = createFlight({});
  flights.push(f);
  expect(f.start({ store, manifest: manifest(), checkEveryMs: 0, flushMs: 60_000, instance: 'srv', notify: { daily: false } })).toBe(true);
  await f.checkNow();
  const r = await f.report();
  expect(r).not.toBeNull();
  return { f, store, r: r! };
}

const finding = (over: Partial<FlightFinding>): FlightFinding => ({ key: 'basic:x', kind: 'basic', level: 'warn', text: 'A finding.', count: 1, firstAt: 1_000, lastAt: 2_000, state: 'open', ...over });
const emptyCheck = (now: number): CheckResult => ({ at: now, manifest: 'none', promises: [], probes: [], blind: [] });
const base = (now: number, over: Partial<Parameters<typeof buildReport>[0]> = {}) =>
  buildReport({ service: 'svc', now, windowMs: 24 * H, manifest: null, check: emptyCheck(now), minutes: [], stored: [], storedAt: null, processes: [], moreProcesses: 0, ...over });

describe('B1: flight.report() returns the data of design section 6', () => {
  it('has the service, the window, each process with its counts and step timings, and each promise and probe with its state', async () => {
    const now = Date.now();
    const { r } = await startedReport(now);
    expect(r.format).toBe(REPORT_FORMAT);
    expect(r.service).toBe('payday');
    expect(r.window.to - r.window.from).toBe(24 * H);
    expect(r.window.to).toBeGreaterThanOrEqual(now);

    const payout = r.processes.find((p) => p.name === 'payout')!;
    expect(payout).toMatchObject({ declared: true, started: 4, inProgress: 2, ended: 2, byEnd: { 'ledger.debited': 1, 'bank.failed': 1 } });
    expect(payout.steps.map((s) => s.step)).toEqual(['requested', 'bank.sent', 'bank.pending', 'bank.settled', 'bank.failed', 'ledger.debited']);
    expect(payout.steps.find((s) => s.step === 'requested')).toMatchObject({ count: 4, p50Ms: 0 });
    expect(payout.steps.find((s) => s.step === 'bank.settled')).toMatchObject({ count: 1, p50Ms: 2 * H, p95Ms: 2 * H, end: false });
    expect(payout.steps.find((s) => s.step === 'ledger.debited')).toMatchObject({ count: 1, end: true });
    const refund = r.processes.find((p) => p.name === 'refund')!;
    expect(refund).toMatchObject({ declared: false, started: 1, inProgress: null });
    expect(r.notChecked).toContain('Runs of refund in progress are not counted: it is not in the manifest, so its end steps are not known.');

    expect(r.promises.find((p) => p.id === 'pending-settles')).toMatchObject({ process: 'payout', state: 'broken', count: 1, why: 'A stuck transfer is money owed.' });
    expect(r.promises.find((p) => p.id === 'one-debit')).toMatchObject({ state: 'held' });
    expect(r.checked.some((l) => /^Promise one-debit of payout held/.test(l))).toBe(true);
    expect(r.probes).toEqual([expect.objectContaining({ id: 'pool-matches-ledger', state: 'not-checked', reason: 'not-registered' })]);
  });

  it('has the open findings in order with the process keys behind them, the basics, and what was checked and not', async () => {
    const { r } = await startedReport();
    const broken = r.findings.find((f) => f.key === 'promise:payout:pending-settles')!;
    expect(broken).toMatchObject({ kind: 'broken', level: 'error', state: 'open' });
    // Process keys are in the server-side report object (B6).
    expect(broken.keys).toEqual(['p1']);
    // Not registered: a blind finding, and a not-checked line for the probe.
    expect(r.findings[0].kind).toBe('blind');
    expect(r.notChecked).toContain('Probe pool-matches-ledger is not checked: no instance registered it with flight.probe().');
    // Said once: the probe's own line, not the blind fact's text again.
    expect(r.notChecked.filter((l) => /pool-matches-ledger/.test(l))).toHaveLength(1);
    expect(r.findings.find((f) => f.key === 'blind:probe-not-registered:pool-matches-ledger')).toBeTruthy();
    // The basics: figures and each built-in check.
    expect(r.basics).toMatchObject({ requests: 100, failed: 1 });
    expect(r.basics.routes[0]).toMatchObject({ name: 'GET /api/pay', count: 100, errors: 1 });
    expect(r.basics.checks.find((c) => c.check === 'error-share')).toMatchObject({ state: 'fine' });
    expect(r.checked.some((l) => /^Failed requests: 1 of 100/.test(l))).toBe(true);
    expect(r.notChecked.some((l) => /^Upstream hosts: no upstream call was recorded/.test(l))).toBe(true);
    expect(r.checked.some((l) => /^The manifest is valid/.test(l))).toBe(true);
  });

  it('orders findings by kind, then level, and lists resolved ones of the window apart', () => {
    const now = 100 * H;
    const stored = [
      finding({ key: 'unusual:step:a', kind: 'unusual' }),
      finding({ key: 'basic:slow', kind: 'basic', level: 'warn' }),
      finding({ key: 'promise:p:x', kind: 'broken', level: 'error' }),
      finding({ key: 'basic:error-share', kind: 'basic', level: 'error' }),
      finding({ key: 'blind:no-instance', kind: 'blind' }),
      finding({ key: 'drifting:route:x', kind: 'drifting' }),
      finding({ key: 'promise:p:old', kind: 'broken', level: 'error', state: 'resolved', resolvedAt: now - 2 * H }),
      finding({ key: 'promise:p:older', kind: 'broken', level: 'error', state: 'resolved', resolvedAt: now - 30 * H }),
    ];
    const r = base(now, { stored });
    expect(r.findings.map((f) => f.key)).toEqual(['blind:no-instance', 'basic:error-share', 'basic:slow', 'promise:p:x', 'drifting:route:x', 'unusual:step:a']);
    expect(r.resolved.map((f) => f.key)).toEqual(['promise:p:old']);
  });

  it('lists what was not checked: dropped steps, a store that cannot be read, and no manifest', async () => {
    const now = Date.now();
    const store = await seeded(now);
    await store.putMinute(im('a', now - 2 * MIN, {}, { stepsDropped: { payout: 4 } }));
    const f = createFlight({});
    flights.push(f);
    f.start({ store, manifest: manifest(), checkEveryMs: 0, flushMs: 60_000, instance: 'srv', notify: { daily: false } });
    const r = (await f.report())!;
    expect(r.notChecked.some((l) => /^4 steps of payout were dropped since/.test(l))).toBe(true);
    expect(r.promises.find((p) => p.id === 'one-debit')).toMatchObject({ state: 'not-checked', reason: 'steps-dropped' });
    expect(r.notChecked).toContain('Promise one-debit of payout is not checked: steps were dropped in its window.');

    const down = memoryStore();
    for (const m of ['minutes', 'findings', 'runSteps', 'openRuns', 'probes'] as const) (down as any)[m] = async () => Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    const g = createFlight({});
    flights.push(g);
    g.start({ store: down, checkEveryMs: 0, flushMs: 60_000, instance: 'srv2' });
    const d = (await g.report())!;
    expect(d.findings.map((x) => x.key)).toContain('blind:store-unreachable');
    expect(d.notChecked).toContain('The store could not be read (ECONNREFUSED), so nothing was checked.');
    expect(d.notChecked.some((l) => /^The steps in the store could not be read/.test(l))).toBe(true);
    expect(d.notChecked.some((l) => /^There is no manifest/.test(l))).toBe(true);
  });

  it('says the store did not answer when it does not answer in time, instead of waiting', async () => {
    const hung = memoryStore();
    for (const m of ['minutes', 'findings', 'runSteps', 'openRuns', 'probes'] as const) (hung as any)[m] = () => new Promise(() => {});
    const r = await collectReport({ store: hung, manifest: validateManifest(manifest()), service: 'svc', timeoutMs: 50 });
    expect(r.findings.map((f) => f.key)).toEqual(['blind:store-unreachable']);
    expect(r.notChecked).toContain('The store did not answer within the time limit, so nothing was checked.');
    expect(r.promises.every((p) => p.state === 'not-checked' && p.reason === 'store-unreachable')).toBe(true);
    expect(r.notChecked.some((l) => /^The steps in the store could not be read \(timeout\)/.test(l))).toBe(true);
  });

  it('is null when flight is off, and writes nothing to the store', async () => {
    expect(await createFlight({}).report()).toBeNull();
    const { f, store } = await startedReport();
    const before = JSON.stringify(await store.findings());
    await f.report();
    expect(JSON.stringify(await store.findings())).toBe(before);
  });
});

describe('B4: development instruments and what this Node version cannot record', () => {
  it('reads the minutes of a window longer than the checker reads, for dev instances and Node versions', async () => {
    const now = Date.now();
    const store = memoryStore();
    // 30 hours ago: older than the checker's 24 hours, inside a 48 hour window.
    await store.putMinute(im('old', now - 30 * H, {}, { devModule: true }));
    const day = await collectReport({ store, manifest: null, service: 'svc', now });
    expect(day.dev.instances).toBe(0);
    const two = await collectReport({ store, manifest: null, service: 'svc', now, windowMs: 48 * H });
    expect(two.dev.instances).toBe(1);
    expect(two.dev.off).toBe(false);
  });

  it('states that development instruments are off', async () => {
    const { r } = await startedReport();
    expect(r.dev).toMatchObject({ off: true, instances: 0, thisProcess: { devModuleLoaded: false } });
    expect(r.checked).toContain('Development instruments are off: @mindmakr/reins/node is not loaded in this process, and no instance in production reported it in the window.');
    expect(renderFlightMarkdown(r)).toMatch(/## Development instruments\n\nOff: @mindmakr\/reins\/node is not loaded/);
  });

  it('says so as a security finding when development reins is loaded', () => {
    const now = 100 * H;
    const r = base(now, { dev: { production: true, devModuleLoaded: true, devRecording: false } });
    expect(r.dev.off).toBe(false);
    expect(r.findings[0]).toMatchObject({ key: 'security:dev-module', kind: 'unusual', level: 'error', tags: ['security'], state: 'open' });
    expect(renderFlightMarkdown(r)).toMatch(/On: @mindmakr\/reins\/node is loaded in this process/);
    // Reported by an instance in production, through its minutes.
    const s = base(now, { minutes: [im('a', now - MIN, {}, { devModule: true })] });
    expect(s.dev).toMatchObject({ off: false, instances: 1 });
  });

  it('carries a not-checked line when node:http calls cannot be recorded on this Node version', () => {
    const now = 100 * H;
    expect(base(now, { node: '18.20.0' }).notChecked).toContain('Upstream calls through node:http and node:https are not checked on Node 18.20.0; Node 20 or newer records them.');
    expect(base(now, { node: '22.14.0' }).notChecked.some((l) => /node:http/.test(l))).toBe(false);
    // From the CLI, the instances' own versions, as their minutes report them.
    const m = im('a', now - MIN);
    m.basics!.runtime!.node = 'v20.11.0';
    expect(base(now, { minutes: [m] }).notChecked.some((l) => /^Failed upstream calls through node:http and node:https are not checked on Node 20\.11\.0/.test(l))).toBe(true);
    expect(base(now).notChecked).toContain('No instance reported its Node version in the window, so whether its node:http and node:https calls are recorded is not known.');
  });
});

/** A report with `n` open findings and one resolved. */
const withFindings = (n: number) => {
  const now = 100 * H;
  const stored = Array.from({ length: n }, (_, i) => finding({ key: `basic:f${i}`, text: `Finding number ${i}.` }));
  stored.push(finding({ key: 'promise:p:done', kind: 'broken', level: 'error', text: 'A breach that resolved.', state: 'resolved', resolvedAt: now - H }));
  return base(now, { stored });
};
const section = (md: string, title: string) => {
  const at = md.indexOf(`\n## ${title}\n`);
  if (at < 0) return null;
  const end = md.indexOf('\n## ', at + 1);
  return md.slice(at, end < 0 ? undefined : end);
};

describe('B2: the renderers are pure and lead with at most five findings', () => {
  it('give the same text for the same data, whatever the clock, and leave the data as it was', async () => {
    const { r } = await startedReport();
    const copy = JSON.parse(JSON.stringify(r));
    const md = renderFlightMarkdown(r);
    const html = renderFlightHtml(r);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    expect(renderFlightMarkdown(r)).toBe(md);
    expect(renderFlightHtml(r)).toBe(html);
    expect(r).toEqual(copy);
    // A saved report renders the same as the object.
    expect(renderFlightMarkdown(parseFlightReport(JSON.stringify(r)))).toBe(md);
  });

  it('lead with five findings, list the rest under Everything else and resolved ones under Resolved in this period', () => {
    const r = withFindings(8);
    const md = renderFlightMarkdown(r);
    expect(section(md, 'Findings')!.match(/^- \*\*/gm)).toHaveLength(5);
    expect(section(md, 'Everything else')!.match(/^- \*\*/gm)).toHaveLength(3);
    expect(section(md, 'Resolved in this period')).toMatch(/`promise:p:done`: A breach that resolved\./);
    const html = renderFlightHtml(r);
    const lead = html.slice(html.indexOf('<h2>Findings</h2>'), html.indexOf('<h2>Everything else</h2>'));
    expect(lead.match(/<li class="finding/g)).toHaveLength(5);
    expect(html.slice(html.indexOf('<h2>Everything else</h2>'), html.indexOf('<h2>Resolved in this period</h2>')).match(/<li class="finding/g)).toHaveLength(3);
    expect(html.slice(html.indexOf('<h2>Resolved in this period</h2>'))).toMatch(/A breach that resolved\./);
  });

  it('show no Everything else with five or fewer, and say when nothing is open', () => {
    expect(section(renderFlightMarkdown(withFindings(5)), 'Everything else')).toBeNull();
    expect(renderFlightHtml(withFindings(5))).not.toMatch(/Everything else/);
    const md = renderFlightMarkdown(withFindings(0));
    expect(section(md, 'Findings')).toMatch(/No open findings\./);
  });

  it('show every section of the report', async () => {
    const { r } = await startedReport();
    const md = renderFlightMarkdown(r);
    for (const t of ['Findings', 'Resolved in this period', 'Processes', 'Promises', 'Probes', 'Basics', 'Development instruments', 'Checked and found fine', 'Not checked']) expect(section(md, t), t).not.toBeNull();
    expect(md).toMatch(/^# reins flight report: payday$/m);
    expect(md).toMatch(/Started 4 · in progress 2 · ended 2 \(ledger\.debited 1, bank\.failed 1\)\./);
    expect(md).toMatch(/\| bank\.settled \| 1 \| 2 h \| 2 h \|/);
    expect(md).toMatch(/\| payout \/ pending-settles \| broken by 1 run \| /);
    expect(renderFlightHtml(r)).toMatch(/<h3>payout<\/h3>/);
  });

  it('keeps the layout fixes: a resolved finding wears the ok badge, number cells are class n, the probes table has its own class', async () => {
    const { r } = await startedReport();
    r.resolved = [finding({ key: 'promise:p:done', kind: 'promise', level: 'error', text: 'A breach that resolved.', state: 'resolved', resolvedAt: r.at })];
    const html = renderFlightHtml(r);
    const resolved = html.slice(html.indexOf('<h2>Resolved in this period</h2>'));
    expect(resolved).toMatch(/<span class="badge ok">resolved<\/span>/);
    expect(resolved).not.toMatch(/class="badge (error|warn)"/);
    expect(html).toMatch(/<td class="n">\d+<\/td>/);
    expect(html).toMatch(/<th scope="col" class="n">/);
    expect(html).toMatch(/<table class="t-probes">/);
    expect(html).toMatch(/\.t-probes th:nth-child\(1\)\{/);
  });
});

const EVIL = '<img src=x onerror=alert(1)>';
/** A report with a hostile string in every field the app or a saved file supplies. */
function hostile(r: FlightReport): FlightReport {
  const x: FlightReport = JSON.parse(JSON.stringify(r));
  x.service = `svc ${EVIL}`;
  x.findings = [
    finding({ key: `basic:${EVIL}`, text: `text ${EVIL} "quoted" 'single' \`tick\``, tags: [EVIL], process: EVIL, why: EVIL, source: `${EVIL} https://evil.example/x.js`, keys: [EVIL], level: EVIL as any, kind: EVIL as any }),
    ...x.findings,
  ];
  x.resolved = [finding({ key: `r:${EVIL}`, text: EVIL, state: 'resolved', resolvedAt: x.at })];
  x.processes[0].name = EVIL;
  x.processes[0].steps[0].step = EVIL;
  x.processes[0].byEnd = { [EVIL]: 1 };
  x.promises[0].process = EVIL;
  x.promises[0].id = EVIL;
  x.probes[0].id = EVIL;
  x.basics.routes = [{ name: EVIL, count: 1, errors: 0, p95Ms: 1 }];
  x.basics.checks[0].text = EVIL;
  x.checked.push(EVIL);
  x.notChecked.push(EVIL);
  return x;
}

describe('B3: the HTML page holds no script and no external resource, and shows app strings as text', () => {
  it('escapes a hostile string in the service, step, process, finding text, tags and keys', async () => {
    const { r } = await startedReport();
    const html = renderFlightHtml(hostile(r));
    expect(html).not.toContain('<img');
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;');
    expect(html).toContain('<title>reins flight: svc &#60;img');
    // Every tag on the page is the renderer's own: no script, event attribute, link or source.
    const tags = html.match(/<[a-zA-Z!][^>]*>/g) || [];
    for (const t of tags) {
      expect(t).not.toMatch(/^<(script|img|iframe|object|embed|link|base|form|svg|math|audio|video|source)\b/i);
      expect(t).not.toMatch(/\son[a-z]+\s*=/i);
      expect(t).not.toMatch(/\s(src|href|action|srcset|poster|style)\s*=/i);
    }
    expect(html).not.toMatch(/url\(|@import|<script/i);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`);
    // An unknown level from a saved file does not reach a class name.
    expect(html).not.toMatch(/class="[^"]*&#60;/);
  });

  it('keeps Markdown from turning app strings into links, images or HTML', async () => {
    const { r } = await startedReport();
    const md = renderFlightMarkdown(hostile(r));
    // Outside code spans (a key is one, where `<` is text), every `<`, `[` and `]` is escaped.
    const prose = md.replace(/(`+)[^`]*?\1/g, '');
    expect(prose).not.toMatch(/(^|[^\\])[<[\]]/m);
    expect(md).toContain('`basic:<img src=x onerror=alert(1)>`');
    expect(md).toContain('\\<img src=x onerror=alert(1)\\>');
    // A key with backticks stays one code span.
    expect(findingMarkdown(finding({ key: 'a`b' }))).toMatch(/``a`b``/);
    // A backtick in app text cannot open a code span, and a bare URL is not left to autolink.
    const t = findingMarkdown(finding({ text: 'run `rm` at https://evil.example/x and www.evil.example' }));
    expect(t).toContain('run \\`rm\\` at https\\://evil.example/x and www\\.evil.example');
    expect(t).not.toMatch(/https:\/\/|www\.|(^|[^\\])`rm/);
  });
});

describe('B6: each finding renders as Markdown with its stable key; process keys stay in the report object', () => {
  it('renders one finding with its key, level, kind, figures, why and source', () => {
    const f = finding({ key: 'promise:payout:pending-settles', kind: 'broken', level: 'error', text: '3 runs of payout have waited.', count: 3, firstAt: Date.UTC(2026, 10, 14, 8), lastAt: Date.UTC(2026, 10, 14, 9), process: 'payout', why: 'Money owed.', source: 'reins', keys: ['secret-run-key'] });
    expect(findingMarkdown(f)).toBe(
      [
        '- **error · broken** `promise:payout:pending-settles`: 3 runs of payout have waited.',
        '  Count 3 · first 2026-11-14 08:00 UTC · last 2026-11-14 09:00 UTC · process payout.',
        '  Why: Money owed.',
        '  Source: reins',
      ].join('\n'),
    );
  });

  it('never renders process keys in the Markdown or HTML', async () => {
    const { r } = await startedReport();
    expect(r.findings.find((f) => f.keys?.includes('p1'))).toBeTruthy();
    const x: FlightReport = JSON.parse(JSON.stringify(r));
    for (const f of x.findings) if (f.keys) f.keys = ['run-key-7f3a'];
    expect(renderFlightMarkdown(x)).not.toContain('run-key-7f3a');
    expect(renderFlightHtml(x)).not.toContain('run-key-7f3a');
    expect(compareFlightReports(x, x).markdown).not.toContain('run-key-7f3a');
  });
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, print: (s: string) => out.push(s), perr: (s: string) => err.push(s) };
};

describe('a saved report with null entries', () => {
  it('renders without them instead of crashing', () => {
    const r: any = JSON.parse(JSON.stringify(withFindings(1)));
    r.processes = [null, { name: 'payout', started: 1, ended: 0, inProgress: 0, steps: [null, { step: 'requested', declared: true, count: 1 }], declared: true }];
    r.promises = [null];
    r.probes = [null];
    r.basics.checks = [null];
    r.basics.routes = [null];
    const text = JSON.stringify(r);
    expect(() => renderFlightMarkdown(parseFlightReport(text))).not.toThrow();
    expect(() => renderFlightHtml(parseFlightReport(text))).not.toThrow();
    expect(renderFlightMarkdown(parseFlightReport(text))).toContain('payout');
  });
});

describe('B5: reins flight report', () => {
  it('prints the report from the app config module, as Markdown or JSON', async () => {
    const now = Date.now();
    const dir = moduleDir();
    const store = await seeded(now, fileStore({ dir: join(dir, '.reins', 'flight') }));
    writeFileSync(join(dir, 'reins.flight.json'), JSON.stringify(manifest()));
    (globalThis as any).__reinsFlightReportTest = { store, service: 'payday-api' };
    writeFileSync(join(dir, 'flight.config.mjs'), 'export default () => globalThis.__reinsFlightReportTest;\n');
    const o = capture();
    expect(await flightMain(['report', '--config', 'flight.config.mjs'], dir, o.print, o.perr)).toBe(0);
    const md = o.out.join('\n');
    expect(md).toMatch(/^# reins flight report: payday-api$/m);
    expect(md).toMatch(/Started 4 · in progress 2 · ended 2/);
    // From the CLI, development reins outside production is not known.
    expect(md).toMatch(/Development reins outside production is seen only in the server/);
    const j = capture();
    expect(await flightMain(['report', '--config', 'flight.config.mjs', '--json'], dir, j.print, j.perr)).toBe(0);
    const data = JSON.parse(j.out.join('\n')) as FlightReport;
    expect(data).toMatchObject({ format: REPORT_FORMAT, service: 'payday-api', manifest: 'ok' });
    expect(data.promises.find((p) => p.id === 'pending-settles')?.state).toBe('broken');
  });

  it('picks the named config of a CommonJS module, whose default is its whole exports object', async () => {
    const dir = moduleDir();
    const store = await seeded(Date.now(), fileStore({ dir: join(dir, '.reins', 'flight') }));
    (globalThis as any).__reinsFlightReportTest = { store, service: 'cjs-api' };
    writeFileSync(join(dir, 'flight.config.cjs'), 'exports.config = globalThis.__reinsFlightReportTest;\n');
    const o = capture();
    expect(await flightMain(['report', '--config', 'flight.config.cjs'], dir, o.print, o.perr)).toBe(0);
    expect(o.out.join('\n')).toMatch(/^# reins flight report: cjs-api$/m);
  });

  it('renders a saved report file, and compares two by key', async () => {
    const dir = tmp();
    const before = withFindings(3);
    const after = { ...withFindings(0), findings: [before.findings[1], finding({ key: 'unusual:step:new', kind: 'unusual', text: 'A new step.' })] };
    writeFileSync(join(dir, 'before.json'), JSON.stringify(before));
    writeFileSync(join(dir, 'after.json'), JSON.stringify(after));
    const o = capture();
    expect(await flightMain(['report', 'before.json'], dir, o.print, o.perr)).toBe(0);
    expect(o.out.join('\n')).toBe(renderFlightMarkdown(before));
    const c = capture();
    expect(await flightMain(['report', '--compare', 'before.json', 'after.json'], dir, c.print, c.perr)).toBe(0);
    const md = c.out.join('\n');
    expect(section(md, 'Resolved')).toMatch(/`basic:f0`.*\n- `basic:f2`/);
    expect(section(md, 'New')).toMatch(/^- `unusual:step:new` \(warn · unusual\): A new step\.$/m);
    expect(section(md, 'Still open')).toMatch(/`basic:f1`/);
    const j = capture();
    expect(await flightMain(['report', '--compare', 'before.json', 'after.json', '--json'], dir, j.print, j.perr)).toBe(0);
    const keys = JSON.parse(j.out.join('\n'));
    expect({ resolved: keys.resolved.map((f: FlightFinding) => f.key), new: keys.new.map((f: FlightFinding) => f.key), still: keys.still.map((f: FlightFinding) => f.key) }).toEqual({ resolved: ['basic:f0', 'basic:f2'], new: ['unusual:step:new'], still: ['basic:f1'] });
  });

  it('exits 2 with a plain message on bad usage, a bad module or a bad file', async () => {
    const dir = moduleDir();
    writeFileSync(join(dir, 'not-json.json'), '{');
    writeFileSync(join(dir, 'other.json'), '{"a":1}');
    writeFileSync(join(dir, 'broken.mjs'), 'export default {;\n');
    writeFileSync(join(dir, 'nostore.mjs'), 'export default { service: "x" };\n');
    writeFileSync(join(dir, 'throws.mjs'), 'export default () => { throw new Error("boom: secret-value"); };\n');
    const cases: Array<[string[], RegExp]> = [
      [['report'], /give --config <module>, a report file or --compare/],
      [['report', '--config'], /--config needs a value/],
      [['report', '--config', 'a.mjs', 'b.json'], /give one of --config, a report file or --compare/],
      [['report', '--nope'], /unknown option --nope/],
      [['report', 'missing.json'], /missing\.json not found/],
      [['report', 'not-json.json'], /not-json\.json is not valid JSON$/],
      [['report', 'other.json'], /other\.json is not a flight report/],
      [['report', '--compare', 'other.json', 'not-json.json'], /other\.json is not a flight report/],
      [['report', '--config', 'missing.mjs'], /missing\.mjs not found/],
      [['report', '--config', 'broken.mjs'], /broken\.mjs could not be loaded/],
      [['report', '--config', 'nostore.mjs'], /nostore\.mjs: its options have no store/],
      [['report', '--config', 'throws.mjs'], /throws\.mjs: its config function threw/],
    ];
    for (const [args, re] of cases) {
      const o = capture();
      expect(await flightMain(args, dir, o.print, o.perr), args.join(' ')).toBe(2);
      expect(o.err.join('\n'), args.join(' ')).toMatch(re);
      expect(o.err.join('\n')).not.toContain('secret-value');
      expect(o.out).toEqual([]);
    }
    const h = capture();
    expect(await flightMain(['report', '--help'], dir, h.print, h.perr)).toBe(0);
    expect(h.err.join('\n')).toMatch(/reins flight report --config <module> \[--json\]/);
    expect(h.err.join('\n')).toMatch(/process keys[^]*do not paste it where others can read it/);
  });

  it('gives a fixed message for a saved report that is not valid JSON, and quotes none of its content', async () => {
    const dir = moduleDir();
    writeFileSync(join(dir, 'env.json'), 'SECRET=hunter2\n');
    writeFileSync(join(dir, 'half.json'), '{"format": "reins-flight-report", "token": "hunter2"');
    writeFileSync(join(dir, 'version.json'), JSON.stringify({ format: REPORT_FORMAT, version: 'hunter2', findings: [] }));
    const cases: Array<[string[], RegExp]> = [
      [['report', 'env.json'], /^reins flight report: \S*env\.json is not valid JSON$/],
      [['report', 'half.json', '--json'], /^reins flight report: \S*half\.json is not valid JSON$/],
      [['report', '--compare', 'env.json', 'half.json'], /^reins flight report: \S*env\.json is not valid JSON$/],
      [['report', 'version.json'], /^reins flight report: \S*version\.json is a flight report of another version; this reins reads version 1$/],
    ];
    for (const [args, message] of cases) {
      const o = capture();
      expect(await flightMain(args, dir, o.print, o.perr), args.join(' ')).toBe(2);
      expect(o.err.join('\n'), args.join(' ')).toMatch(message);
      expect(o.err.join('\n') + o.out.join('\n')).not.toContain('hunter2');
    }
    expect(() => parseFlightReport('SECRET=hunter2')).toThrow(/^is not valid JSON$/);
  });

  const built = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const flightJs = fileURLToPath(new URL('../dist/flight.js', import.meta.url));
  it.skipIf(!existsSync(built) || !existsSync(flightJs))('runs as `npx reins flight report` with a file store config (after npm run build)', async () => {
    const now = Date.now();
    const dir = tmp();
    const storeDir = join(dir, '.reins', 'flight');
    await seeded(now, fileStore({ dir: storeDir }));
    writeFileSync(join(dir, 'reins.flight.json'), JSON.stringify(manifest()));
    writeFileSync(join(dir, 'flight.config.mjs'), `import { fileStore } from ${JSON.stringify(pathToFileURL(flightJs).href)};\nexport default { store: fileStore({ dir: ${JSON.stringify(storeDir)} }), service: 'payday' };\n`);
    const md = execFileSync(process.execPath, [built, 'flight', 'report', '--config', 'flight.config.mjs'], { cwd: dir, encoding: 'utf8' });
    expect(md).toMatch(/^# reins flight report: payday$/m);
    expect(md).toMatch(/\| payout \/ pending-settles \| broken by 1 run \|/);
    const json = execFileSync(process.execPath, [built, 'flight', 'report', '--config', 'flight.config.mjs', '--json'], { cwd: dir, encoding: 'utf8' });
    writeFileSync(join(dir, 'saved.json'), json);
    const saved = execFileSync(process.execPath, [built, 'flight', 'report', 'saved.json'], { cwd: dir, encoding: 'utf8' });
    expect(saved).toBe(`${renderFlightMarkdown(parseFlightReport(json))}\n`);
    expect(readFileSync(join(dir, 'saved.json'), 'utf8')).toContain(REPORT_FORMAT);
  });
});
