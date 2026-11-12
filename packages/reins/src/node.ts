// @mindmakr/reins/node: dev-only backend instrumentation for Node servers. Node only: never import it from browser code.
// It pairs with the bridge like the browser client does, records inbound requests, spans and outbound fetches,
// and serves them to `reins_server`, `reins_perf` and `reins_report`.
// Like the browser core, it records nothing until the bridge has accepted its token (or `standalone` says otherwise).
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { msg, ring } from './network.js';
import { redactHeaders, redactUrl } from './redact.js';
import { routeStats } from './report.js';
import type { Action, ActionInfo, ServerOutbound, ServerReport, ServerRequest, ServerRuntime, ServerSpan } from './types.js';

export const VERSION = '0.1.0';
/** The header the browser core adds to same-origin calls while paired. */
export const TRACE_HEADER = 'x-reins-trace';

const NAME = /^[\w][\w.-]{0,63}$/;
const TRACE = /^[\w-]{1,64}$/;
const CHANNELS = ['undici:request:create', 'undici:request:headers', 'undici:request:error'] as const;
const r1 = (n: number) => Math.round(n * 10) / 10;
const fail = (s: string): never => {
  throw new Error('reins: ' + s);
};

export interface NodeConnectOptions {
  /** Bridge WebSocket URL. Default `ws://127.0.0.1:7357`. */
  url?: string;
  /** Pairing token. Default: read from `tokenFile`. */
  token?: string;
  /** Default `<cwd>/.reins/token`, which the bridge writes. Read again before each attempt, because the bridge renews it. */
  tokenFile?: string;
  /** Extra facts for the handshake, such as `{ name: 'api' }`. `platform` is always `node`. */
  meta?: Record<string, string>;
  /** Retry when the bridge is not there or goes away. Default true. */
  reconnect?: boolean;
  /** Query keys and headers shown as they are; everything sensitive is redacted. */
  allow?: { queryKeys?: string[]; headers?: string[] };
  /** Requests kept. Default 200. */
  bufferSize?: number;
  /**
   * Record without a bridge, from the moment `connect()` is called. For tests and scripts that read `report()`
   * themselves. Default false: nothing is recorded until the bridge pairs, and recording stops when it goes away.
   */
  standalone?: boolean;
  /** For tests. Default: the global WebSocket (Node 22+), else the `ws` package. */
  WebSocket?: new (url: string) => any;
}

export interface MiddlewareOptions {
  /**
   * Add a `Server-Timing` header (total, `db.*` time and event-loop p99, plus the route) to each response,
   * so a dev HUD can show server time without extra requests. Dev only, numbers and the route only. Default false.
   */
  serverTiming?: boolean;
}

/** Whether this process may run reins: not in production unless REINS_ENABLE=1 (private staging only). */
export function nodeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production' || /^(1|true)$/.test(env.REINS_ENABLE || '');
}

type Rec = ServerRequest & { done?: boolean };

/** Creates an instance. Most apps use the `reinsNode` singleton. */
export function createReinsNode(env: Record<string, string | undefined> = process.env) {
  const als = new AsyncLocalStorage<Rec>();
  const actions = new Map<string, Action>();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const pending = new WeakMap<object, { e: ServerOutbound; rec?: Rec; t0: number }>();
  let opts: NodeConnectOptions = {};
  let requests = ring<Rec>(200);
  let spans = ring<ServerSpan>(100);
  let outbound = ring<ServerOutbound>(100);
  /** `connect()` was called and `disconnect()` was not: keep trying to pair. */
  let wanted = false;
  /** Recording: the middleware, spans, the outbound hooks and the event-loop monitor are on. */
  let active = false;
  let paired = false;
  let sock: any = null;
  let retry: NodeJS.Timeout | null = null;
  let delay = 2000;
  let bridgeHttp = '';
  const subs: Array<() => void> = [];

  const now = () => performance.now();
  const allow = () => opts.allow || {};

  // ---- inbound requests -------------------------------------------------------------------------

  function begin(req: any): Rec {
    const url = String(req.originalUrl || req.url || '/');
    const t = req.headers?.[TRACE_HEADER];
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers || {})) if (typeof v === 'string') headers[k] = v;
    return {
      method: String(req.method || 'GET').toUpperCase(),
      route: url.split(/[?#]/)[0],
      url: redactUrl(url, allow().queryKeys),
      status: 0,
      ms: 0,
      startMs: Math.round(now()),
      at: Date.now(),
      traceId: typeof t === 'string' && TRACE.test(t) ? t : undefined,
      dbMs: 0,
      spans: [],
      outbound: [],
      requestHeaders: redactHeaders(headers, allow().headers),
    };
  }

  const dbMs = (rec: Rec) => r1(rec.spans.filter((s) => s.name.startsWith('db.')).reduce((a, s) => a + s.ms, 0));

  function end(rec: Rec, status: number, route?: unknown) {
    if (rec.done) return;
    rec.done = true;
    rec.status = status;
    rec.ms = Math.round(now() - rec.startMs);
    if (typeof route === 'string' && route) rec.route = route;
    rec.dbMs = dbMs(rec);
    requests.push(rec);
  }

  const expressRoute = (req: any) => (req.route && typeof req.route.path === 'string' ? (req.baseUrl || '') + req.route.path : undefined);

  function timing(rec: Rec): string {
    const el = runtime().eventLoop.p99Ms;
    const desc = `${rec.method} ${rec.route}`.replace(/["\\\r\n]/g, '');
    return `app;dur=${Math.round(now() - rec.startMs)};desc="${desc}", db;dur=${dbMs(rec)}, el-p99;dur=${el}`;
  }

  function track(rec: Rec, req: any, res: any, o: MiddlewareOptions) {
    const fin = () => end(rec, res.statusCode, expressRoute(req));
    res.once?.('finish', fin);
    res.once?.('close', fin);
    if (o.serverTiming && typeof res.writeHead === 'function') {
      const writeHead = res.writeHead;
      res.writeHead = function (...args: any[]) {
        try {
          if (!res.headersSent) res.setHeader('Server-Timing', timing(rec));
        } catch {}
        return writeHead.apply(this, args);
      };
    }
  }

  /**
   * Express/Connect middleware. Register it early, but after body parsers if you want spans in
   * handlers of POST routes to attach (stream callbacks lose the async context).
   */
  function middleware(o: MiddlewareOptions = {}) {
    return (req: any, res: any, next: (err?: unknown) => void) => {
      if (!active) return next();
      const rec = begin(req);
      track(rec, req, res, o);
      als.run(rec, () => next());
    };
  }

  /** Wraps a plain `http.createServer` handler (or any `(req, res)` handler). */
  function wrapHandler<H extends (req: any, res: any, ...rest: any[]) => any>(handler: H, o: MiddlewareOptions = {}): H {
    return function (this: unknown, req: any, res: any, ...rest: any[]) {
      if (!active) return handler.call(this, req, res, ...rest);
      const rec = begin(req);
      track(rec, req, res, o);
      return als.run(rec, () => handler.call(this, req, res, ...rest));
    } as H;
  }

  /** Fastify hooks: `reinsNode.fastify(app)`. Spans attach in handlers of routes without a body. */
  function fastify(app: { addHook(name: string, fn: (...a: any[]) => void): unknown }) {
    const KEY = Symbol.for('reins.rec');
    app.addHook('onRequest', (req: any, _reply: any, done: () => void) => {
      if (!active) return done();
      const rec = begin(req.raw || req);
      req[KEY] = rec;
      als.run(rec, done);
    });
    app.addHook('onResponse', (req: any, reply: any, done: () => void) => {
      const rec: Rec | undefined = req[KEY];
      if (rec) end(rec, reply.statusCode, req.routeOptions?.url || req.routerPath);
      done();
    });
    return app;
  }

  // ---- spans and outbound calls ---------------------------------------------------------------

  /** Times `fn` (sync or async) as a span of the current request, or at top level outside one. */
  function span<T>(name: string, fn: () => T): T {
    if (!active) return fn();
    const rec = als.getStore();
    const t0 = now();
    const done = (error?: string) => {
      const s: ServerSpan = { name: String(name).slice(0, 80), startMs: r1(t0 - (rec ? rec.startMs : 0)), ms: r1(now() - t0), error };
      rec ? rec.spans.push(s) : spans.push(s);
    };
    try {
      const v: any = fn();
      if (v && typeof v.then === 'function')
        return v.then(
          (x: unknown) => (done(), x),
          (e: unknown) => (done(msg(e)), Promise.reject(e)),
        );
      done();
      return v;
    } catch (e) {
      done(msg(e));
      throw e;
    }
  }

  function subscribe() {
    const finish = (request: object, status: number, error?: string) => {
      const p = pending.get(request);
      if (!p) return;
      pending.delete(request);
      p.e.status = status;
      p.e.ms = r1(now() - p.t0);
      if (error) p.e.error = error;
      p.rec ? p.rec.outbound.push(p.e) : outbound.push(p.e);
    };
    const handlers: Record<(typeof CHANNELS)[number], (m: any) => void> = {
      'undici:request:create': ({ request }) => {
        if (!active || !request) return;
        const origin = String(request.origin || '');
        if (bridgeHttp && origin === bridgeHttp) return;
        const rec = als.getStore();
        const t0 = now();
        pending.set(request, { e: { method: String(request.method || 'GET'), url: redactUrl(origin + (request.path || ''), allow().queryKeys), status: 0, startMs: r1(t0 - (rec ? rec.startMs : 0)), ms: 0 }, rec, t0 });
      },
      'undici:request:headers': ({ request, response }) => finish(request, response?.statusCode || 0),
      'undici:request:error': ({ request, error }) => finish(request, 0, msg(error)),
    };
    for (const name of CHANNELS) {
      const ch = channel(name);
      const fn = (m: unknown) => {
        try {
          handlers[name](m);
        } catch {}
      };
      ch.subscribe(fn);
      subs.push(() => ch.unsubscribe(fn));
    }
  }

  // ---- runtime and report ---------------------------------------------------------------------

  function runtime(): ServerRuntime {
    const m = process.memoryUsage();
    const pct = (p: number) => {
      try {
        return r1(loop.percentile(p) / 1e6);
      } catch {
        return 0;
      }
    };
    return {
      node: process.version,
      pid: process.pid,
      uptimeS: Math.round(process.uptime()),
      rssMb: r1(m.rss / 1048576),
      heapUsedMb: r1(m.heapUsed / 1048576),
      eventLoop: { p50Ms: pct(50), p99Ms: pct(99), maxMs: r1((loop.max || 0) / 1e6) },
    };
  }

  /** The same data `reins_server` returns, for this process. */
  function report(): ServerReport {
    const reqs = requests.list().map(({ done, ...r }) => ({ ...r, dbMs: dbMs(r as Rec) }));
    return { runtime: active ? runtime() : null, requests: reqs, slowest: routeStats(reqs), spans: spans.list(), outbound: outbound.list(), actions: list() };
  }

  // ---- server actions -------------------------------------------------------------------------

  /** Registers a server action. Same rules as in the browser: consequential ones need `confirm: true`. Never register one that skips auth. */
  function action<I = any, O = any>(def: Action<I, O>): () => void {
    if (!NAME.test(def?.name)) fail('bad action name');
    if (typeof def.run !== 'function') fail('no run function');
    actions.set(def.name, def);
    return () => void (actions.get(def.name) === def && actions.delete(def.name));
  }

  const list = (): ActionInfo[] =>
    [...actions.values()].map(({ name, description, input = { type: 'object', properties: {} }, consequential, readOnly }) => ({
      name,
      description,
      input,
      consequential: !!consequential,
      readOnly: !!readOnly,
    }));

  async function run(name: string, input?: unknown, confirm = false): Promise<unknown> {
    const a = actions.get(name) || fail('unknown action');
    if (a.consequential && !confirm) fail('confirm: true required');
    return a.run(input ?? {});
  }

  const methods: Record<string, (p: any) => unknown> = {
    list: () => ({ actions: list(), states: [], panels: [] }),
    run: (p) => run(p.name, p.input, p.confirm === true),
    server: () => report(),
  };

  // ---- recording on and off -------------------------------------------------------------------

  function start() {
    if (active) return;
    active = true;
    loop.enable();
    subscribe();
  }

  function stop() {
    if (!active) return;
    active = false;
    loop.disable();
    subs.splice(0).forEach((f) => f());
  }

  // ---- pairing --------------------------------------------------------------------------------

  async function open(): Promise<boolean> {
    let token = opts.token;
    if (!token)
      try {
        token = readFileSync(opts.tokenFile || join(process.cwd(), '.reins', 'token'), 'utf8').trim();
      } catch {}
    if (!token) return schedule(), false;
    const url = opts.url || 'ws://127.0.0.1:7357';
    bridgeHttp = url.replace(/^ws/, 'http').replace(/\/+$/, '');
    const WS = opts.WebSocket || (globalThis as any).WebSocket || (await import('ws')).default;
    return new Promise((resolve) => {
      let done = false;
      let s: any;
      try {
        s = new WS(url);
      } catch {
        return resolve(false), schedule();
      }
      const send = (m: unknown) => s.send(JSON.stringify(m));
      s.onopen = () =>
        send({ type: 'hello', token, version: VERSION, url: `node://${process.pid}`, title: opts.meta?.name || 'node server', meta: { ...opts.meta, platform: 'node', runtime: process.version } });
      s.onerror = () => {};
      s.onmessage = async (ev: { data: unknown }) => {
        let m: any;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        // An unhandled rejection here would end the dev server, so ignore anything that is not a message object.
        if (!m || typeof m !== 'object') return;
        if (!done) {
          done = true;
          if (m.type === 'welcome') {
            sock = s;
            paired = true;
            delay = 2000;
            start();
            return resolve(true);
          }
          s.close();
          return resolve(false);
        }
        if (m.type !== 'call') return;
        try {
          const fn = methods[m.method] || fail('bad method');
          send({ type: 'result', id: m.id, ok: true, result: (await fn(m.params || {})) ?? null });
        } catch (e) {
          send({ type: 'result', id: m.id, ok: false, error: msg(e) });
        }
      };
      s.onclose = () => {
        if (!done) {
          done = true;
          resolve(false);
        }
        if (sock === s || !paired) {
          sock = null;
          paired = false;
          // No bridge, nothing to record for (unless the app asked to record on its own).
          if (!opts.standalone) stop();
          schedule();
        }
      };
    });
  }

  function schedule() {
    if (!wanted || opts.reconnect === false || retry) return;
    retry = setTimeout(() => {
      retry = null;
      void open();
    }, delay);
    retry.unref?.();
    delay = Math.min(delay * 2, 30000);
  }

  /**
   * Pairs this server with the bridge. Recording starts once the bridge accepts the token and stops when
   * it goes away (`standalone: true` records from this call instead). Dev only: refuses when NODE_ENV is
   * `production` unless REINS_ENABLE=1. Resolves true once paired.
   */
  function connect(o: NodeConnectOptions = {}): Promise<boolean> {
    if (!nodeEnabled(env)) return Promise.resolve(false);
    if (!wanted) {
      opts = o;
      const n = o.bufferSize || 200;
      requests = ring(n);
      spans = ring(Math.ceil(n / 2));
      outbound = ring(Math.ceil(n / 2));
      wanted = true;
      if (o.standalone) start();
    }
    return paired ? Promise.resolve(true) : open();
  }

  function disconnect() {
    wanted = false;
    paired = false;
    if (retry) clearTimeout(retry);
    retry = null;
    const s = sock;
    sock = null;
    s?.close();
    stop();
  }

  function clear() {
    const n = opts.bufferSize || 200;
    requests = ring(n);
    spans = ring(Math.ceil(n / 2));
    outbound = ring(Math.ceil(n / 2));
  }

  return {
    connect,
    disconnect,
    clear,
    isPaired: () => paired,
    isActive: () => active,
    middleware,
    wrapHandler,
    fastify,
    span,
    action,
    actions: list,
    run,
    report,
  };
}

export type ReinsNode = ReturnType<typeof createReinsNode>;

export const reinsNode = createReinsNode();
export default reinsNode;
