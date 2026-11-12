import { REDACTED, redactBody, redactHeaders, redactUrl } from './redact.js';
import type { Allow, ErrEntry, NetEntry } from './types.js';

export interface Ring<T> {
  push(item: T): void;
  list(limit?: number): T[];
}

export const R = (n: any) => Math.round(n || 0);

export const msg = (v: any): string => {
  try {
    return '' + (v?.message || (typeof v == 'object' ? JSON.stringify(v) : v));
  } catch {
    return '' + v;
  }
};

export function ring<T>(size: number): Ring<T> {
  const a: T[] = [];
  return {
    push: (x) => void (a.push(x) > size && a.shift()),
    list: (n) => a.slice(n ? -n : 0),
  };
}

/**
 * Wraps `fetch` to record redacted calls. While `trace()` is true, same-origin calls also carry an
 * `x-reins-trace` id, so `@mindmakr/reins/node` can join the server half. Cross-origin calls never get it.
 */
export function patchNetwork(g: any, record: (e: NetEntry) => void, { queryKeys, headers, bodyKeys }: Allow, trace: () => any): () => void {
  const now = () => R(g.performance?.now?.() ?? Date.now()),
    f = g.fetch,
    tid = Math.random().toString(36).slice(2, 8),
    hdr = (h: any, o: Record<string, string> = {}) => (h?.forEach ? h.forEach((v: string, k: string) => (o[k] = v)) : Object.assign(o, h), redactHeaders(o, headers));
  let n = 0;
  if (!f) return () => {};
  g.fetch = function (u: any, o: any = {}) {
    const startMs = now(),
      req = u?.url ? u : {},
      b = o.body,
      e: any = {
        method: (o.method || req.method || 'GET').toUpperCase(),
        url: redactUrl('' + (req.url || u), queryKeys),
        startMs,
        at: Date.now(),
        requestHeaders: hdr(o.headers || req.headers),
        requestBody: b == null ? undefined : typeof b == 'string' ? redactBody(b, bodyKeys) : REDACTED,
      },
      fin = (status: number, h?: any) => ((e.status = status), (e.ms = now() - startMs), (e.responseHeaders = hdr(h)), record(e));
    try {
      if (trace() && new URL(req.url || u, g.location.href).origin == g.location.origin)
        (o = { ...o, headers: new g.Headers(o.headers || req.headers) }).headers.set('x-reins-trace', (e.traceId = tid + '-' + ++n));
    } catch {}
    return f.call(this, u, o).then(
      (r: any) => (fin(r.status, r.headers), bodyKeys?.length && r.clone?.().text().then((t: string) => (e.responseBody = redactBody(t, bodyKeys)), () => {}), r),
      (err: any) => ((e.error = msg(err)), fin(0), Promise.reject(err)),
    );
  };
  return () => (g.fetch = f);
}

export function watchErrors(g: any, record: (e: ErrEntry) => void): () => void {
  const add = (kind: ErrEntry['kind'], v: any) => record({ kind, message: msg(v).slice(0, 2000), stack: v?.stack, at: Date.now() }),
    c = g.console,
    orig = c?.error,
    ev = (m: string, fn: any) => (g.addEventListener?.(m, fn), () => g.removeEventListener?.(m, fn)),
    u1 = ev('error', (e: any) => add('error', e.error || e.message)),
    u2 = ev('unhandledrejection', (e: any) => add('rejection', e.reason));
  if (orig) c.error = (...a: unknown[]) => (add('console', a.map(msg).join(' ')), orig.apply(c, a));
  return () => ((orig && (c.error = orig)), u1(), u2());
}
