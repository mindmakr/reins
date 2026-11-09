import { REDACTED, redactBody, redactHeaders, redactUrl } from './redact.js';
import type { Allow, ErrEntry, NetEntry } from './types.js';

export interface Ring<T> {
  push(item: T): void;
  list(limit?: number): T[];
}

/** Keeps the last `size` items. */
export function ring<T>(size: number): Ring<T> {
  const items: T[] = [];
  return {
    push(item) {
      if (items.push(item) > size) items.shift();
    },
    list: (limit) => items.slice(limit ? -limit : 0),
  };
}

function toObject(h: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (h?.forEach && !Array.isArray(h)) h.forEach((v: string, k: string) => (out[k] = v));
  else if (h) for (const [k, v] of Array.isArray(h) ? h : Object.entries(h)) out[k] = v;
  return out;
}

function parseRaw(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/[\r\n]+/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const bodyOf = (body: unknown, keys?: string[]) => (body == null ? undefined : typeof body === 'string' ? redactBody(body, keys) : REDACTED);

/** Wraps fetch and XMLHttpRequest to record calls. Returns a function that puts them back. */
export function patchNetwork(g: any, record: (e: NetEntry) => void, allow: Allow): () => void {
  const undo: Array<() => void> = [];
  const now = () => g.performance?.now?.() ?? Date.now();
  const entry = (method: string, url: string, headers: Record<string, string>, body: unknown): NetEntry => ({
    method: String(method || 'GET').toUpperCase(),
    url: redactUrl(String(url), allow.queryKeys),
    status: 0,
    ms: 0,
    at: Date.now(),
    requestHeaders: redactHeaders(headers, allow.headers),
    requestBody: bodyOf(body, allow.bodyKeys),
  });
  const done = (e: NetEntry, t: number, status: number, headers: Record<string, string>) => {
    e.status = status;
    e.ms = Math.round(now() - t);
    e.responseHeaders = redactHeaders(headers, allow.headers);
    record(e);
  };
  const keepBodies = !!allow.bodyKeys?.length;

  const origFetch = g.fetch;
  if (typeof origFetch == 'function') {
    g.fetch = function (this: unknown, input: any, init: any) {
      const t = now();
      const o = init || {};
      const req = input?.url ? input : {};
      const e = entry(o.method || req.method, req.url || input, toObject(o.headers || req.headers), o.body);
      return origFetch.apply(this, arguments as any).then(
        (res: any) => {
          done(e, t, res.status, toObject(res.headers));
          if (keepBodies) res.clone?.().text().then((text: string) => (e.responseBody = redactBody(text, allow.bodyKeys)), () => {});
          return res;
        },
        (err: any) => {
          e.error = String(err?.message || err);
          done(e, t, 0, {});
          throw err;
        },
      );
    };
    undo.push(() => (g.fetch = origFetch));
  }

  const P = g.XMLHttpRequest?.prototype;
  if (P) {
    const { open, send, setRequestHeader } = P;
    const info = new WeakMap<object, any>();
    P.open = function (this: any, method: string, url: string) {
      info.set(this, { method, url, headers: {} });
      return open.apply(this, arguments);
    };
    P.setRequestHeader = function (this: any, name: string, value: string) {
      const x = info.get(this);
      if (x) x.headers[name] = value;
      return setRequestHeader.apply(this, arguments);
    };
    P.send = function (this: any, body?: unknown) {
      const x = info.get(this);
      if (x) {
        const t = now();
        const e = entry(x.method, x.url, x.headers, body);
        this.addEventListener('loadend', () => {
          if (keepBodies && !this.responseType) e.responseBody = redactBody(this.responseText, allow.bodyKeys);
          done(e, t, this.status, parseRaw(this.getAllResponseHeaders() || ''));
        });
      }
      return send.apply(this, arguments);
    };
    undo.push(() => Object.assign(P, { open, send, setRequestHeader }));
  }

  return () => undo.forEach((f) => f());
}

function messageOf(v: any): string {
  if (v?.message) return String(v.message);
  try {
    return typeof v == 'object' ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

/** Records console errors, uncaught errors and unhandled rejections. Returns a function that stops. */
export function watchErrors(g: any, record: (e: ErrEntry) => void): () => void {
  const undo: Array<() => void> = [];
  const add = (kind: ErrEntry['kind'], v: any) => record({ kind, message: messageOf(v).slice(0, 2000), stack: v?.stack, at: Date.now() });
  const c = g.console;
  const orig = c?.error;
  if (orig) {
    c.error = function (...args: unknown[]) {
      add('console', args.map(messageOf).join(' '));
      return orig.apply(this, args);
    };
    undo.push(() => (c.error = orig));
  }
  if (g.addEventListener) {
    const onError = (ev: any) => add('error', ev.error || ev.message);
    const onRejection = (ev: any) => add('rejection', ev.reason);
    g.addEventListener('error', onError);
    g.addEventListener('unhandledrejection', onRejection);
    undo.push(() => {
      g.removeEventListener('error', onError);
      g.removeEventListener('unhandledrejection', onRejection);
    });
  }
  const eu = g.ErrorUtils; // React Native
  if (eu?.setGlobalHandler) {
    const prev = eu.getGlobalHandler?.();
    eu.setGlobalHandler((err: any, fatal?: boolean) => {
      add('error', err);
      prev?.(err, fatal);
    });
    undo.push(() => eu.setGlobalHandler(prev));
  }
  return () => undo.forEach((f) => f());
}
