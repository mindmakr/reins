export const REDACTED = '[redacted]';

const SENSITIVE = /pass|secret|token|auth|cookie|session|api[-_]?key|credential|private|jwt|bearer|otp|signature|card|ssn/i;
const mapPairs = (a: Array<[string, any]>, fn: (k: string, v: any) => any) => Object.fromEntries(a.map(([k, v]) => [k, fn(k, v)]));
const mapObj = (o: any, fn: (k: string, v: any) => any) => mapPairs(Object.entries(o), fn);
const has = (l: string[] | undefined, k: string) => l?.some((x) => x.toLowerCase() == k.toLowerCase());

export const isSensitive = (k: string): boolean => SENSITIVE.test(k);

export const redactPairs = (pairs: Array<[string, string]>, allow?: string[]): Record<string, string> =>
  mapPairs(pairs, (k, v) => (has(allow, k) ? v : REDACTED));

export const redactHeaders = (h: Record<string, string>, allow: string[] = []): Record<string, string> =>
  redactPairs(
    Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]),
    ['content-type', 'content-length', 'cache-control', 'etag', ...allow],
  );

export function redactBody(b?: string | null, keys?: string[]): unknown {
  if (!b) return;
  try {
    const p = (v: any): any => (Array.isArray(v) ? v.map(p) : v && typeof v == 'object' ? mapObj(v, (k, x) => (has(keys, k) ? x : p(x))) : REDACTED);
    return keys?.length ? p(JSON.parse(b)) : REDACTED;
  } catch {
    return REDACTED;
  }
}

export function redactDeep(value: unknown, allow?: string[], seen = new WeakSet()): unknown {
  const walk = (v: any): any =>
    typeof v == 'function'
      ? '[function]'
      : !v || typeof v != 'object'
        ? v
        : seen.has(v)
          ? '[cycle]'
          : (seen.add(v), Array.isArray(v) ? v.map(walk) : mapObj(v, (k, x) => (isSensitive(k) && !has(allow, k) ? REDACTED : walk(x))));
  return walk(value);
}

export const redactUrl = (url: string, allow?: string[]): string =>
  url.replace(/([?&])([^=&#]+)=[^&#]*/g, (m, sep, k) => (isSensitive(k) && !has(allow, k) ? `${sep}${k}=${REDACTED}` : m));
