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
  at: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
}

export interface ErrEntry {
  kind: 'console' | 'error' | 'rejection';
  message: string;
  at: number;
  stack?: string;
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
