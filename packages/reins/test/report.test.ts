import { describe, expect, it } from 'vitest';
import { buildSession, compareSessions, findings, mergeServers, renderMarkdown, routeStats, sessionBase, summarizeDom, withTimeline } from '../src/report.js';
import type { PerfReport, ServerReport, ServerRequest } from '../src/types.js';

const perf = (calls: any[], components: any[] = [], extra: Partial<PerfReport['lifecycle']> = {}): PerfReport => ({
  lifecycle: { ttfbMs: 20, domInteractiveMs: 200, domContentLoadedMs: 220, loadMs: 400, firstPaintMs: 150, firstContentfulPaintMs: 160, domNodes: 300, nowMs: 5000, ...extra },
  components,
  api: {
    totalCalls: calls.length,
    failedCalls: calls.filter((c) => !c.status || c.status >= 400).length,
    avgMs: calls.length ? Math.round(calls.reduce((a, c) => a + c.ms, 0) / calls.length) : 0,
    maxMs: Math.max(0, ...calls.map((c) => c.ms)),
    slowest: calls[0] || null,
    calls,
  },
  actions: [{ name: '[reins] mark-paid', startMs: 900, durationMs: 30 }],
});

const req = (o: Partial<ServerRequest>): ServerRequest => ({
  method: 'GET',
  route: '/api/invoices',
  url: '/api/invoices',
  status: 200,
  ms: 100,
  startMs: 10000,
  at: 1,
  dbMs: 0,
  spans: [],
  outbound: [],
  ...o,
});

const server = (requests: ServerRequest[]): ServerReport => ({
  runtime: { node: 'v22.0.0', pid: 1, uptimeS: 10, rssMb: 80, heapUsedMb: 20, eventLoop: { p50Ms: 10, p99Ms: 22, maxMs: 40 } },
  requests,
  slowest: routeStats(requests),
  spans: [],
  outbound: [],
  actions: [],
});

const nPlusOne = req({
  traceId: 'abc123-1',
  ms: 470,
  dbMs: 440,
  spans: [{ name: 'db.listInvoices', startMs: 1, ms: 40 }, ...Array.from({ length: 8 }, (_, i) => ({ name: 'db.getCustomer', startMs: 41 + i * 50, ms: 50 }))],
  outbound: [{ method: 'POST', url: 'http://127.0.0.1:9/charge', status: 200, startMs: 5, ms: 12 }],
});

const before = () =>
  buildSession({
    title: 'Invoices before fix',
    source: 'bridge',
    reinsVersion: '0.1.0',
    createdAt: '2026-11-10T06:30:00.000Z',
    app: { url: 'http://localhost:5173/', title: 'Payday', platform: 'web' },
    perf: perf(
      [
        { method: 'GET', url: '/api/invoices?page=1', status: 200, startMs: 1000, ms: 520, traceId: 'abc123-1' },
        { method: 'GET', url: '/api/invoices?page=1', status: 200, startMs: 1300, ms: 90 },
        { method: 'GET', url: '/api/invoices?page=1', status: 200, startMs: 1600, ms: 80 },
        { method: 'POST', url: '/api/pay', status: 500, startMs: 2500, ms: 40 },
      ],
      [{ id: 'invoice-list', mountedAtMs: 300, lastRenderMs: 2000, renders: 14 }],
      { firstContentfulPaintMs: 2100 },
    ),
    errors: [{ kind: 'console', message: 'Payment failed | retry', at: 1 }],
    dom: {
      'invoice-list': {
        tag: 'div',
        panel: 'invoice-list',
        box: { x: 0, y: 0, width: 10, height: 10 },
        styles: {},
        issues: [],
        children: [{ tag: 'td', id: 'client', text: 'Atelier Lumière', box: { x: 0, y: 0, width: 10, height: 10 }, styles: {}, issues: ['horizontal-clip'], children: [] }],
      },
    },
    server: server([nPlusOne]),
    snaps: ['.reins/snaps/invoice-list-1.png'],
    audit: [{ at: '2026-11-10T06:29:00.000Z', source: 'agent', event: 'reins_run_action', name: 'mark-paid', ok: true, ms: 31 }],
  });

const after = () =>
  buildSession({
    title: 'Invoices after fix',
    source: 'bridge',
    reinsVersion: '0.1.0',
    createdAt: '2026-11-10T06:40:00.000Z',
    perf: perf([{ method: 'GET', url: '/api/invoices?page=1', status: 200, startMs: 1000, ms: 120, traceId: 'abc123-9' }], [{ id: 'invoice-list', mountedAtMs: 300, lastRenderMs: 900, renders: 3 }]),
    server: server([req({ traceId: 'abc123-9', ms: 70, dbMs: 45, spans: [{ name: 'db.listInvoices', startMs: 1, ms: 20 }, { name: 'db.getCustomers', startMs: 21, ms: 25 }] })]),
  });

describe('withTimeline', () => {
  it('builds the timeline and joins the server half by trace id', () => {
    const s = before();
    const tl = s.perf!.timeline!;
    expect(tl.map((e) => e.atMs)).toEqual([...tl.map((e) => e.atMs)].sort((a, b) => a - b));
    expect(tl.filter((e) => e.kind === 'lifecycle').map((e) => e.name)).toEqual(['ttfb', 'domInteractive', 'domContentLoaded', 'load', 'firstContentfulPaint']);
    const srv = tl.find((e) => e.kind === 'server')!;
    expect(srv).toMatchObject({ name: 'GET /api/invoices', traceId: 'abc123-1', durationMs: 470, dbMs: 440, atMs: 1025 });
    expect(srv.spans).toHaveLength(9);
    expect(tl.some((e) => e.kind === 'action' && e.name === '[reins] mark-paid')).toBe(true);
  });

  it('trims page calls to timing fields', () => {
    const p = perf([{ method: 'GET', url: '/x', status: 200, startMs: 1, ms: 2, at: 5, requestHeaders: { authorization: '[redacted]' } }]);
    expect(withTimeline(p).api.calls[0]).toEqual({ method: 'GET', url: '/x', status: 200, startMs: 1, ms: 2, traceId: undefined });
  });
});

describe('findings', () => {
  it('flags each rule in plain language', () => {
    const f = findings(before());
    const keys = f.map((x) => x.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'slow-api GET /api/invoices',
        'duplicate-calls GET /api/invoices',
        'failed-api POST /api/pay',
        'renders invoice-list',
        'slow-fcp',
        'errors',
        'layout invoice-list',
        'server-span GET /api/invoices db.getCustomer',
      ]),
    );
    expect(f.find((x) => x.key.startsWith('server-span'))!.text).toContain('N+1');
    expect(f.find((x) => x.key === 'failed-api POST /api/pay')!.level).toBe('error');
  });

  it('stays quiet for a clean session', () => {
    expect(findings(after())).toEqual([]);
  });
});

describe('renderMarkdown', () => {
  it('renders every section with escaped cells and relative snap links', () => {
    const md = renderMarkdown(before(), { link: (p) => '../../' + p });
    for (const h of ['# reins session: Invoices before fix', '## Summary', '## Findings', '## Timeline', '## API calls', '## Server', '## Panels', '## Errors', '## Layout issues', '## Actions run', '## Screenshots'])
      expect(md).toContain(h);
    expect(md).toContain('Payment failed \\| retry');
    expect(md).toContain('(../../.reins/snaps/invoice-list-1.png)');
    expect(md).toContain('db.getCustomer ×8');
    expect(md).toContain('| mark-paid |');
  });

  it('says so when nothing crossed the thresholds', () => {
    expect(renderMarkdown(after())).toContain('Nothing crossed the thresholds');
  });
});

describe('compareSessions', () => {
  it('prints before/after/delta with better/worse words and resolved findings', () => {
    const c = compareSessions(before(), after());
    expect(c.markdown).toContain('| API max (ms) | 520 | 120 | ▼ 400 ms (−77%) better |');
    expect(c.markdown).toContain('| GET /api/invoices | 230 | 120 | ▼ 110 ms (−48%) better |');
    expect(c.markdown).toContain('| invoice-list | 14 | 3 | ▼ 11 (−79%) better |');
    expect(c.resolved.map((x) => x.key)).toContain('server-span GET /api/invoices db.getCustomer');
    expect(c.newFindings).toEqual([]);
    const worse = compareSessions(after(), before());
    expect(worse.markdown).toContain('▲ 400 ms (+333%) worse');
  });
});

describe('helpers', () => {
  it('names files safely and summarises DOM trees and servers', () => {
    expect(sessionBase('2026-11-10T06:30:00.123Z', 'Checkout: before fix!')).toBe('2026-11-10T06-30-00-123Z-checkout-before-fix');
    expect(summarizeDom('p', null)).toEqual({ nodes: 0, issues: [] });
    const m = mergeServers([server([req({ ms: 10 })]), server([req({ ms: 30, route: '/api/b' })])])!;
    expect(m.requests).toHaveLength(2);
    expect(m.slowest[0]).toMatchObject({ route: '/api/b', avgMs: 30 });
    expect(mergeServers([])).toBeNull();
  });
});
