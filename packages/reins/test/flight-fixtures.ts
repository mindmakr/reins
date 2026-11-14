// Instance minutes with traffic, for the findings and sinks tests.
import { LATENCY_BOUNDS, type Figures, type MinuteSummary } from '../src/recorder.js';
import type { InstanceMinute } from '../src/flight/store.js';
import { minute } from './flight-store-contract.js';

export const MIN = 60_000;

/** Figures of `count` requests that each took `ms`, `errors` of them failed. */
export function fig(count: number, errors = 0, ms = 20, refused: Record<string, number> = {}): Figures {
  const buckets = LATENCY_BOUNDS.map(() => 0);
  buckets[LATENCY_BOUNDS.findIndex((b) => ms <= b)] = count;
  return { count, errors, status: { '2xx': count - errors, ...(errors ? { '5xx': errors } : {}) }, avgMs: ms, p95Ms: ms, maxMs: ms, buckets, ...(Object.keys(refused).length ? { refused } : {}) };
}

export interface Traffic {
  requests?: Array<[string, string, Figures]>;
  upstream?: Array<[string, string, Figures]>;
  codes?: Record<string, number>;
  heapMb?: number;
  loopP99?: number;
}

export function basics(at: number, t: Traffic = {}): MinuteSummary {
  return {
    minute: at - (at % MIN),
    requests: (t.requests || []).map(([method, route, f]) => ({ method, route, ...f })),
    upstream: (t.upstream || []).map(([method, host, f]) => ({ method, host, ...f })),
    unmatched: 0,
    ...(t.codes ? { codes: t.codes } : {}),
    runtime: { node: 'v22', pid: 1, uptimeS: 1, rssMb: 100, heapUsedMb: t.heapMb ?? 50, eventLoop: { p50Ms: 1, p99Ms: t.loopP99 ?? 5, maxMs: 10 } },
  };
}

/** One instance's minute at `at`, with traffic. */
export const im = (instance: string, at: number, t: Traffic = {}, extra: Partial<InstanceMinute> = {}): InstanceMinute => minute(instance, at, { basics: basics(at, t), ...extra });
