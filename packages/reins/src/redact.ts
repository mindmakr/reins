export const REDACTED = '[redacted]';

/** Key names that look like secrets or personal data. */
const SENSITIVE = /pass|secret|token|auth|cookie|session|api[-_]?key|credential|private|jwt|bearer|otp|signature|card|ssn/i;

/** Headers whose values are harmless and shown by default. */
const SAFE_HEADERS = ['content-type', 'content-length', 'cache-control', 'etag'];

const lower = (list?: string[]) => new Set((list || []).map((s) => s.toLowerCase()));

export function isSensitive(key: string): boolean {
  return SENSITIVE.test(key);
}

/** Header values are redacted unless safe or allowlisted. Authorization, Cookie and Set-Cookie only show when allowlisted. */
export function redactHeaders(headers: Record<string, string>, allow?: string[]): Record<string, string> {
  const ok = lower(allow);
  const out: Record<string, string> = {};
  for (const name in headers) {
    const key = name.toLowerCase();
    out[key] = ok.has(key) || SAFE_HEADERS.includes(key) ? headers[name] : REDACTED;
  }
  return out;
}

/** Bodies are redacted. With allowlisted keys, a JSON body keeps its shape and only those keys' values. */
export function redactBody(body: string | null | undefined, keys?: string[]): unknown {
  if (body == null || body === '') return undefined;
  if (!keys || keys.length === 0) return REDACTED;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return REDACTED;
  }
  return pick(parsed, lower(keys));
}

function pick(value: unknown, ok: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => pick(v, ok));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = ok.has(k.toLowerCase()) ? v : v && typeof v === 'object' ? pick(v, ok) : REDACTED;
    }
    return out;
  }
  return REDACTED;
}

/** Copies a value for sending, redacting sensitive keys, cutting cycles, functions and deep nesting. */
export function redactDeep(value: unknown, allow?: string[]): unknown {
  const ok = lower(allow);
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'function') return '[function]';
    if (typeof v === 'bigint') return String(v);
    if (!v || typeof v !== 'object') return v;
    if (seen.has(v)) return '[cycle]';
    if (depth > 8) return '[deep]';
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 100).map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) {
      out[k] = isSensitive(k) && !ok.has(k.toLowerCase()) ? REDACTED : walk(x, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/** Redacts query values whose names look sensitive. */
export function redactUrl(url: string, allow?: string[]): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const ok = lower(allow);
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const parts = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    const raw = eq < 0 ? part : part.slice(0, eq);
    let key = raw;
    try {
      key = decodeURIComponent(raw);
    } catch {
      // keep the raw name
    }
    return eq >= 0 && isSensitive(key) && !ok.has(key.toLowerCase()) ? `${part.slice(0, eq)}=${REDACTED}` : part;
  });
  return url.slice(0, q + 1) + parts.join('&') + (hash < 0 ? '' : url.slice(hash));
}

/** Lists storage keys; values are redacted unless allowlisted. */
export function redactPairs(pairs: Array<[string, string]>, allow?: string[]): Record<string, string> {
  const ok = lower(allow);
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) out[k] = ok.has(k.toLowerCase()) ? v : REDACTED;
  return out;
}
