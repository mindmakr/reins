import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { callTool, fileAudit, Hub } from '../src/bridge/index.js';
import { reportMain } from '../src/bridge/report-cli.js';
import { createReinsNode, nodeEnabled, TRACE_HEADER } from '../src/node.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('@mindmakr/reins/node + bridge server tools + report CLI', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('refuses production unless REINS_ENABLE=1', async () => {
    expect(nodeEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(nodeEnabled({ NODE_ENV: 'production', REINS_ENABLE: '1' })).toBe(true);
    expect(nodeEnabled({ NODE_ENV: 'development' })).toBe(true);

    const node = createReinsNode({ NODE_ENV: 'production' });
    expect(await node.connect({ reconnect: false })).toBe(false);
    expect(node.isActive()).toBe(false);
  });

  it('pairs concurrently with browser client, joins x-reins-trace in reins_perf, writes reins_report, and diffs with reins report --compare', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reins-node-test-'));
    dirs.push(dir);
    const audit = fileAudit(dir);
    const hub = await Hub.start({ dir, port: 0, rotate: false, audit, log: () => {} });
    const wsUrl = `ws://127.0.0.1:${hub.port}`;

    const rn = createReinsNode({ NODE_ENV: 'development' });
    let queryMode: 'slow' | 'fast' = 'slow';

    rn.action({
      name: 'set-query-mode',
      description: 'Toggle DB query mode',
      consequential: true,
      input: { type: 'object', properties: { mode: { type: 'string', enum: ['slow', 'fast'] } }, required: ['mode'] },
      run: ({ mode }: { mode: 'slow' | 'fast' }) => {
        queryMode = mode;
        return { mode };
      },
    });

    const paired = await rn.connect({
      url: wsUrl,
      token: hub.token,
      reconnect: false,
      meta: { name: 'test-api' },
      WebSocket: WebSocket as any,
    });
    expect(paired).toBe(true);
    expect(hub.nodeClients().length).toBe(1);

    const httpServer = createServer(
      rn.wrapHandler(
        async (req, res) => {
          if (req.url?.startsWith('/api/invoices')) {
            if (queryMode === 'slow') {
              await rn.span('db.invoices.select', () => sleep(25));
              for (let i = 0; i < 4; i++) {
                await rn.span('db.line_items.select', () => sleep(35));
              }
            } else {
              await rn.span('db.invoices.select', () => sleep(5));
              await rn.span('db.line_items.select_batch', () => sleep(5));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, mode: queryMode }));
            return;
          }
          res.writeHead(404);
          res.end();
        },
        { serverTiming: true },
      ),
    );
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    const apiPort = (httpServer.address() as AddressInfo).port;

    // Connect a simulated browser client so Hub has both a page client and a node client
    let browserCalls: any[] = [];
    const browserWs = new WebSocket(wsUrl, { headers: { origin: 'http://localhost:5173' } });
    await new Promise<void>((resolve, reject) => {
      browserWs.on('open', () => {
        browserWs.send(
          JSON.stringify({
            type: 'hello',
            token: hub.token,
            version: '0.1.0',
            url: 'http://localhost:5173/',
            title: 'Test App',
            meta: { platform: 'web' },
          }),
        );
      });
      browserWs.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === 'welcome') resolve();
        if (m.type === 'call') {
          let result: unknown = null;
          if (m.method === 'list') result = { actions: [{ name: 'set-locale', description: 'Switch locale', input: { type: 'object', properties: {} } }], states: ['app'], panels: ['invoice-list'] };
          else if (m.method === 'state') result = { app: { locale: 'en' } };
          else if (m.method === 'network') result = browserCalls;
          else if (m.method === 'errors') result = [];
          else if (m.method === 'dom') result = { tag: 'section', id: 'invoice-list', classes: [], box: { x: 0, y: 0, width: 800, height: 400 }, styles: { direction: 'ltr' }, issues: [], children: [] };
          else if (m.method === 'perf') {
            const maxMs = browserCalls.length ? Math.max(...browserCalls.map((c) => c.ms)) : 0;
            const avgMs = browserCalls.length ? Math.round(browserCalls.reduce((a, c) => a + c.ms, 0) / browserCalls.length) : 0;
            result = {
              lifecycle: { ttfbMs: 12, firstPaintMs: 40, firstContentfulPaintMs: 48, domInteractiveMs: 30, domContentLoadedMs: 35, loadMs: 55, domNodes: 42, nowMs: 900 },
              components: [{ id: 'invoice-list', mountedAtMs: 45, lastRenderMs: 60, renders: 2 }],
              api: { totalCalls: browserCalls.length, failedCalls: 0, avgMs, maxMs, slowest: browserCalls[0] ?? null, calls: browserCalls },
              actions: [],
              timeline: [],
            };
          }
          browserWs.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
        }
      });
      browserWs.on('error', reject);
    });

    try {
      const ctx = { hub, dir, audit };

      // 1. Both app and server actions show in reins_list_actions
      const listed: any = await callTool(ctx, 'reins_list_actions', {});
      expect(listed.actions.map((a: any) => a.name)).toContain('set-locale');
      expect(listed.servers?.[0]?.actions.map((a: any) => a.name)).toContain('set-query-mode');

      // 2. Hit the HTTP API with x-reins-trace and secret Authorization header
      const trace1 = 'tr-slow-001';
      const t0 = Date.now();
      const res1 = await fetch(`http://127.0.0.1:${apiPort}/api/invoices?token=secret123`, {
        headers: { [TRACE_HEADER]: trace1, Authorization: 'Bearer sk-secret' },
      });
      const elapsed1 = Math.max(520, Date.now() - t0 + 380); // ensure browser call > 500ms for finding check
      expect(res1.status).toBe(200);
      expect(res1.headers.get('server-timing')).toContain('db;dur=');
      browserCalls = [{ method: 'GET', url: '/api/invoices?token=[redacted]', status: 200, startMs: 100, ms: elapsed1, traceId: trace1 }];

      // 3. reins_server returns redacted headers, dbMs, and spans
      const srv: any = await callTool(ctx, 'reins_server', { route: '/api/invoices' });
      expect(srv.requests.length).toBe(1);
      expect(srv.requests[0].traceId).toBe(trace1);
      expect(srv.requests[0].requestHeaders.authorization).toBe('[redacted]');
      expect(srv.requests[0].url).toContain('[redacted]');
      expect(srv.requests[0].spans.filter((s: any) => s.name === 'db.line_items.select').length).toBe(4);
      expect(srv.requests[0].dbMs).toBeGreaterThan(100);

      // 4. reins_perf joins the server spans onto the unified timeline via traceId
      const perf: any = await callTool(ctx, 'reins_perf', {});
      const serverRow = perf.timeline.find((e: any) => e.kind === 'server' && e.traceId === trace1);
      expect(serverRow).toBeDefined();
      expect(serverRow.spans.length).toBe(5);

      // 5. reins_report writes Markdown + JSON and flags both slow API and N+1 server spans
      const beforeReport: any = await callTool(ctx, 'reins_report', { title: 'before fix' });
      expect(beforeReport.files.json).toBeTruthy();
      expect(beforeReport.findings.some((f: any) => f.key.startsWith('slow-api'))).toBe(true);
      expect(beforeReport.findings.some((f: any) => f.text.includes('looks like an N+1 query'))).toBe(true);

      // 6. Server consequential action guard + switching to fast mode
      await expect(callTool(ctx, 'reins_run_action', { name: 'set-query-mode', input: { mode: 'fast' }, target: 'server' })).rejects.toThrow(/confirm/);
      const switched: any = await callTool(ctx, 'reins_run_action', {
        name: 'set-query-mode',
        input: { mode: 'fast' },
        confirm: true,
        target: 'server',
      });
      expect(switched).toEqual({ mode: 'fast' });

      rn.clear();
      const trace2 = 'tr-fast-002';
      const res2 = await fetch(`http://127.0.0.1:${apiPort}/api/invoices`, { headers: { [TRACE_HEADER]: trace2 } });
      expect(res2.status).toBe(200);
      browserCalls = [{ method: 'GET', url: '/api/invoices', status: 200, startMs: 120, ms: 25, traceId: trace2 }];

      const afterReport: any = await callTool(ctx, 'reins_report', { title: 'after fix' });
      expect(afterReport.findings).toEqual([]);

      // 7. CLI `reins report --compare` prints resolved findings and latency improvement
      const printed: string[] = [];
      const code = reportMain(['--compare', beforeReport.files.json, afterReport.files.json], dir, (s) => printed.push(s), () => {});
      expect(code).toBe(0);
      expect(printed[0]).toContain('### Resolved');
      expect(printed[0]).toContain('looks like an N+1 query');
      expect(printed[0]).toContain('better');
    } finally {
      browserWs.close();
      rn.disconnect();
      // Node 18 keeps idle keep-alive connections open on close(), so close() would never call back.
      await new Promise<void>((r) => {
        httpServer.close(() => r());
        httpServer.closeAllConnections?.();
      });
      await hub.close();
    }
  });
});

describe('@mindmakr/reins/node records nothing before pairing', () => {
  const noBridge = { tokenFile: join(tmpdir(), 'reins-no-such-token-file'), reconnect: false };
  const fakeReq = () => ({ method: 'GET', url: '/api/x', headers: {} });
  const fakeRes = () => ({ statusCode: 200, once: (_e: string, fn: () => void) => setTimeout(fn, 0) });

  it('is a no-op until the bridge pairs', async () => {
    const rn = createReinsNode({ NODE_ENV: 'development' });
    expect(await rn.connect(noBridge)).toBe(false);
    expect(rn.isActive()).toBe(false);
    await new Promise<void>((done) => rn.middleware()(fakeReq(), fakeRes(), () => done()));
    expect(rn.span('db.x', () => 7)).toBe(7);
    await new Promise((r) => setTimeout(r, 5));
    expect(rn.report()).toMatchObject({ runtime: null, requests: [], spans: [] });
    rn.disconnect();
  });

  it('records from connect() when standalone is set', async () => {
    const rn = createReinsNode({ NODE_ENV: 'development' });
    expect(await rn.connect({ ...noBridge, standalone: true })).toBe(false);
    expect(rn.isActive()).toBe(true);
    await new Promise<void>((done) => rn.middleware()(fakeReq(), fakeRes(), () => done()));
    await new Promise((r) => setTimeout(r, 5));
    expect(rn.report().requests.map((r) => r.route)).toEqual(['/api/x']);
    rn.disconnect();
    expect(rn.isActive()).toBe(false);
  });

  it('stays off in production even when standalone is asked for', async () => {
    const rn = createReinsNode({ NODE_ENV: 'production' });
    expect(await rn.connect({ ...noBridge, standalone: true })).toBe(false);
    expect(rn.isActive()).toBe(false);
  });
});
