// The recorder shared by @mindmakr/reins/node (development) and @mindmakr/reins/flight (production).
// It owns the framework hooks (Express/Connect middleware, Fastify hooks, a wrapped handler), spans,
// the upstream-call channels (fetch through undici, node:http and node:https) and the runtime figures.
// An app installs the hooks once; each capture feeds every recorder that is started (design C13).
//
// Node built-ins only. Importing this module does nothing: the hooks pass straight through until a
// recorder attaches, and the channel subscriptions live only while at least one recorder is attached.
// What a recorder keeps is its own business: the development view in node.ts redacts and keeps more,
// the strict recorder below keeps method, route pattern, host, status, timing and error codes only (C16).
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';
import type { ServerRuntime } from './types.js';

/** One inbound request while it is handled. Internal: it holds raw values and is never emitted as it is. */
export interface Capture {
  method: string;
  /** Raw URL, query string included. Only a recorder's view decides what of it is kept. */
  url: string;
  /** Route pattern from the framework, when it gives one. For Express it is `mount + pattern`, so it can hold real path text. */
  route?: string;
  /** Express only: the route's own pattern (`req.route.path`), without the mount. */
  pattern?: string;
  /** Express only: the matched mount (`req.baseUrl`). Real path text, not a pattern: strict mode never keeps it as it is. */
  mount?: string;
  /** The request's header object, by reference. */
  headers: unknown;
  status: number;
  ms: number;
  startMs: number;
  at: number;
  done: boolean;
  /** The connection closed before the response finished. */
  aborted: boolean;
  spans: RawSpan[];
  calls: RawCall[];
}

export interface RawSpan {
  name: string;
  startMs: number;
  ms: number;
  failed: boolean;
  error?: unknown;
}

export interface RawCall {
  via: 'fetch' | 'http';
  method: string;
  /** `protocol//host[:port]`. */
  origin: string;
  /** Path with query string, raw. */
  path: string;
  status: number;
  startMs: number;
  ms: number;
  failed: boolean;
  error?: unknown;
}

/** A started recorder. The hub calls it for every finished request, top-level span and top-level call. */
export interface Consumer {
  kind: 'dev' | 'strict';
  request(c: Capture): void;
  span(s: RawSpan): void;
  call(c: RawCall): void;
  /** Counts an error of the recorder or of the hooks. Must not throw. */
  fault(): void;
}

export interface HookOptions {
  /** Development only: the value of a `Server-Timing` header to add to the response. */
  timing?: (c: Capture) => string;
}

export const r1 = (n: number) => Math.round(n * 10) / 10;
const now = () => performance.now();

// ---- the hub: one per module instance -------------------------------------------------------------

const consumers = new Set<Consumer>();
let als: AsyncLocalStorage<Capture> | null = null;
const pending = new WeakMap<object, { e: RawCall; cap?: Capture; t0: number }>();
const subs: Array<() => void> = [];
let devModule = false;

function fault() {
  for (const k of consumers)
    try {
      k.fault();
    } catch {}
}

function deliver(fn: (k: Consumer) => void) {
  for (const k of consumers)
    try {
      fn(k);
    } catch {
      try {
        k.fault();
      } catch {}
    }
}

/** Starts feeding `c`. Returns the function that stops it. The first attach subscribes to the channels. */
export function attach(c: Consumer): () => void {
  if (!consumers.size) {
    als = als || new AsyncLocalStorage<Capture>();
    subscribe();
  }
  consumers.add(c);
  return () => {
    if (consumers.delete(c) && !consumers.size) subs.splice(0).forEach((f) => f());
  };
}

/** Called by `@mindmakr/reins/node` when it loads, so flight can say so (design C12). */
export function markDevModule(): void {
  devModule = true;
}

/** What flight states about the development instruments in this process. */
export interface DevInstruments {
  /** NODE_ENV is `production`. */
  production: boolean;
  /** `@mindmakr/reins/node` has been loaded in this process. */
  devModuleLoaded: boolean;
  /** A development recorder is recording right now. */
  devRecording: boolean;
}

export function devInstruments(env: Record<string, string | undefined> = process.env): DevInstruments {
  return { production: env.NODE_ENV === 'production', devModuleLoaded: devModule, devRecording: [...consumers].some((k) => k.kind === 'dev') };
}

// ---- inbound requests -------------------------------------------------------------------------------

function begin(req: any): Capture {
  return {
    method: String(req.method || 'GET').toUpperCase(),
    url: String(req.originalUrl || req.url || '/'),
    headers: req.headers,
    status: 0,
    ms: 0,
    startMs: Math.round(now()),
    at: Date.now(),
    done: false,
    aborted: false,
    spans: [],
    calls: [],
  };
}

function end(c: Capture, status: unknown, route?: unknown, aborted = false) {
  if (c.done) return;
  c.done = true;
  c.status = Number(status) || 0;
  c.ms = Math.round(now() - c.startMs);
  c.aborted = aborted;
  if (typeof route === 'string' && route) c.route = route;
  deliver((k) => k.request(c));
}

/** Express: keeps the mount (`req.baseUrl`, real text) apart from the route pattern, and returns the joined route. */
function expressRoute(c: Capture, req: any): string | undefined {
  if (!req.route || typeof req.route.path !== 'string') return;
  const mount = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  if (!c.done) {
    c.pattern = req.route.path;
    c.mount = mount;
  }
  return mount + req.route.path;
}

function track(c: Capture, req: any, res: any, o: HookOptions) {
  const fin = (closed: boolean) => () => {
    try {
      end(c, res.statusCode, expressRoute(c, req), closed && res.writableFinished === false);
    } catch {
      fault();
    }
  };
  res.once?.('finish', fin(false));
  res.once?.('close', fin(true));
  const timing = o.timing;
  if (timing && typeof res.writeHead === 'function') {
    const writeHead = res.writeHead;
    res.writeHead = function (...args: any[]) {
      try {
        if (!res.headersSent) res.setHeader('Server-Timing', timing(c));
      } catch {}
      return writeHead.apply(this, args);
    };
  }
}

/** Starts a capture for `req`, or returns undefined when nothing is started or the hook itself fails. */
function open(req: any, res: any, o: HookOptions): Capture | undefined {
  if (!consumers.size || !als) return;
  try {
    const c = begin(req);
    track(c, req, res, o);
    return c;
  } catch {
    fault();
  }
}

/**
 * Express/Connect middleware. Register it early, but after body parsers if you want spans in
 * handlers of POST routes to attach (stream callbacks lose the async context).
 */
export function middleware(o: HookOptions = {}) {
  return (req: any, res: any, next: (err?: unknown) => void) => {
    const c = open(req, res, o);
    if (!c) return next();
    als!.run(c, () => next());
  };
}

/** Wraps a plain `http.createServer` handler (or any `(req, res)` handler). */
export function wrapHandler<H extends (req: any, res: any, ...rest: any[]) => any>(handler: H, o: HookOptions = {}): H {
  return function (this: unknown, req: any, res: any, ...rest: any[]) {
    const c = open(req, res, o);
    if (!c) return handler.call(this, req, res, ...rest);
    return als!.run(c, () => handler.call(this, req, res, ...rest));
  } as H;
}

/** Fastify hooks. Spans attach in handlers of routes without a body. */
export function fastify<A extends { addHook(name: string, fn: (...a: any[]) => void): unknown }>(app: A): A {
  const KEY = Symbol.for('reins.rec');
  app.addHook('onRequest', (req: any, _reply: any, done: () => void) => {
    if (!consumers.size || !als) return done();
    let c: Capture;
    try {
      c = begin(req.raw || req);
      req[KEY] = c;
    } catch {
      fault();
      return done();
    }
    als.run(c, done);
  });
  app.addHook('onResponse', (req: any, reply: any, done: () => void) => {
    try {
      const c: Capture | undefined = req[KEY];
      if (c) end(c, reply.statusCode, req.routeOptions?.url || req.routerPath);
    } catch {
      fault();
    }
    done();
  });
  return app;
}

// ---- spans and upstream calls -------------------------------------------------------------------------

/** Times `fn` (sync or async) as a span of the current request, or at top level outside one. */
export function span<T>(name: string, fn: () => T): T {
  if (!consumers.size) return fn();
  const cap = als?.getStore();
  const t0 = now();
  const done = (failed: boolean, error?: unknown) => {
    try {
      const s: RawSpan = { name: String(name).slice(0, 80), startMs: r1(t0 - (cap ? cap.startMs : 0)), ms: r1(now() - t0), failed, error };
      cap ? cap.spans.push(s) : deliver((k) => k.span(s));
    } catch {
      fault();
    }
  };
  try {
    const v: any = fn();
    if (v && typeof v.then === 'function')
      return v.then(
        (x: unknown) => (done(false), x),
        (e: unknown) => (done(true, e), Promise.reject(e)),
      );
    done(false);
    return v;
  } catch (e) {
    done(true, e);
    throw e;
  }
}

function hostHeader(request: any): string {
  const h = typeof request.getHeader === 'function' ? request.getHeader('host') : undefined;
  return typeof h === 'string' && h ? h : String(request.host || '');
}

function subscribe() {
  const start = (request: object, via: RawCall['via'], method: unknown, origin: string, path: unknown) => {
    const cap = als?.getStore();
    const t0 = now();
    pending.set(request, { e: { via, method: String(method || 'GET'), origin, path: String(path || ''), status: 0, startMs: r1(t0 - (cap ? cap.startMs : 0)), ms: 0, failed: false }, cap, t0 });
  };
  const finish = (request: object, status: number, failed = false, error?: unknown) => {
    const p = pending.get(request);
    if (!p) return;
    pending.delete(request);
    p.e.status = status;
    p.e.ms = r1(now() - p.t0);
    if (failed) {
      p.e.failed = true;
      p.e.error = error;
    }
    p.cap ? p.cap.calls.push(p.e) : deliver((k) => k.call(p.e));
  };
  const handlers: Record<string, (m: any) => void> = {
    'undici:request:create': ({ request }) => request && start(request, 'fetch', request.method, String(request.origin || ''), request.path),
    'undici:request:headers': ({ request, response }) => request && finish(request, response?.statusCode || 0),
    'undici:request:error': ({ request, error }) => request && finish(request, 0, true, error),
    'http.client.request.start': ({ request }) => request && start(request, 'http', request.method, `${request.protocol || 'http:'}//${hostHeader(request)}`, request.path),
    'http.client.response.finish': ({ request, response }) => request && finish(request, response?.statusCode || 0),
    'http.client.request.error': ({ request, error }) => request && finish(request, 0, true, error),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    const ch = channel(name);
    const fn = (m: unknown) => {
      try {
        if (consumers.size) handler(m);
      } catch {
        fault();
      }
    };
    ch.subscribe(fn);
    subs.push(() => ch.unsubscribe(fn));
  }
}

/**
 * Facts about upstream calls this Node version cannot show, for every report to carry as "not checked".
 * Calls through node:http and node:https are seen through `http.client.*` diagnostics channels: requests and
 * responses from Node 20, failures from Node 22.14 and 23.2.
 */
export function notCheckedFacts(version: string = process.versions.node): string[] {
  const [a, b] = version.split('.').map(Number);
  if (a < 20) return [`Upstream calls through node:http and node:https are not checked on Node ${version}; Node 20 or newer records them.`];
  if (a > 23 || (a === 23 && b >= 2) || (a === 22 && b >= 14)) return [];
  return [`Failed upstream calls through node:http and node:https are not checked on Node ${version}; only calls that got a response are recorded. Node 22.14, 23.2 or newer records failures.`];
}

// ---- runtime figures ----------------------------------------------------------------------------------

export function createLoop(): IntervalHistogram {
  return monitorEventLoopDelay({ resolution: 10 });
}

export function runtimeOf(loop: IntervalHistogram): ServerRuntime {
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

// ---- the strict recorder (flight) -----------------------------------------------------------------------

/** A request as flight keeps it. No header, path, query string, body or error text. */
export interface StrictRequest {
  at: number;
  method: string;
  /** Route pattern, or `(unmatched)` when neither the framework nor `routes` gives one. */
  route: string;
  status: number;
  ms: number;
  /** `aborted` when the connection closed before the response finished. */
  error?: string;
  dbMs: number;
  spans: StrictSpan[];
  upstream: StrictCall[];
}

export interface StrictSpan {
  at?: number;
  name: string;
  ms: number;
  error?: string;
}

export interface StrictCall {
  at?: number;
  method: string;
  /** Host name only: no port, path or query string. */
  host: string;
  status: number;
  ms: number;
  /** A short code, such as `ECONNREFUSED` or `TypeError`; `error` when there is none. */
  error?: string;
}

export interface Figures {
  count: number;
  /** Status 5xx, status 0 or an error code. */
  errors: number;
  /** Counts by status class: `2xx`, `4xx`, `5xx`, and `0` for no response. */
  status: Record<string, number>;
  avgMs: number;
  /** Upper bound of the latency bucket that holds the 95th percentile (capped at the maximum). */
  p95Ms: number;
  maxMs: number;
}

export interface MinuteSummary {
  /** Wall-clock start of the minute, in ms. */
  minute: number;
  requests: Array<{ method: string; route: string } & Figures>;
  upstream: Array<{ method: string; host: string } & Figures>;
  unmatched: number;
  /** Sampled when the minute closes (live for the current minute). The event-loop histogram is reset then. */
  runtime: ServerRuntime | null;
}

export interface StrictStats {
  /** Requests recorded. */
  recorded: number;
  /** Records pushed out of a full buffer. */
  dropped: number;
  /** Errors of the recorder or the hooks, caught so the request completed normally. */
  errors: number;
  /** Requests with no route pattern. */
  unmatched: number;
  /** Summary rows folded into `(other)` because a minute already had too many distinct keys. */
  overflow: number;
}

export interface StrictOptions {
  /** Route patterns (`/api/users/:id`, `/files/*`) to reduce paths to when the framework gives none. */
  routes?: string[];
  /**
   * Express mount paths (`/api`, `/u/:id`), as given to `app.use(path, router)`. A route under a router is
   * recorded with its mount only when the mount matches one of these; otherwise the mount is recorded as
   * `(mount)`, because Express gives the mount as real path text, not as a pattern.
   */
  mounts?: string[];
  /** Requests kept in memory. Default 1000; top-level spans and calls keep half as many each. */
  bufferSize?: number;
  /** Minutes of summaries kept. Default 60. */
  minutes?: number;
  /** Called with each request record. Errors are counted, never thrown. */
  onRecord?: (r: StrictRequest) => void;
}

export const UNMATCHED = '(unmatched)';
/** Stands in for an Express mount that the app did not declare in `mounts`. */
export const MOUNT = '(mount)';
const OTHER = '(other)';
const MAX_KEYS = 300;
const BOUNDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, Infinity];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,39}$/;
const SPAN_NAME = /^[\w.:-]{1,64}$/;
const HOST = /^(?:[a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$|^\[[0-9a-f:.]{2,45}\]$/;

export const strictMethod = (m: unknown): string => {
  const s = String(m || '').toUpperCase();
  return METHODS.has(s) ? s : 'OTHER';
};

/** A short code for an error: its `code` (or its cause's), else its class name, else `error`. Never its message. */
export function errorCode(e: unknown): string {
  try {
    const o: any = e;
    for (const v of [o?.code, o?.cause?.code]) if (typeof v === 'string' && CODE.test(v)) return v;
    const name = o?.name;
    if (typeof name === 'string' && name !== 'Error' && ERROR_NAME.test(name)) return name;
  } catch {}
  return 'error';
}

export function strictHost(origin: string): string {
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return HOST.test(h) ? h : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Matches a path against the app's route patterns: `:name` takes one segment, a final `*` takes the rest. */
export function routeMatcher(routes: unknown = []): (path: string) => string | undefined {
  const list = (Array.isArray(routes) ? routes : [])
    .filter((r): r is string => typeof r === 'string' && r.startsWith('/') && r.length <= 200)
    .map((r) => ({ pattern: r, parts: trim(r).split('/') }));
  return (path) => {
    const p = trim(path).split('/');
    for (const { pattern, parts } of list) if (fits(parts, p)) return pattern;
  };
}

const trim = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

function fits(parts: string[], p: string[]): boolean {
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '*' && i === parts.length - 1) return true;
    if (i >= p.length) return false;
    if (parts[i].startsWith(':') ? p[i] === '' : parts[i] !== p[i]) return false;
  }
  return parts.length === p.length;
}

function bounded<T>(size: number, dropped: () => void) {
  let a: T[] = [];
  return {
    push(x: T) {
      a.push(x);
      while (a.length > size) a.shift(), dropped();
    },
    list: () => a.slice(),
    drain: () => {
      const r = a;
      a = [];
      return r;
    },
  };
}

const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d);

interface Agg {
  key: Record<string, string>;
  count: number;
  errors: number;
  status: Record<string, number>;
  sum: number;
  max: number;
  buckets: number[];
}

interface Minute {
  minute: number;
  requests: Map<string, Agg>;
  upstream: Map<string, Agg>;
  unmatched: number;
  runtime: ServerRuntime | null;
}

const statusClass = (s: number) => (s >= 100 && s < 600 ? `${Math.floor(s / 100)}xx` : '0');

function figures(a: Agg): Figures {
  let p95 = a.max;
  for (let i = 0, seen = 0; i < BOUNDS.length; i++) {
    seen += a.buckets[i];
    if (seen >= Math.ceil(a.count * 0.95)) {
      p95 = Math.min(BOUNDS[i], a.max);
      break;
    }
  }
  return { count: a.count, errors: a.errors, status: { ...a.status }, avgMs: a.count ? r1(a.sum / a.count) : 0, p95Ms: r1(p95), maxMs: r1(a.max) };
}

/**
 * The strict recorder flight uses (design C16): a request is method, route pattern, status and timing; an
 * upstream call is method, host, status and timing; an error is a short code. Headers, paths, query strings,
 * bodies and error messages never enter a record. Buffers are bounded and what falls out is counted.
 */
export function createStrictRecorder(o: StrictOptions = {}) {
  const size = int(o.bufferSize, 1000, 10, 100000);
  const keep = int(o.minutes, 60, 1, 1440);
  const match = routeMatcher(o.routes);
  const matchMount = routeMatcher(o.mounts);
  const onRecord = typeof o.onRecord === 'function' ? o.onRecord : undefined;
  const loop = createLoop();
  const stats: StrictStats = { recorded: 0, dropped: 0, errors: 0, unmatched: 0, overflow: 0 };
  const drop = () => void stats.dropped++;
  let requests = bounded<StrictRequest>(size, drop);
  let calls = bounded<StrictCall>(Math.ceil(size / 2), drop);
  let spans = bounded<StrictSpan>(Math.ceil(size / 2), drop);
  const minutes = new Map<number, Minute>();
  let detach: (() => void) | null = null;

  const toSpan = (s: RawSpan, at?: number): StrictSpan => ({
    ...(at ? { at } : {}),
    name: SPAN_NAME.test(s.name) ? s.name : 'span',
    ms: s.ms,
    ...(s.failed ? { error: errorCode(s.error) } : {}),
  });

  const toCall = (k: RawCall, at?: number): StrictCall => ({
    ...(at ? { at } : {}),
    method: strictMethod(k.method),
    host: strictHost(k.origin),
    status: k.status,
    ms: k.ms,
    ...(k.failed ? { error: errorCode(k.error) } : {}),
  });

  const clean = (s: string) => s.split(/[?#]/)[0].slice(0, 200);

  // Never keeps real path text: an Express mount (`req.baseUrl`) is kept only when it matches a declared
  // mount pattern (the pattern is kept, not the text); else a declared route for the whole path is used;
  // else the mount becomes `(mount)`. Fastify gives the full pattern (`routeOptions.url`), kept as it is.
  function route(c: Capture): string {
    if (typeof c.pattern === 'string' && typeof c.mount === 'string') {
      if (!c.mount) return clean(c.pattern);
      const path = c.url.split(/[?#]/)[0];
      const m = c.mount.startsWith('/') ? matchMount(c.mount) : undefined;
      if (m) return clean(trim(m) + c.pattern);
      const r = path.startsWith('/') ? match(path) : undefined;
      return clean(r || MOUNT + c.pattern);
    }
    if (c.route) return clean(c.route);
    const path = c.url.split(/[?#]/)[0];
    const r = path.startsWith('/') ? match(path) : undefined;
    if (r) return r;
    stats.unmatched++;
    return UNMATCHED;
  }

  function roll(current: number) {
    for (const m of minutes.values())
      if (m.minute < current && !m.runtime) {
        m.runtime = runtimeOf(loop);
        loop.reset();
      }
  }

  function minute(at: number): Minute {
    const key = at - (at % 60000);
    roll(key);
    let m = minutes.get(key);
    if (!m) {
      m = { minute: key, requests: new Map(), upstream: new Map(), unmatched: 0, runtime: null };
      minutes.set(key, m);
      while (minutes.size > keep) minutes.delete(minutes.keys().next().value as number);
    }
    return m;
  }

  function add(map: Map<string, Agg>, key: Record<string, string>, status: number, ms: number, failed: boolean) {
    let id = Object.values(key).join(' ');
    if (!map.has(id) && map.size >= MAX_KEYS) {
      stats.overflow++;
      key = Object.fromEntries(Object.keys(key).map((k) => [k, OTHER]));
      id = Object.values(key).join(' ');
    }
    let a = map.get(id);
    if (!a) map.set(id, (a = { key, count: 0, errors: 0, status: {}, sum: 0, max: 0, buckets: BOUNDS.map(() => 0) }));
    a.count++;
    if (failed || status === 0 || status >= 500) a.errors++;
    const sc = statusClass(status);
    a.status[sc] = (a.status[sc] || 0) + 1;
    a.sum += ms;
    a.max = Math.max(a.max, ms);
    a.buckets[BOUNDS.findIndex((b) => ms <= b)]++;
  }

  const addCall = (m: Minute, u: StrictCall) => add(m.upstream, { method: u.method, host: u.host }, u.status, u.ms, !!u.error);

  const consumer: Consumer = {
    kind: 'strict',
    request(c) {
      const spanList = c.spans.map((s) => toSpan(s));
      const r: StrictRequest = {
        at: c.at,
        method: strictMethod(c.method),
        route: route(c),
        status: c.status,
        ms: c.ms,
        ...(c.aborted ? { error: 'aborted' } : {}),
        dbMs: r1(spanList.filter((s) => s.name.startsWith('db.')).reduce((a, s) => a + s.ms, 0)),
        spans: spanList,
        upstream: c.calls.map((k) => toCall(k)),
      };
      requests.push(r);
      stats.recorded++;
      const m = minute(r.at);
      if (r.route === UNMATCHED) m.unmatched++;
      add(m.requests, { method: r.method, route: r.route }, r.status, r.ms, !!r.error);
      for (const u of r.upstream) addCall(m, u);
      onRecord?.(r);
    },
    span(s) {
      spans.push(toSpan(s, Date.now()));
    },
    call(k) {
      const u = toCall(k, Date.now());
      calls.push(u);
      addCall(minute(u.at!), u);
    },
    fault() {
      stats.errors++;
    },
  };

  const view = (m: Minute): MinuteSummary => ({
    minute: m.minute,
    requests: [...m.requests.values()].map((a) => ({ ...(a.key as { method: string; route: string }), ...figures(a) })),
    upstream: [...m.upstream.values()].map((a) => ({ ...(a.key as { method: string; host: string }), ...figures(a) })),
    unmatched: m.unmatched,
    runtime: m.runtime || (detach ? runtimeOf(loop) : null),
  });

  return {
    /** Attaches to the shared hooks and channels. Idempotent. */
    start() {
      if (detach) return;
      loop.enable();
      detach = attach(consumer);
    },
    stop() {
      if (!detach) return;
      detach();
      detach = null;
      loop.disable();
    },
    isActive: () => !!detach,
    /** Buffered request records, oldest first. */
    requests: () => requests.list(),
    /** Upstream calls made outside any request. */
    upstream: () => calls.list(),
    /** Spans timed outside any request. */
    spans: () => spans.list(),
    /** Returns the buffered records and empties the buffers. */
    drain: () => ({ requests: requests.drain(), upstream: calls.drain(), spans: spans.drain() }),
    /** Per-minute counts and timings, oldest first; closes minutes that have passed. */
    summaries(): MinuteSummary[] {
      roll(Date.now() - (Date.now() % 60000));
      return [...minutes.values()].map(view);
    },
    stats: (): StrictStats => ({ ...stats }),
    runtime: () => runtimeOf(loop),
    notChecked: () => notCheckedFacts(),
    /** Empties buffers and summaries; counters stay. */
    clear() {
      requests = bounded<StrictRequest>(size, drop);
      calls = bounded<StrictCall>(Math.ceil(size / 2), drop);
      spans = bounded<StrictSpan>(Math.ceil(size / 2), drop);
      minutes.clear();
    },
  };
}

export type StrictRecorder = ReturnType<typeof createStrictRecorder>;
