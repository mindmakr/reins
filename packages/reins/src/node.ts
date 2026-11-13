// @mindmakr/reins/node: dev-only backend instrumentation for Node servers. Node only: never import it from browser code.
// It pairs with the bridge like the browser client does, records inbound requests, spans and outbound fetches,
// and serves them to `reins_server`, `reins_perf` and `reins_report`.
// Like the browser core, it records nothing until the bridge has accepted its token (or `standalone` says otherwise).
// The hooks, spans, upstream calls and runtime figures come from the shared recorder (./recorder.ts), which
// @mindmakr/reins/flight also uses: an app installs the hooks once and they feed whichever is started.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { msg, ring } from './network.js';
import { redactHeaders, redactUrl } from './redact.js';
import {
  attach,
  type Capture,
  type Consumer,
  createLoop,
  fastify as hookFastify,
  markDevModule,
  middleware as hookMiddleware,
  r1,
  type RawCall,
  type RawSpan,
  runtimeOf,
  span as hookSpan,
  wrapHandler as hookWrapHandler,
} from './recorder.js';
import { routeStats } from './report.js';
import type { Action, ActionInfo, ServerOutbound, ServerReport, ServerRequest, ServerSpan } from './types.js';

export const VERSION = '0.1.0';
/** The header the browser core adds to same-origin calls while paired. */
export const TRACE_HEADER = 'x-reins-trace';

// Lets flight state that the development module is loaded in this process (design C12).
markDevModule();

const NAME = /^[\w][\w.-]{0,63}$/;
const TRACE = /^[\w-]{1,64}$/;
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

/** Creates an instance. Most apps use the `reinsNode` singleton. */
export function createReinsNode(env: Record<string, string | undefined> = process.env) {
  const actions = new Map<string, Action>();
  const loop = createLoop();
  let opts: NodeConnectOptions = {};
  /** Finished requests as captured; the redacted view is made when they are read. */
  let requests = ring<Capture>(200);
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
  let detach: (() => void) | null = null;

  const now = () => performance.now();
  const allow = () => opts.allow || {};
  const toBridge = (k: RawCall) => !!bridgeHttp && k.origin === bridgeHttp;

  // ---- the development view of what the shared recorder captures ----------------------------------

  const devSpan = (s: RawSpan): ServerSpan => ({ name: s.name, startMs: s.startMs, ms: s.ms, error: s.failed ? msg(s.error) : undefined });

  function devCall(k: RawCall): ServerOutbound {
    const e: ServerOutbound = { method: k.method, url: redactUrl(k.origin + k.path, allow().queryKeys), status: k.status, startMs: k.startMs, ms: k.ms };
    if (k.failed) e.error = msg(k.error);
    return e;
  }

  const dbMs = (spans: Array<{ name: string; ms: number }>) => r1(spans.filter((s) => s.name.startsWith('db.')).reduce((a, s) => a + s.ms, 0));

  /** Made when read, so spans and calls that finish after the response still show, as before. */
  function devRequest(c: Capture): ServerRequest {
    const h: any = c.headers || {};
    const t = h[TRACE_HEADER];
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) if (typeof v === 'string') headers[k] = v;
    const spanList = c.spans.map(devSpan);
    return {
      method: c.method,
      route: c.route || c.url.split(/[?#]/)[0],
      url: redactUrl(c.url, allow().queryKeys),
      status: c.status,
      ms: c.ms,
      startMs: c.startMs,
      at: c.at,
      traceId: typeof t === 'string' && TRACE.test(t) ? t : undefined,
      dbMs: dbMs(spanList),
      spans: spanList,
      outbound: c.calls.filter((k) => !toBridge(k)).map(devCall),
      requestHeaders: redactHeaders(headers, allow().headers),
    };
  }

  const dev: Consumer = {
    kind: 'dev',
    request: (c) => requests.push(c),
    span: (s) => spans.push(devSpan(s)),
    call: (k) => void (!toBridge(k) && outbound.push(devCall(k))),
    fault: () => {},
  };

  function timing(c: Capture): string {
    const el = runtimeOf(loop).eventLoop.p99Ms;
    const desc = `${c.method} ${c.route || c.url.split(/[?#]/)[0]}`.replace(/["\\\r\n]/g, '');
    return `app;dur=${Math.round(now() - c.startMs)};desc="${desc}", db;dur=${dbMs(c.spans)}, el-p99;dur=${el}`;
  }

  const hookOptions = (o: MiddlewareOptions) => (o.serverTiming ? { timing } : {});

  // ---- the shared hooks: installed once, they feed this instance and flight, whichever is started ----

  /**
   * Express/Connect middleware. Register it early, but after body parsers if you want spans in
   * handlers of POST routes to attach (stream callbacks lose the async context).
   */
  const middleware = (o: MiddlewareOptions = {}) => hookMiddleware(hookOptions(o));

  /** Wraps a plain `http.createServer` handler (or any `(req, res)` handler). */
  const wrapHandler = <H extends (req: any, res: any, ...rest: any[]) => any>(handler: H, o: MiddlewareOptions = {}): H => hookWrapHandler(handler, hookOptions(o));

  /** Fastify hooks: `reinsNode.fastify(app)`. Spans attach in handlers of routes without a body. */
  const fastify = <A extends { addHook(name: string, fn: (...a: any[]) => void): unknown }>(app: A): A => hookFastify(app);

  /** Times `fn` (sync or async) as a span of the current request, or at top level outside one. */
  const span = <T>(name: string, fn: () => T): T => hookSpan(name, fn);

  // ---- report ---------------------------------------------------------------------------------

  /** The same data `reins_server` returns, for this process. */
  function report(): ServerReport {
    const reqs = requests.list().map(devRequest);
    return { runtime: active ? runtimeOf(loop) : null, requests: reqs, slowest: routeStats(reqs), spans: spans.list(), outbound: outbound.list(), actions: list() };
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
    detach = attach(dev);
  }

  function stop() {
    if (!active) return;
    active = false;
    loop.disable();
    detach?.();
    detach = null;
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
