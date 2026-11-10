// Session reports: pure, isomorphic functions shared by the bridge (`reins_report`, `npx reins report`)
// and by record mode (`reins/record`). No Node or DOM imports here.
import type {
  ActionInfo,
  ApiCall,
  ComponentPerf,
  DomIssue,
  DomNode,
  ErrEntry,
  NetEntry,
  PerfReport,
  PerfTimelineEntry,
  RouteStat,
  ServerReport,
  ServerRequest,
} from './types.js';

export const SCHEMA_VERSION = 1;

/** Thresholds behind the Findings section. */
export const LIMITS = { apiMs: 500, renders: 10, fcpMs: 1800, dupCalls: 3, dupWindowMs: 1000, spanShare: 0.5, spanMinMs: 100, nPlusOne: 3 };

export interface DomIssueEntry {
  panel: string;
  tag: string;
  id?: string;
  text?: string;
  issues: DomIssue[];
}

export interface PanelSummary {
  id: string;
  renders?: number;
  mountedAtMs?: number;
  lastRenderMs?: number;
  nodes: number;
  issues: number;
}

export interface AuditLine {
  at?: string;
  source?: string;
  event?: string;
  name?: string;
  via?: string;
  ok?: boolean;
  error?: string;
  ms?: number;
}

export interface SessionData {
  schemaVersion: 1;
  title: string;
  createdAt: string;
  reinsVersion: string;
  source: 'bridge' | 'record';
  app: { url?: string; title?: string; platform?: string; meta?: Record<string, string> };
  actions: ActionInfo[];
  state: Record<string, unknown> | null;
  network: NetEntry[];
  errors: ErrEntry[];
  /** Always with `timeline`. */
  perf: PerfReport | null;
  panels: PanelSummary[];
  domIssues: DomIssueEntry[];
  server: ServerReport | null;
  /** Project-relative paths of the snaps taken this session. */
  snaps: string[];
  audit: AuditLine[];
}

export interface Finding {
  /** Stable id, used to tell new findings from resolved ones in a compare. */
  key: string;
  level: 'error' | 'warn';
  text: string;
}

const R = Math.round;
const path = (url: string) => url.split(/[?#]/)[0];
const callKey = (c: { method: string; url: string }) => `${c.method} ${path(c.url)}`;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const avg = (a: number[]) => (a.length ? R(sum(a) / a.length) : 0);
const groupBy = <T>(list: T[], key: (t: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of list) m.set(key(x), [...(m.get(key(x)) || []), x]);
  return m;
};
const trimCall = ({ method, url, status, startMs = 0, ms, traceId }: ApiCall): ApiCall => ({ method, url, status, startMs, ms, traceId });

/** Per-route stats for server requests, slowest average first. */
export function routeStats(requests: ServerRequest[]): RouteStat[] {
  return [...groupBy(requests, (r) => `${r.method} ${r.route}`).values()]
    .map((rs) => ({
      method: rs[0].method,
      route: rs[0].route,
      count: rs.length,
      avgMs: avg(rs.map((r) => r.ms)),
      maxMs: Math.max(...rs.map((r) => r.ms)),
      avgDbMs: avg(rs.map((r) => r.dbMs)),
    }))
    .sort((a, b) => b.avgMs - a.avgMs);
}

/** Merges the reports of several paired servers into one. */
export function mergeServers(reports: ServerReport[]): ServerReport | null {
  if (!reports.length) return null;
  const requests = reports.flatMap((r) => r.requests).sort((a, b) => a.at - b.at);
  return {
    runtime: reports[0].runtime,
    requests,
    slowest: routeStats(requests),
    spans: reports.flatMap((r) => r.spans),
    outbound: reports.flatMap((r) => r.outbound),
    actions: reports.flatMap((r) => r.actions || []),
  };
}

/**
 * Adds the unified timeline to a perf report: lifecycle marks, panel mounts, API calls and actions,
 * plus the server half of each API call, joined by its `x-reins-trace` id. Calls are trimmed to timing fields.
 */
export function withTimeline(perf: PerfReport, server?: ServerRequest[] | null): PerfReport {
  const timeline: PerfTimelineEntry[] = [];
  const add = (e: PerfTimelineEntry) => timeline.push(e);
  const calls = perf.api.calls.map(trimCall);
  const byTrace = new Map((server || []).filter((r) => r.traceId).map((r) => [r.traceId, r]));
  for (const [k, v] of Object.entries(perf.lifecycle)) if (v != null && !/firstPaint|domNodes|nowMs/.test(k)) add({ kind: 'lifecycle', name: k.slice(0, -2), atMs: v });
  for (const c of perf.components) add({ kind: 'component-mount', name: c.id, atMs: c.mountedAtMs });
  for (const c of calls) {
    add({ kind: 'api', name: `${c.method} ${c.url}`, atMs: c.startMs || 0, durationMs: c.ms, status: c.status, traceId: c.traceId });
    const s = c.traceId && byTrace.get(c.traceId);
    if (s) {
      // Clocks differ between page and server; centre the server time inside the browser call.
      const at = R((c.startMs || 0) + Math.max(0, (c.ms - s.ms) / 2));
      add({
        kind: 'server',
        name: `${s.method} ${s.route}`,
        atMs: at,
        durationMs: s.ms,
        status: s.status,
        traceId: s.traceId,
        dbMs: s.dbMs,
        spans: s.spans.map((p) => ({ name: p.name, atMs: R(at + p.startMs), durationMs: p.ms, error: p.error })),
      });
    }
  }
  for (const a of perf.actions) add({ kind: 'action', name: a.name, atMs: a.startMs, durationMs: a.durationMs });
  timeline.sort((a, b) => a.atMs - b.atMs);
  const slowest = perf.api.slowest && trimCall(perf.api.slowest);
  return { ...perf, api: { ...perf.api, slowest, calls }, timeline };
}

/** Flattens a `reins_dom` tree: node count and the nodes that have layout issues. */
export function summarizeDom(panel: string, root: DomNode | null): { nodes: number; issues: DomIssueEntry[] } {
  let nodes = 0;
  const issues: DomIssueEntry[] = [];
  const walk = (n: DomNode) => {
    nodes++;
    if (n.issues?.length) issues.push({ panel, tag: n.tag, id: n.id, text: n.text, issues: n.issues });
    n.children?.forEach(walk);
  };
  if (root) walk(root);
  return { nodes, issues };
}

export interface SessionParts {
  title?: string;
  source: 'bridge' | 'record';
  reinsVersion: string;
  createdAt?: string;
  app?: SessionData['app'];
  actions?: ActionInfo[];
  state?: Record<string, unknown> | null;
  network?: NetEntry[];
  errors?: ErrEntry[];
  perf?: PerfReport | null;
  /** `reins_dom` tree per panel id. */
  dom?: Record<string, DomNode | null>;
  server?: ServerReport | null;
  snaps?: string[];
  audit?: AuditLine[];
}

/** Puts the gathered parts into one session record. */
export function buildSession(p: SessionParts): SessionData {
  const perf = p.perf ? withTimeline(p.perf, p.server?.requests) : null;
  const comps = new Map<string, ComponentPerf>((perf?.components || []).map((c) => [c.id, c]));
  const panels: PanelSummary[] = [];
  const domIssues: DomIssueEntry[] = [];
  for (const [id, tree] of Object.entries(p.dom || {})) {
    const d = summarizeDom(id, tree);
    const c = comps.get(id);
    panels.push({ id, renders: c?.renders, mountedAtMs: c?.mountedAtMs, lastRenderMs: c?.lastRenderMs, nodes: d.nodes, issues: d.issues.length });
    domIssues.push(...d.issues);
  }
  for (const c of comps.values()) if (!p.dom || !(c.id in p.dom)) panels.push({ id: c.id, renders: c.renders, mountedAtMs: c.mountedAtMs, lastRenderMs: c.lastRenderMs, nodes: 0, issues: 0 });
  return {
    schemaVersion: 1,
    title: p.title || 'session',
    createdAt: p.createdAt || new Date().toISOString(),
    reinsVersion: p.reinsVersion,
    source: p.source,
    app: p.app || {},
    actions: p.actions || [],
    state: p.state ?? null,
    network: p.network || [],
    errors: p.errors || [],
    perf,
    panels,
    domIssues,
    server: p.server || null,
    snaps: p.snaps || [],
    audit: p.audit || [],
  };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Plain-language flags computed by simple rules. See `LIMITS`. */
export function findings(s: SessionData): Finding[] {
  const out: Finding[] = [];
  const calls = s.perf?.api.calls || [];
  for (const [k, cs] of groupBy(calls, callKey)) {
    const max = Math.max(...cs.map((c) => c.ms));
    if (max > LIMITS.apiMs) out.push({ key: `slow-api ${k}`, level: 'warn', text: `Slow API: \`${k}\` took ${max} ms (over ${LIMITS.apiMs} ms)${cs.length > 1 ? `, slowest of ${cs.length} calls` : ''}.` });
    const failed = cs.filter((c) => !c.status || c.status >= 400);
    if (failed.length) out.push({ key: `failed-api ${k}`, level: 'error', text: `Failed API call: \`${k}\` ${failed[0].status ? `returned ${failed[0].status}` : 'did not complete (network error)'}${failed.length > 1 ? ` (${failed.length} times)` : ''}.` });
    const starts = cs.map((c) => c.startMs || 0).sort((a, b) => a - b);
    for (let i = 0; i + LIMITS.dupCalls - 1 < starts.length; i++)
      if (starts[i + LIMITS.dupCalls - 1] - starts[i] <= LIMITS.dupWindowMs) {
        out.push({ key: `duplicate-calls ${k}`, level: 'warn', text: `Possible duplicate calls: \`${k}\` was called ${LIMITS.dupCalls} or more times within 1 s.` });
        break;
      }
  }
  for (const c of s.perf?.components || [])
    if (c.renders > LIMITS.renders) out.push({ key: `renders ${c.id}`, level: 'warn', text: `Panel \`${c.id}\` rendered ${c.renders} times (over ${LIMITS.renders}).` });
  const fcp = s.perf?.lifecycle.firstContentfulPaintMs;
  if (fcp != null && fcp > LIMITS.fcpMs) out.push({ key: 'slow-fcp', level: 'warn', text: `Slow first paint: FCP was ${fcp} ms (over ${LIMITS.fcpMs} ms).` });
  if (s.errors.length) {
    const kinds = [...groupBy(s.errors, (e) => e.kind)].map(([k, es]) => plural(es.length, k === 'console' ? 'console error' : k === 'error' ? 'uncaught error' : 'unhandled rejection'));
    out.push({ key: 'errors', level: 'error', text: `${kinds.join(', ')}. First: "${cut(s.errors[0].message, 120)}".` });
  }
  for (const [panel, is] of groupBy(s.domIssues, (d) => d.panel)) {
    const counts = [...groupBy(is.flatMap((d) => d.issues), (x) => x)].map(([k, v]) => `${k} ×${v.length}`);
    out.push({ key: `layout ${panel}`, level: 'warn', text: `Layout: ${plural(is.length, 'element')} in \`${panel}\` ${is.length === 1 ? 'is' : 'are'} clipped or zero-size (${counts.join(', ')}).` });
  }
  const worst = new Map<string, { req: ServerRequest; name: string; ms: number; n: number }>();
  for (const req of s.server?.requests || []) {
    if (req.ms < LIMITS.spanMinMs) continue;
    for (const [name, sp] of groupBy(req.spans, (x) => x.name)) {
      const ms = sum(sp.map((x) => x.ms));
      const key = `${req.method} ${req.route} ${name}`;
      if (ms >= req.ms * LIMITS.spanShare && ms > (worst.get(key)?.ms ?? -1)) worst.set(key, { req, name, ms, n: sp.length });
    }
  }
  for (const [key, w] of worst) {
    const n1 = w.n >= LIMITS.nPlusOne ? `, called ${w.n} times in one request: looks like an N+1 query, batch it` : '';
    out.push({ key: `server-span ${key}`, level: 'warn', text: `Server: \`${w.name}\` took ${R(w.ms)} of ${w.req.ms} ms (${R((w.ms / w.req.ms) * 100)}%) in \`${w.req.method} ${w.req.route}\`${n1}.` });
  }
  return out;
}

const cut = (v: unknown, n: number) => {
  const t = String(v ?? '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const cell = (v: unknown) => (v === undefined || v === null || v === '' ? '' : cut(v, 160).replace(/\|/g, '\\|'));
const table = (head: string[], rows: unknown[][]) =>
  rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : '_None._';
const ms = (v: number | null | undefined) => (v == null ? '' : `${R(v)} ms`);

export interface RenderOptions {
  /** Turns a project-relative snap path into a link. Default: as is. */
  link?: (path: string) => string;
  /** Rows kept in long tables. Default 60. */
  maxRows?: number;
}

/** Renders a session as plain Markdown for models and people. */
export function renderMarkdown(s: SessionData, o: RenderOptions = {}): string {
  const max = o.maxRows ?? 60;
  const top = <T>(a: T[]) => a.slice(0, max);
  const more = (a: unknown[]) => (a.length > max ? `\n\n_${a.length - max} more not shown; see the JSON file._` : '');
  const p = s.perf;
  const l = p?.lifecycle;
  const api = p?.api;
  const srv = s.server;
  const f = findings(s);
  const out: string[] = [`# reins session: ${s.title}`, ''];
  out.push(
    table(
      ['Field', 'Value'],
      [
        ['App', s.app.url],
        ['Title', s.app.title],
        ['Platform', s.app.platform || 'web'],
        ['Recorded', s.createdAt],
        ['Source', s.source === 'record' ? 'record mode (tester export)' : 'bridge (agent)'],
        ['reins', s.reinsVersion],
      ],
    ),
  );
  const rows: unknown[][] = [
    ['TTFB', ms(l?.ttfbMs)],
    ['First contentful paint', ms(l?.firstContentfulPaintMs)],
    ['Load', ms(l?.loadMs)],
    ['DOM nodes', l?.domNodes],
    ['Panels', s.panels.length],
    ['API calls', api ? `${api.totalCalls} (${api.failedCalls} failed)` : ''],
    ['API avg / max', api ? `${api.avgMs} ms / ${api.maxMs} ms` : ''],
    ['Errors', s.errors.length],
    ['Layout issues', s.domIssues.length],
  ];
  if (srv) {
    const slow = srv.slowest[0];
    rows.push(['Server requests', `${srv.requests.length}${slow ? ` (slowest route \`${slow.method} ${slow.route}\`, avg ${slow.avgMs} ms, db ${slow.avgDbMs} ms)` : ''}`]);
    if (srv.runtime) rows.push(['Event loop p99', ms(srv.runtime.eventLoop.p99Ms)]);
  }
  out.push('', '## Summary', '', table(['Metric', 'Value'], rows));
  out.push('', '## Findings', '');
  out.push(f.length ? f.map((x) => `- ${x.level === 'error' ? '❌' : '⚠️'} ${x.text}`).join('\n') : '- ✅ Nothing crossed the thresholds.');
  if (p?.timeline) {
    const tl = p.timeline.map((e) => {
      const spans = e.spans?.length
        ? ' · ' + [...groupBy(e.spans, (x) => x.name)].map(([n, sp]) => `${n}${sp.length > 1 ? ` ×${sp.length}` : ''} ${R(sum(sp.map((x) => x.durationMs)))} ms`).join(', ')
        : '';
      return [e.atMs, e.kind, (e.kind === 'server' ? '↳ ' : '') + e.name + spans, ms(e.durationMs) + (e.dbMs ? ` (db ${R(e.dbMs)} ms)` : ''), e.status];
    });
    out.push('', '## Timeline', '', 'Milliseconds since the page started. Server rows sit inside the browser call they answer (joined by trace id).', '', table(['At', 'Kind', 'What', 'Duration', 'Status'], top(tl)) + more(tl));
  }
  const cs = api?.calls || [];
  out.push('', '## API calls', '', table(['Method', 'URL', 'Status', 'Duration', 'Start', 'Trace'], top(cs).map((c) => [c.method, c.url, c.status, ms(c.ms), c.startMs, c.traceId])) + more(cs));
  if (srv) {
    const rt = srv.runtime;
    out.push('', '## Server', '');
    if (rt) out.push(`Node ${rt.node}, up ${rt.uptimeS} s, RSS ${rt.rssMb} MB, heap ${rt.heapUsedMb} MB, event loop p50 ${rt.eventLoop.p50Ms} ms / p99 ${rt.eventLoop.p99Ms} ms / max ${rt.eventLoop.maxMs} ms.`, '');
    out.push(table(['Route', 'Calls', 'Avg', 'Max', 'Avg db'], srv.slowest.map((r) => [`${r.method} ${r.route}`, r.count, ms(r.avgMs), ms(r.maxMs), ms(r.avgDbMs)])));
    const reqs = [...srv.requests].sort((a, b) => b.ms - a.ms);
    out.push(
      '',
      '### Slowest requests',
      '',
      table(
        ['Request', 'Status', 'Duration', 'db', 'Spans', 'Outbound', 'Trace'],
        top(reqs.slice(0, 15)).map((r) => [
          `${r.method} ${r.url}`,
          r.status,
          ms(r.ms),
          ms(r.dbMs),
          [...groupBy(r.spans, (x) => x.name)].map(([n, sp]) => `${n}${sp.length > 1 ? ` ×${sp.length}` : ''}`).join(', '),
          r.outbound.map((x) => `${x.method} ${path(x.url)} ${x.status} ${x.ms} ms`).join(', '),
          r.traceId,
        ]),
      ),
    );
  }
  out.push('', '## Panels', '', table(['Panel', 'Renders', 'Mounted at', 'Last render', 'DOM nodes', 'Issues'], s.panels.map((x) => [x.id, x.renders, ms(x.mountedAtMs), ms(x.lastRenderMs), x.nodes, x.issues])));
  out.push('', '## Errors', '', table(['Kind', 'Message'], top(s.errors).map((e) => [e.kind, e.message])) + more(s.errors));
  out.push('', '## Layout issues', '', table(['Panel', 'Element', 'Issues', 'Text'], top(s.domIssues).map((d) => [d.panel, d.tag + (d.id ? '#' + d.id : ''), d.issues.join(', '), d.text])) + more(s.domIssues));
  const runs = s.audit.filter((a) => a.event === 'reins_run_action' || (a.source === 'page' && a.event === 'run'));
  out.push('', '## Actions run', '', table(['At', 'By', 'Action', 'Result', 'Duration'], runs.map((a) => [a.at, a.source === 'agent' ? 'agent' : a.via || a.source, a.name, a.ok === false ? `failed: ${a.error}` : 'ok', ms(a.ms)])));
  if (!runs.length && p?.actions.length) out.push('', table(['At', 'Action', 'Duration'], p.actions.map((a) => [a.startMs, a.name.replace('[reins] ', ''), ms(a.durationMs)])));
  out.push('', '## Screenshots', '', s.snaps.length ? s.snaps.map((x) => `- [${x.split('/').pop()}](${o.link ? o.link(x) : x})`).join('\n') : '_None._', '');
  return out.join('\n');
}

/** A file-name-safe base: `2026-11-10T06-30-00-123Z-checkout-flow`. */
export function sessionBase(createdAt: string, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
  return `${createdAt.replace(/[:.]/g, '-')}-${slug}`;
}

export interface CompareResult {
  markdown: string;
  newFindings: Finding[];
  resolved: Finding[];
}

const fmtDelta = (b: number | null | undefined, a: number | null | undefined, unit: string) => {
  if (b == null || a == null) return '';
  const d = R(a - b);
  if (!d) return '= same';
  const pct = b ? ` (${d > 0 ? '+' : '−'}${R((Math.abs(d) / b) * 100)}%)` : '';
  return `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}${unit}${pct} ${d > 0 ? 'worse' : 'better'}`;
};

/** A Markdown diff of two sessions: metrics, API time per URL, panel renders, and findings. Lower is better for every metric. */
export function compareSessions(before: SessionData, after: SessionData): CompareResult {
  const m = (s: SessionData) => {
    const reqs = s.server?.requests || [];
    return {
      'TTFB (ms)': s.perf?.lifecycle.ttfbMs,
      'First contentful paint (ms)': s.perf?.lifecycle.firstContentfulPaintMs,
      'Load (ms)': s.perf?.lifecycle.loadMs,
      'DOM nodes': s.perf?.lifecycle.domNodes,
      'API calls': s.perf?.api.totalCalls,
      'Failed API calls': s.perf?.api.failedCalls,
      'API avg (ms)': s.perf?.api.avgMs,
      'API max (ms)': s.perf?.api.maxMs,
      Errors: s.errors.length,
      'Layout issues': s.domIssues.length,
      'Server avg (ms)': s.server ? avg(reqs.map((r) => r.ms)) : null,
      'Server db avg (ms)': s.server ? avg(reqs.map((r) => r.dbMs)) : null,
      'Event loop p99 (ms)': s.server?.runtime?.eventLoop.p99Ms ?? null,
    } as Record<string, number | null | undefined>;
  };
  const mb = m(before);
  const ma = m(after);
  const unit = (k: string) => (k.includes('(ms)') ? ' ms' : '');
  const metricRows = Object.keys(mb)
    .filter((k) => mb[k] != null || ma[k] != null)
    .map((k) => [k, mb[k] ?? '', ma[k] ?? '', fmtDelta(mb[k], ma[k], unit(k))]);
  const per = (s: SessionData) => new Map([...groupBy(s.perf?.api.calls || [], callKey)].map(([k, cs]) => [k, avg(cs.map((c) => c.ms))]));
  const pb = per(before);
  const pa = per(after);
  const apiRows = [...new Set([...pb.keys(), ...pa.keys()])].sort().map((k) => [k, pb.get(k) ?? '', pa.get(k) ?? '', fmtDelta(pb.get(k), pa.get(k), ' ms')]);
  const rb = new Map(before.panels.map((x) => [x.id, x.renders]));
  const ra = new Map(after.panels.map((x) => [x.id, x.renders]));
  const panelRows = [...new Set([...rb.keys(), ...ra.keys()])].sort().map((k) => [k, rb.get(k) ?? '', ra.get(k) ?? '', fmtDelta(rb.get(k), ra.get(k), '')]);
  const fb = findings(before);
  const fa = findings(after);
  const keys = (l: Finding[]) => new Set(l.map((x) => x.key));
  const newFindings = fa.filter((x) => !keys(fb).has(x.key));
  const resolved = fb.filter((x) => !keys(fa).has(x.key));
  const still = fa.filter((x) => keys(fb).has(x.key));
  const list = (l: Finding[]) => (l.length ? l.map((x) => `- ${x.text}`).join('\n') : '- None.');
  const markdown = [
    `# reins compare: ${before.title} → ${after.title}`,
    '',
    `Before: ${before.createdAt}. After: ${after.createdAt}. ▼ means the number went down; for every row here, lower is better.`,
    '',
    '## Metrics',
    '',
    table(['Metric', 'Before', 'After', 'Change'], metricRows),
    '',
    '## API time per URL (avg)',
    '',
    table(['Call', 'Before (ms)', 'After (ms)', 'Change'], apiRows),
    '',
    '## Panel renders',
    '',
    table(['Panel', 'Before', 'After', 'Change'], panelRows),
    '',
    '## Findings',
    '',
    '### Resolved',
    '',
    list(resolved),
    '',
    '### New',
    '',
    list(newFindings),
    '',
    '### Still open',
    '',
    list(still),
    '',
  ].join('\n');
  return { markdown, newFindings, resolved };
}
