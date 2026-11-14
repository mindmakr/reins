// The shared recorder in strict mode (flight), and the hooks it shares with @mindmakr/reins/node.
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlight } from '../src/flight.js';
import { createReinsNode } from '../src/node.js';
import { bounded, CAPTURE_MAX, errorCode, notCheckedFacts, routeMatcher, UNMATCHED } from '../src/recorder.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

const servers: Server[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  stops.splice(0).forEach((f) => f());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: Handler): Promise<string> {
  const s = createServer(handler as any);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function started(o: Parameters<ReturnType<typeof createFlight>['start']>[0] = {}) {
  const f = createFlight({ NODE_ENV: 'production' });
  expect(f.start(o)).toBe(true);
  stops.push(() => f.stop());
  return f;
}

/** A port with nothing listening. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpCall(url: string, method: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.on('error', reject);
    req.end();
  });
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs one request through a hook without a socket, at the wall-clock time `at`. */
function fakeRequest(hook: (req: any, res: any) => unknown, at: number) {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    hook({ method: 'GET', url: '/x', headers: {} }, Object.assign(new EventEmitter(), { statusCode: 200 }));
  } finally {
    spy.mockRestore();
  }
}

describe('strict recording (flight)', () => {
  it('records a request as method, route pattern, status and timing, and an upstream call as method, host, status and timing', async () => {
    const upstream = await serve((_q, res) => res.end('ok'));
    const f = started({ routes: ['/api/users/:id'] });
    const base = await serve(
      f.wrapHandler(async (_req: IncomingMessage, res: ServerResponse) => {
        await fetch(`${upstream}/v1/items?x=1`);
        await httpGet(`${upstream}/v2/other`);
        res.end('done');
      }),
    );
    expect((await fetch(`${base}/api/users/42?expand=1`)).status).toBe(200);
    await settle();
    const [r] = f.recorder()!.requests();
    expect(Object.keys(r).sort()).toEqual(['at', 'dbMs', 'method', 'ms', 'route', 'spans', 'status', 'upstream']);
    expect(r).toMatchObject({ method: 'GET', route: '/api/users/:id', status: 200 });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.upstream).toHaveLength(2);
    for (const u of r.upstream) {
      expect(Object.keys(u).sort()).toEqual(['host', 'method', 'ms', 'status']);
      expect(u).toMatchObject({ method: 'GET', host: '127.0.0.1', status: 200 });
    }
  });

  it('reduces a path with no route pattern to a listed pattern, or counts it as unmatched', async () => {
    const f = started({ routes: ['/files/*', '/api/orders/:id/lines'] });
    const base = await serve(f.wrapHandler((_q: IncomingMessage, res: ServerResponse) => res.end()));
    await fetch(`${base}/files/a/b/c.txt`);
    await fetch(`${base}/api/orders/9/lines/`);
    await fetch(`${base}/somewhere/else/123`);
    await settle();
    const rec = f.recorder()!;
    expect(rec.requests().map((r) => r.route)).toEqual(['/files/*', '/api/orders/:id/lines', UNMATCHED]);
    expect(rec.stats().unmatched).toBe(1);
    const [m] = rec.summaries();
    expect(m.unmatched).toBe(1);
    expect(m.requests.map((x) => x.route).sort()).toEqual([UNMATCHED, '/api/orders/:id/lines', '/files/*'].sort());
  });

  it('uses the route pattern an Express-style router gives', async () => {
    const f = started();
    const mw = f.middleware();
    const base = await serve((req: any, res) =>
      mw(req, res, () => {
        req.route = { path: '/invoices/:id' };
        res.end();
      }),
    );
    await fetch(`${base}/invoices/INV-77?draft=1`);
    await settle();
    expect(f.recorder()!.requests()[0].route).toBe('/invoices/:id');
  });

  it('keeps an error as a short code, never its message', async () => {
    expect(errorCode(Object.assign(new Error('card 4111 declined'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(errorCode(new TypeError('token abc is bad'))).toBe('TypeError');
    expect(errorCode(new Error('password=hunter2'))).toBe('Error');
    expect(errorCode({ code: 'lowercase secret', name: 'my secret' })).toBe('error');
    expect(errorCode(new Error('x', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))).toBe('UND_ERR_CONNECT_TIMEOUT');

    const port = await closedPort();
    const f = started();
    const base = await serve(
      f.wrapHandler(async (_q: IncomingMessage, res: ServerResponse) => {
        await fetch(`http://127.0.0.1:${port}/x`).catch(() => {});
        await f.span('db.lookup', async () => Promise.reject(new RangeError('row 99 for alice@example.com'))).catch(() => {});
        res.end();
      }),
    );
    await fetch(base);
    await settle();
    const [r] = f.recorder()!.requests();
    expect(r.upstream[0]).toMatchObject({ host: '127.0.0.1', status: 0 });
    expect(r.upstream[0].error).toMatch(/^[A-Z][A-Za-z0-9_]*$|^error$/);
    expect(r.spans[0]).toMatchObject({ name: 'db.lookup', error: 'RangeError' });
  });

  it('lets no secret from a header, path, query string, body or error message into what it emits', async () => {
    const S = {
      header: 'hdrSecretValue-9f8e7d',
      path: 'pathsecretvalue',
      query: 'querySecretValue-1a2b3c',
      body: 'bodySecretValue-4d5e6f',
      error: 'errorSecretValue-7a8b9c',
    };
    const upstream = await serve((req, res) => {
      req.resume();
      res.end(S.body);
    });
    const port = await closedPort();
    const f = started({ routes: ['/reset/:token'] });
    const base = await serve(
      f.wrapHandler(async (req: IncomingMessage, res: ServerResponse) => {
        for await (const _ of req);
        // Upstream calls carrying the same secrets, through fetch and node:http, and two that fail.
        await fetch(`${upstream}/${S.path}?key=${S.query}`, { method: 'POST', headers: { authorization: S.header }, body: S.body });
        await httpGet(`${upstream}/${S.path}?q=${S.query}`, { 'x-api-key': S.header });
        await fetch(`http://127.0.0.1:${port}/${S.path}?q=${S.query}`).catch(() => {});
        await httpGet(`http://127.0.0.1:${port}/${S.path}?q=${S.query}`).catch(() => {});
        try {
          // A span name is the app's own code, like a step name (design section 7 leaves those to the app).
          f.span('db.reset', () => {
            throw new Error(S.error);
          });
        } catch {}
        res.statusCode = 500;
        res.end(S.error);
      }),
    );
    const send = (path: string) => fetch(`${base}${path}?token=${S.query}&q=${S.query}`, { method: 'POST', headers: { authorization: `Bearer ${S.header}`, cookie: `sid=${S.header}` }, body: S.body });
    await send(`/reset/${S.path}`);
    await send(`/unknown/${S.path}`);
    // Outside any request, too.
    await fetch(`${upstream}/${S.path}?q=${S.query}`, { headers: { authorization: S.header } });
    try {
      f.span('top', () => {
        throw Object.assign(new Error(S.error), { code: S.error });
      });
    } catch {}
    await settle();

    const rec = f.recorder()!;
    expect(rec.requests().map((r) => r.route)).toEqual(['/reset/:token', UNMATCHED]);
    expect(rec.requests()[0].upstream).toHaveLength(4);
    const emitted = JSON.stringify([rec.requests(), rec.upstream(), rec.spans(), rec.summaries(), rec.stats(), rec.drain()]);
    for (const [where, secret] of Object.entries(S)) expect(emitted, where).not.toContain(secret);
  });

  /** An Express-style router mounted on `mountPattern`: Express sets `req.baseUrl` to the matched real text. */
  async function mounted(f: ReturnType<typeof createFlight>, mountDepth: number, pattern: string) {
    const mw = f.middleware();
    return serve((req: any, res) =>
      mw(req, res, () => {
        req.baseUrl = req.url.split('?')[0].split('/').slice(0, mountDepth + 1).join('/');
        req.route = { path: pattern };
        res.end();
      }),
    );
  }

  it('never keeps the real text of an Express mount: an undeclared mount becomes (mount)', async () => {
    const secret = 'alice.secret@example.com';
    const f = started();
    const base = await mounted(f, 2, '/orders');
    await fetch(`${base}/u/${secret}/orders?x=1`);
    await settle();
    const rec = f.recorder()!;
    expect(rec.requests().map((r) => r.route)).toEqual(['(mount)/orders']);
    const emitted = JSON.stringify([rec.requests(), rec.upstream(), rec.spans(), rec.summaries(), rec.stats(), rec.drain()]);
    expect(emitted).not.toContain('alice');
    expect(emitted).not.toContain('example.com');
  });

  it('keeps the full pattern when the mount, or the whole route, is declared', async () => {
    const f = started({ mounts: ['/u/:id', '/api'], routes: ['/t/:team/members'] });
    const base = await mounted(f, 2, '/orders/:n');
    await fetch(`${base}/u/bob.secret@example.com/orders/7`);
    await fetch(`${await mounted(f, 2, '/members')}/t/team-secret-9/members`);
    await fetch(`${base}/x/other-secret-8/orders/7`);
    const one = await mounted(f, 1, '/users/:id');
    await fetch(`${one}/api/users/12`);
    await settle();
    const rec = f.recorder()!;
    expect(rec.requests().map((r) => r.route)).toEqual(['/u/:id/orders/:n', '/t/:team/members', '(mount)/orders/:n', '/api/users/:id']);
    const emitted = JSON.stringify([rec.requests(), rec.summaries(), rec.drain()]);
    for (const s of ['bob', 'team-secret-9', 'other-secret-8']) expect(emitted).not.toContain(s);
  });

  it('records calls through node:http and says what this Node version cannot check', async () => {
    const upstream = await serve((_q, res) => {
      res.statusCode = 201;
      res.end();
    });
    const f = started();
    expect(await httpGet(`${upstream}/top-level`)).toBe(201);
    expect(f.recorder()!.upstream()).toMatchObject([{ method: 'GET', host: '127.0.0.1', status: 201 }]);

    expect(notCheckedFacts('18.20.4')[0]).toMatch(/node:http and node:https are not checked/);
    expect(notCheckedFacts('20.18.0')[0]).toMatch(/Failed upstream calls/);
    expect(notCheckedFacts('22.13.1')).toHaveLength(1);
    expect(notCheckedFacts('22.14.0')).toEqual([]);
    expect(notCheckedFacts('23.1.0')).toHaveLength(1);
    expect(notCheckedFacts('24.0.0')).toEqual([]);
    expect(f.notChecked()).toEqual(notCheckedFacts());
  });

  it('completes the request normally when the recorder throws, and counts the error', async () => {
    const f = started({
      onRecord: () => {
        throw new Error('recorder broke');
      },
    });
    const base = await serve(f.wrapHandler((_q: IncomingMessage, res: ServerResponse) => res.end('fine')));
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fine');
    await settle();
    expect(f.recorder()!.stats().errors).toBe(1);

    // A request object that throws when read: the hook passes through and counts it.
    const bad = {
      get method(): string {
        throw new Error('boom');
      },
    };
    let nextCalls = 0;
    f.middleware()(bad, { once() {} }, () => nextCalls++);
    expect(nextCalls).toBe(1);
    expect(f.recorder()!.stats().errors).toBe(2);
  });

  it('keeps its buffer bounded and counts what it dropped', async () => {
    const f = started({ bufferSize: 10 });
    const base = await serve(f.wrapHandler((_q: IncomingMessage, res: ServerResponse) => res.end()));
    for (let i = 0; i < 13; i++) await fetch(base);
    await settle();
    const rec = f.recorder()!;
    expect(rec.requests()).toHaveLength(10);
    // 3 requests, plus 8 of the test's own 13 top-level fetches (that buffer keeps half as many: 5).
    expect(rec.stats()).toMatchObject({ recorded: 13, dropped: 3 + 8 });
    expect(rec.upstream()).toHaveLength(5);
    expect(rec.summaries()[0].requests[0].count).toBe(13);
    expect(rec.drain().requests).toHaveLength(10);
    expect(rec.requests()).toHaveLength(0);
  });

  it('summarises each minute with counts, status classes and timings', async () => {
    const f = started({ routes: ['/ok', '/fail'] });
    const base = await serve(
      f.wrapHandler((req: IncomingMessage, res: ServerResponse) => {
        res.statusCode = req.url === '/fail' ? 503 : 200;
        res.end();
      }),
    );
    await fetch(`${base}/ok`);
    await fetch(`${base}/ok`);
    await fetch(`${base}/fail`);
    await settle();
    const [m] = f.recorder()!.summaries();
    expect(m.minute % 60000).toBe(0);
    expect(m.runtime?.eventLoop).toBeDefined();
    const ok = m.requests.find((x) => x.route === '/ok')!;
    const fail = m.requests.find((x) => x.route === '/fail')!;
    expect(ok).toMatchObject({ method: 'GET', count: 2, errors: 0, status: { '2xx': 2 } });
    expect(fail).toMatchObject({ count: 1, errors: 1, status: { '5xx': 1 } });
    expect(ok.p95Ms).toBeLessThanOrEqual(ok.maxMs);
    expect(ok.over).toBeUndefined();
  });

  it("counts the requests over flight's own slow-route limit and its error level exactly when they lie between two bucket bounds (M2)", async () => {
    const f = started({ routes: ['/x'], manifest: { schema: 1, service: 'x', processes: [], basics: { slowRouteMs: 30 } } });
    const base = await serve(
      f.wrapHandler(async (_q: IncomingMessage, res: ServerResponse) => {
        await wait(35);
        res.end();
      }),
    );
    await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/x`)));
    await settle();
    const rows = f.recorder()!.summaries().flatMap((m) => m.requests);
    expect(rows.every((x) => Object.keys(x.over || {}).join() === '30,60')).toBe(true);
    expect(rows.reduce((a, x) => a + (x.over?.['30'] || 0), 0)).toBe(10);
    await f.flush();
    await f.checkNow();
    expect(f.findings().find((x) => x.key === 'basic:slow-route:GET /x')).toMatchObject({ state: 'open', count: 10 });
  });

  it('records calls and spans that finish after the response as top-level ones, never into the finished request', async () => {
    const upstream = await serve((_q, res) => res.end('ok'));
    const f = started({ routes: ['/hook'], bufferSize: 10 });
    let late: Promise<unknown> = Promise.resolve();
    const base = await serve(
      f.wrapHandler((_q: IncomingMessage, res: ServerResponse) => {
        res.statusCode = 202;
        res.end();
        // Fire and forget, still inside the request's async context: respond 202, then call the bank.
        late = (async () => {
          await wait(30);
          await fetch(upstream, { method: 'PUT' });
          await httpCall(upstream, 'DELETE');
          f.span('late.work', () => 0);
          for (let i = 0; i < 1000; i++) f.span('late.loop', () => 0);
        })();
      }),
    );
    await fetch(`${base}/hook`);
    await late;
    await settle();
    const rec = f.recorder()!;
    expect(rec.requests()).toMatchObject([{ route: '/hook', status: 202, upstream: [], spans: [] }]);
    expect(rec.upstream().map((u) => u.method)).toEqual(expect.arrayContaining(['PUT', 'DELETE']));
    const rows = rec.summaries().flatMap((m) => m.upstream.map((u) => u.method));
    expect(rows).toEqual(expect.arrayContaining(['PUT', 'DELETE']));
    // 1001 late spans: the top-level buffer keeps 5 and counts the rest; nothing grows in the capture.
    expect(rec.spans()).toHaveLength(5);
    expect(rec.stats()).toMatchObject({ droppedSpans: 1001 - 5, droppedRequests: 0, droppedCalls: 0, dropped: 1001 - 5 });
  });

  it('keeps at most CAPTURE_MAX spans and calls in one request and counts the rest', async () => {
    const upstream = await serve((_q, res) => res.end());
    const f = started();
    const base = await serve(
      f.wrapHandler(async (_q: IncomingMessage, res: ServerResponse) => {
        for (let i = 0; i < CAPTURE_MAX + 50; i++) f.span('s', () => 0);
        for (let i = 0; i < CAPTURE_MAX + 2; i++) await fetch(upstream);
        res.end();
      }),
    );
    await fetch(base);
    await settle();
    const rec = f.recorder()!;
    const [r] = rec.requests();
    expect(r.spans).toHaveLength(CAPTURE_MAX);
    expect(r.upstream).toHaveLength(CAPTURE_MAX);
    expect(rec.stats()).toMatchObject({ droppedSpans: 50, droppedCalls: 2, droppedRequests: 0, dropped: 52 });
  });

  it('never adds a Server-Timing header when only flight records, even where the dev hook asks for one', async () => {
    const f = started();
    const rn = createReinsNode({ NODE_ENV: 'production' });
    expect(await rn.connect({ standalone: true, reconnect: false })).toBe(false);
    const h = (_q: IncomingMessage, res: ServerResponse) => {
      res.setHeader('x-app', '1');
      res.end('ok');
    };
    const mw = rn.middleware({ serverTiming: true });
    const plain = await serve(h);
    const viaWrap = await serve(rn.wrapHandler(h, { serverTiming: true }));
    const viaMiddleware = await serve((q, res) => mw(q, res, () => h(q, res)));
    const keys = async (u: string) => [...(await fetch(u)).headers.keys()].sort();
    const want = await keys(plain);
    expect(want).not.toContain('server-timing');
    expect(await keys(`${viaWrap}/users/alice-SECRETID/reset`)).toEqual(want);
    expect(await keys(`${viaMiddleware}/users/alice-SECRETID/reset`)).toEqual(want);
    await settle();
    expect(f.recorder()!.requests()).toHaveLength(2);
  });

  it('keeps only short, known error codes', () => {
    expect(errorCode({ code: 'AKIAIOSFODNN7EXAMPLE' })).toBe('error');
    expect(errorCode(Object.assign(new Error('x'), { name: 'AKIAIOSFODNN7EXAMPLE' }))).toBe('error');
    expect(errorCode({ code: 'ERR_' + 'A'.repeat(30) })).toBe('ERR_' + 'A'.repeat(30));
    expect(errorCode({ code: 'ERR_' + 'A'.repeat(37) })).toBe('error');
    expect(errorCode({ code: 'EABC123SECRET' })).toBe('error');
    expect(errorCode({ name: 'SessionTokenAbcdefghijklmnopError' })).toBe('error');
    expect(errorCode({ code: 'ECONNREFUSED' })).toBe('ECONNREFUSED');
    expect(errorCode({ code: 'ERR_INVALID_URL' })).toBe('ERR_INVALID_URL');
    expect(errorCode({ name: 'AbortError' })).toBe('AbortError');
    for (const code of ['AKIAIOSFODNN7_EXAMPLE', 'SK_LIVE_4EC39HQLYJWDARJK', 'ESECRETTOKENABCDEFGHIJ', 'ERR_TOKEN_4EC39', 'MY_CODE']) {
      expect(errorCode({ code }), code).toBe('error');
      expect(errorCode({ cause: { code } }), code).toBe('error');
    }
    expect(errorCode({ cause: { code: 'ETIMEDOUT' } })).toBe('ETIMEDOUT');
    expect(errorCode({ code: 'EPROTO', name: 'TypeError' })).toBe('EPROTO');
    expect(errorCode({ name: 'CustomAppError' })).toBe('error');
    expect(errorCode({ name: 'TimeoutError' })).toBe('TimeoutError');
  });

  it('counts a request whose minute is older than every kept minute in the oldest kept one', () => {
    const f = started({ minutes: 2, bufferSize: 100 });
    const hook = f.wrapHandler((_q: unknown, res: EventEmitter) => res.emit('finish'));
    fakeRequest(hook, 10 * 60000 + 5);
    fakeRequest(hook, 11 * 60000 + 5);
    fakeRequest(hook, 5 * 60000 + 5);
    fakeRequest(hook, 3 * 60000 + 5);
    const rec = f.recorder()!;
    const ms = rec.summaries();
    expect(ms.map((m) => m.minute)).toEqual([10 * 60000, 11 * 60000]);
    expect(ms.map((m) => m.requests.reduce((a, x) => a + x.count, 0))).toEqual([3, 1]);
    const { recorded, droppedRequests } = rec.stats();
    expect(recorded).toBe(4);
    expect(droppedRequests).toBe(0);
  });

  it('keeps its buffers as rings, in order, with constant-time pushes', () => {
    let dropped = 0;
    const b = bounded<number>(3, () => dropped++);
    for (let i = 0; i < 7; i++) b.push(i);
    expect(b.list()).toEqual([4, 5, 6]);
    expect(dropped).toBe(4);
    expect(b.drain()).toEqual([4, 5, 6]);
    expect(b.list()).toEqual([]);
    b.push(9);
    expect(b.list()).toEqual([9]);
    const big = bounded<number>(100000, () => {});
    const t0 = performance.now();
    for (let i = 0; i < 400000; i++) big.push(i);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(big.list()[0]).toBe(300000);
  });

  it('evicts the oldest minute, also when the wall clock steps back, and counts dropped requests apart', () => {
    const f = started({ minutes: 2, bufferSize: 10 });
    const hook = f.wrapHandler((_q: unknown, res: EventEmitter) => res.emit('finish'));
    fakeRequest(hook, 10 * 60000 + 5);
    fakeRequest(hook, 11 * 60000 + 5);
    fakeRequest(hook, 5 * 60000 + 5);
    const rec = f.recorder()!;
    expect(rec.summaries().map((m) => m.minute)).toEqual([10 * 60000, 11 * 60000]);
    for (let i = 0; i < 9; i++) fakeRequest(hook, 11 * 60000 + 5);
    expect(rec.stats()).toMatchObject({ recorded: 12, droppedRequests: 2, droppedCalls: 0, droppedSpans: 0, dropped: 2 });
  });

  it('matches route patterns segment by segment', () => {
    const m = routeMatcher(['/', '/a/:id', '/b/*', 'not-a-pattern']);
    expect(m('/')).toBe('/');
    expect(m('/a/1')).toBe('/a/:id');
    expect(m('/a/1/2')).toBeUndefined();
    expect(m('/a/')).toBeUndefined();
    expect(m('/b/x/y')).toBe('/b/*');
    expect(m('not-a-pattern')).toBeUndefined();
  });
});

describe('one set of hooks feeds the development pairing and flight', () => {
  it('feeds both when both are started, through either hook', async () => {
    const rn = createReinsNode({ NODE_ENV: 'development' });
    await rn.connect({ standalone: true, reconnect: false, tokenFile: 'no-such-token-file' });
    stops.push(() => rn.disconnect());
    const f = started({ routes: ['/api/x'] });
    const base = await serve(rn.wrapHandler((_q: IncomingMessage, res: ServerResponse) => rn.span('db.q', () => res.end())));
    await fetch(`${base}/api/x?token=abc`);
    await settle();
    expect(rn.report().requests.map((r) => r.url)).toEqual(['/api/x?token=[redacted]']);
    expect(f.recorder()!.requests()).toMatchObject([{ route: '/api/x', spans: [{ name: 'db.q' }] }]);
  });

  it('feeds flight from the node hook when only flight is started, and the node pairing from the flight hook', async () => {
    const f = started();
    const rn = createReinsNode({ NODE_ENV: 'development' });
    const viaNode = await serve(rn.wrapHandler((_q: IncomingMessage, res: ServerResponse) => res.end()));
    await fetch(viaNode);
    await settle();
    expect(f.recorder()!.requests()).toHaveLength(1);
    expect(rn.report().requests).toHaveLength(0);

    f.stop();
    await rn.connect({ standalone: true, reconnect: false, tokenFile: 'no-such-token-file' });
    stops.push(() => rn.disconnect());
    const viaFlight = await serve(createFlight().wrapHandler((_q: IncomingMessage, res: ServerResponse) => res.end()));
    await fetch(`${viaFlight}/from-flight-hook`);
    await settle();
    expect(rn.report().requests.map((r) => r.route)).toEqual(['/from-flight-hook']);
  });

  it('shows late spans in the development view of their request, bounded by CAPTURE_MAX', async () => {
    const rn = createReinsNode({ NODE_ENV: 'development' });
    await rn.connect({ standalone: true, reconnect: false, tokenFile: 'no-such-token-file' });
    stops.push(() => rn.disconnect());
    let late: Promise<unknown> = Promise.resolve();
    const base = await serve(
      rn.wrapHandler((_q: IncomingMessage, res: ServerResponse) => {
        res.end();
        late = (async () => {
          await wait(30);
          for (let i = 0; i < CAPTURE_MAX * 3; i++) rn.span('late', () => 0);
        })();
      }),
    );
    await fetch(base);
    await late;
    expect(rn.report().requests[0].spans).toHaveLength(CAPTURE_MAX);
  });

  it('leaves late calls to the bridge out of the development view before they use its CAPTURE_MAX slots', async () => {
    const bridge = await serve((_q, res) => res.end());
    const other = await serve((_q, res) => res.end());
    const rn = createReinsNode({ NODE_ENV: 'development' });
    // A socket that cannot open: the bridge address is still set, and standalone records anyway.
    const NoSocket = class {
      constructor() {
        throw new Error('no bridge');
      }
    };
    await rn.connect({ standalone: true, reconnect: false, token: 't', url: bridge.replace(/^http/, 'ws'), WebSocket: NoSocket as any });
    stops.push(() => rn.disconnect());
    let late: Promise<unknown> = Promise.resolve();
    const base = await serve(
      rn.wrapHandler((_q: IncomingMessage, res: ServerResponse) => {
        res.end();
        late = (async () => {
          await wait(30);
          await Promise.all(Array.from({ length: CAPTURE_MAX }, () => fetch(bridge).then((r) => r.text())));
          await fetch(other).then((r) => r.text());
        })();
      }),
    );
    await fetch(base);
    await late;
    await settle();
    expect(rn.report().requests[0].outbound.map((o) => o.url)).toEqual([`${other}/`]);
  });

  it('copies request headers for the development view when the request begins', async () => {
    const rn = createReinsNode({ NODE_ENV: 'development' });
    await rn.connect({ standalone: true, reconnect: false, tokenFile: 'no-such-token-file', allow: { headers: ['x-first', 'x-later'] } });
    stops.push(() => rn.disconnect());
    const base = await serve(
      rn.wrapHandler((q: IncomingMessage, res: ServerResponse) => {
        q.headers['x-first'] = 'changed';
        q.headers['x-later'] = 'added';
        res.end();
      }),
    );
    await fetch(base, { headers: { 'x-first': 'original' } });
    await settle();
    const h = rn.report().requests[0].requestHeaders!;
    expect(h['x-first']).toBe('original');
    expect(h).not.toHaveProperty('x-later');
  });

  it('keeps @mindmakr/reins/node off in production while flight records', async () => {
    const f = started();
    const rn = createReinsNode({ NODE_ENV: 'production' });
    expect(await rn.connect({ standalone: true, reconnect: false })).toBe(false);
    expect(rn.isActive()).toBe(false);
    expect(f.devInstruments()).toEqual({ production: true, devModuleLoaded: true, devRecording: false });
  });
});
