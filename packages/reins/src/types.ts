/** A JSON Schema object. reins passes it through untouched. */
export type JSONSchema = Record<string, unknown>;

export interface Action<I = any, O = any> {
  /** Letters, digits, `.`, `_` and `-`, up to 64 characters. */
  name: string;
  description: string;
  /** JSON Schema for the input. Use an object schema. */
  input?: JSONSchema;
  /** Changes real data or sends something. Callers must pass `confirm: true`. */
  consequential?: boolean;
  /** Reads only. Passed to WebMCP as `readOnlyHint`. */
  readOnly?: boolean;
  run: (input: I) => O | Promise<O>;
}

export interface ActionInfo {
  name: string;
  description: string;
  input: JSONSchema;
  consequential: boolean;
  readOnly: boolean;
}

/** Keys that are shown as they are. Everything else sensitive is redacted. */
export interface Allow {
  headers?: string[];
  bodyKeys?: string[];
  storageKeys?: string[];
  cookies?: string[];
  queryKeys?: string[];
  stateKeys?: string[];
}

export interface Box {
  id: string;
  /** CSS pixels, relative to the viewport. */
  x: number;
  y: number;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export type Measure = () => Box | null | Promise<Box | null>;

export interface NetEntry {
  method: string;
  url: string;
  status: number;
  ms: number;
  startMs?: number;
  at: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
  /** Sent as `x-reins-trace` on same-origin calls while paired, so `@mindmakr/reins/node` can join the server half. */
  traceId?: string;
}

export interface ErrEntry {
  kind: 'console' | 'error' | 'rejection';
  message: string;
  at: number;
  stack?: string;
}

export interface ComponentPerf {
  id: string;
  mountedAtMs: number;
  lastRenderMs: number;
  renders: number;
}

export interface PerfTimelineEntry {
  kind: 'lifecycle' | 'component-mount' | 'api' | 'action' | 'server';
  name: string;
  atMs: number;
  durationMs?: number;
  status?: number;
  /** Server entries (joined by the bridge from `@mindmakr/reins/node`): the trace id, time in `db.*` spans, and the spans. */
  traceId?: string;
  dbMs?: number;
  spans?: Array<{ name: string; atMs: number; durationMs: number; error?: string }>;
}

export interface ApiCall {
  method: string;
  url: string;
  status: number;
  startMs?: number;
  ms: number;
  traceId?: string;
}

export interface PerfReport {
  lifecycle: {
    ttfbMs: number | null;
    domInteractiveMs: number | null;
    domContentLoadedMs: number | null;
    loadMs: number | null;
    firstPaintMs: number | null;
    firstContentfulPaintMs: number | null;
    domNodes: number;
    nowMs: number;
  };
  components: ComponentPerf[];
  api: {
    totalCalls: number;
    failedCalls: number;
    avgMs: number;
    maxMs: number;
    slowest: ApiCall | null;
    /** In the page these are the full (redacted) network entries; the bridge trims them to these fields. */
    calls: ApiCall[];
  };
  actions: Array<{ name: string; startMs: number; durationMs: number }>;
  /** Built from the parts above by `withTimeline` in `@mindmakr/reins/report`. The bridge's `reins_perf` and record mode always include it. */
  timeline?: PerfTimelineEntry[];
  /** Added by the bridge when a `@mindmakr/reins/node` server is paired. */
  server?: { requests: number; slowest: RouteStat[]; runtime: ServerRuntime | null };
}

/** One timed piece of server work: a `reinsNode.span()` call. */
export interface ServerSpan {
  name: string;
  /** Milliseconds from the start of the request (or of the process, for top-level spans). */
  startMs: number;
  ms: number;
  error?: string;
}

/** One outbound `fetch` the server made (seen through `node:diagnostics_channel`). */
export interface ServerOutbound {
  method: string;
  url: string;
  status: number;
  startMs: number;
  ms: number;
  error?: string;
}

/** One inbound HTTP request handled by a server that uses `@mindmakr/reins/node`. */
export interface ServerRequest {
  method: string;
  route: string;
  url: string;
  status: number;
  ms: number;
  /** `performance.now()` of the server process when the request started. */
  startMs: number;
  at: number;
  traceId?: string;
  /** Total time in spans whose name starts with `db.`. */
  dbMs: number;
  spans: ServerSpan[];
  outbound: ServerOutbound[];
  requestHeaders?: Record<string, string>;
}

export interface ServerRuntime {
  node: string;
  pid: number;
  uptimeS: number;
  rssMb: number;
  heapUsedMb: number;
  eventLoop: { p50Ms: number; p99Ms: number; maxMs: number };
}

export interface RouteStat {
  method: string;
  route: string;
  count: number;
  avgMs: number;
  maxMs: number;
  avgDbMs: number;
}

/** What `reins_server` returns for one server. */
export interface ServerReport {
  runtime: ServerRuntime | null;
  requests: ServerRequest[];
  slowest: RouteStat[];
  spans: ServerSpan[];
  outbound: ServerOutbound[];
  actions?: ActionInfo[];
}

export interface DomOptions {
  panel?: string;
  selector?: string;
  depth?: number;
  maxNodes?: number;
}

export type DomIssue = 'horizontal-clip' | 'vertical-clip' | 'zero-size';

export interface DomNode {
  tag: string;
  id?: string;
  classes?: string[];
  panel?: string;
  role?: string;
  text?: string;
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  issues: DomIssue[];
  children: DomNode[];
}

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface ConnectOptions {
  /** Bridge WebSocket URL. Default `ws://127.0.0.1:7357`. */
  url?: string;
  /** Pairing token. If missing, reins fetches it from `tokenUrl`. */
  token?: string;
  /** Where to fetch the token. Default `/__reins/token` (served by the Vite plugin). */
  tokenUrl?: string;
  allow?: Allow;
  /** Size of the network and error buffers. Default 100. */
  bufferSize?: number;
  /** Register actions as WebMCP tools when the browser supports it. Default true. */
  webmcp?: boolean;
  /** Wait for `load` and an idle moment before connecting. Default true. */
  lazy?: boolean;
  /** Retry when the bridge is not there or goes away. Default true. */
  reconnect?: boolean;
  /** Extra facts sent with the handshake, such as `{ platform: 'android' }`. */
  meta?: Record<string, string>;
  /** For tests and React Native. Default `globalThis.WebSocket`. */
  WebSocket?: new (url: string) => SocketLike;
}
