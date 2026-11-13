// The shared recorder in strict mode (flight), and the hooks it shares with @mindmakr/reins/node.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFlight } from '../src/flight.js';
import { createReinsNode } from '../src/node.js';
import { errorCode, notCheckedFacts, routeMatcher, UNMATCHED } from '../src/recorder.js';

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

const settle = () => new Promise((r) => setTimeout(r, 20));

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
    expect(errorCode(new Error('password=hunter2'))).toBe('error');
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

  it('keeps @mindmakr/reins/node off in production while flight records', async () => {
    const f = started();
    const rn = createReinsNode({ NODE_ENV: 'production' });
    expect(await rn.connect({ standalone: true, reconnect: false })).toBe(false);
    expect(rn.isActive()).toBe(false);
    expect(f.devInstruments()).toEqual({ production: true, devModuleLoaded: true, devRecording: false });
  });
});
