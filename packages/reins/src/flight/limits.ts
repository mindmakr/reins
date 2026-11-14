// Every default limit of flight, in one place (design section 5, "All limits live in one place"), with the range
// an override may take and the document it follows (sources.ts). `chosen: true` marks a number that is reins'
// own choice: the document backs the check, not the figure. The manifest's `basics` overrides the limits of
// BASICS; the sink limits are options of the sinks and the notifier.
// Imports: reins' shared modules only (the flight safety test walks this file).
import type { SourceId } from './sources.js';

export interface Limit {
  value: number;
  min: number;
  max: number;
  source: SourceId;
  /** The number is reins' own choice; the source backs the check. */
  chosen: boolean;
  /** What the number means, in a few words. */
  means: string;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The limits of the built-in checks. The manifest's `basics` may set any of them, within its range. */
export const BASICS = {
  recentMs: { value: 5 * MIN, min: MIN, max: HOUR, source: 'sre-monitoring', chosen: true, means: 'the recent window the basics are measured over, in ms' },
  errorShare: { value: 0.05, min: 0, max: 1, source: 'sre-monitoring', chosen: true, means: 'the share of failed requests above which a finding opens' },
  errorFactor: { value: 2, min: 1, max: 100, source: 'reins', chosen: true, means: 'how many times its limit a share or a time must reach for its finding to be an error rather than a warning' },
  minRequests: { value: 20, min: 1, max: 1_000_000, source: 'reins', chosen: true, means: 'requests needed in the recent window before a share or a time is judged' },
  slowRouteMs: { value: 800, min: 1, max: 600_000, source: 'web-dev-ttfb', chosen: false, means: 'the 95th percentile time of a route above which it is slow, in ms' },
  upstreamErrorShare: { value: 0.25, min: 0, max: 1, source: 'sre-monitoring', chosen: true, means: 'the share of failed calls to one upstream host above which it is failing' },
  minCalls: { value: 5, min: 1, max: 1_000_000, source: 'reins', chosen: true, means: 'requests to one route, or calls to one host, needed in the recent window before its time or share is judged' },
  loopDelayMs: { value: 200, min: 1, max: 60_000, source: 'node-event-loop', chosen: true, means: 'the 99th percentile event-loop delay of a minute above which the loop was blocked, in ms' },
  loopMinutes: { value: 2, min: 1, max: 60, source: 'reins', chosen: true, means: 'blocked minutes of one instance in the recent window that open a finding' },
  heapGrowth: { value: 0.5, min: 0.01, max: 100, source: 'node-memory', chosen: true, means: 'growth of the heap over the memory window (0.5 is half again) that, rising steadily, opens a finding' },
  heapWindowMs: { value: 30 * MIN, min: 10 * MIN, max: DAY, source: 'node-memory', chosen: true, means: 'the window the heap is followed over, in ms' },
  heapMinutes: { value: 9, min: 3, max: 1440, source: 'reins', chosen: true, means: 'minutes of heap figures one instance needs in the memory window before its growth is judged' },
  heapSpread: { value: 0.8, min: 0.1, max: 1, source: 'reins', chosen: true, means: 'the share of the memory window those minutes must span, so a warm-up is not read as a leak' },
  refusedMin: { value: 20, min: 1, max: 1_000_000, source: 'owasp-logging', chosen: true, means: 'refused responses (401, 403, 429) in the recent window needed for a spike' },
  refusedFactor: { value: 3, min: 1, max: 1000, source: 'owasp-logging', chosen: true, means: 'how many times the time before a spike of refused responses must be' },
  refusedLookbackMs: { value: HOUR, min: 5 * MIN, max: DAY, source: 'owasp-logging', chosen: true, means: 'the time before the recent window that refused responses are compared with, in ms' },
  driftShare: { value: 0.8, min: 0.1, max: 1, source: 'reins', chosen: true, means: 'the share of a within or ends limit the 95th percentile may reach before a promise is drifting' },
  driftMinRuns: { value: 20, min: 1, max: 1_000_000, source: 'reins', chosen: true, means: 'runs that finished in the window needed before the 95th percentile of a within or ends promise is judged for drift' },
  baselineFactor: { value: 3, min: 1.1, max: 1000, source: 'sre-monitoring', chosen: true, means: 'how many times its own baseline a 95th percentile time must be to be drifting' },
  baselineMinMs: { value: 100, min: 0, max: 600_000, source: 'reins', chosen: true, means: 'the 95th percentile time below which no baseline drift is reported, in ms' },
  silentFactor: { value: 10, min: 2, max: 1000, source: 'reins', chosen: true, means: 'how many of its usual gaps a declared step may be missing before it is silent' },
  silentMinCount: { value: 10, min: 1, max: 1_000_000, source: 'reins', chosen: true, means: 'times a step must have been seen in the window before its silence is unusual' },
  silentMinMs: { value: 30 * MIN, min: MIN, max: 7 * DAY, source: 'reins', chosen: true, means: 'the shortest silence reported, in ms' },
  newCodeMs: { value: DAY, min: HOUR, max: 30 * DAY, source: 'reins', chosen: true, means: 'how long an error code seen for the first time stays unusual, in ms' },
  quietGraceMs: { value: HOUR, min: MIN, max: 7 * DAY, source: 'reins', chosen: true, means: 'how long flight must have been recording before a declared process with no steps is reported, in ms' },
} as const satisfies Record<string, Limit>;

export type BasicName = keyof typeof BASICS;
export type Basics = Record<BasicName, number>;

/** The limits of sinks and notifications: options of `flight.start({ notify })` and of each sink. */
export const SINK_LIMITS = {
  notifyPerHour: { value: 5, min: 1, max: 1000, source: 'flight-design', chosen: false, means: 'notifications one sink gets in an hour before the rest wait for one digest' },
  sinkFailures: { value: 3, min: 1, max: 1000, source: 'reins', chosen: true, means: 'deliveries in a row a sink may fail before it is reported as failing' },
  dailyHourUtc: { value: 8, min: 0, max: 23, source: 'reins', chosen: true, means: 'the hour (UTC) after which the daily summary is sent' },
  webhookTimeoutMs: { value: 15_000, min: 100, max: 60_000, source: 'standard-webhooks', chosen: false, means: 'how long one webhook delivery may take, in ms' },
  webhookMaxBytes: { value: 20_000, min: 1_000, max: 1_000_000, source: 'standard-webhooks', chosen: false, means: 'the largest webhook body sent, in bytes; a longer one is cut' },
  webhookRetries: { value: 3, min: 0, max: 10, source: 'reins', chosen: true, means: 'retries of a failed webhook delivery' },
  webhookBackoffMs: { value: 1_000, min: 10, max: 600_000, source: 'aws-backoff', chosen: true, means: 'the first back-off before a retry, doubled each time, with full jitter, in ms' },
  sinkQueue: { value: 100, min: 1, max: 10_000, source: 'reins', chosen: true, means: 'notifications waiting for one sink at most; more are counted as failed deliveries' },
  sinkTimeoutMs: { value: 30_000, min: 100, max: 600_000, source: 'reins', chosen: true, means: 'how long a function or file sink may take with one notification, in ms' },
  fileMaxBytes: { value: 10_000_000, min: 10_000, max: 1_000_000_000, source: 'reins', chosen: true, means: 'the size at which the file sink starts a new file, keeping one older file' },
} as const satisfies Record<string, Limit>;

export type SinkLimitName = keyof typeof SINK_LIMITS;

/** Every default limit, in one place. */
export const LIMITS: Readonly<Record<BasicName | SinkLimitName, Limit>> = { ...BASICS, ...SINK_LIMITS };

/** The default value of each basic limit. */
export const DEFAULT_BASICS: Basics = Object.fromEntries(Object.entries(BASICS).map(([k, v]) => [k, v.value])) as Basics;

/** The basic limits in force: the defaults, with the manifest's `basics` (already validated) over them. */
export function basicsOf(overrides?: Partial<Record<string, number>> | null): Basics {
  const out = { ...DEFAULT_BASICS };
  if (overrides && typeof overrides === 'object')
    for (const k of Object.keys(BASICS) as BasicName[]) {
      const v = overrides[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= BASICS[k].min && v <= BASICS[k].max) out[k] = v;
    }
  return out;
}

/** A sink limit: `v` when it is a number in range, else the default. */
export function sinkLimit(name: SinkLimitName, v: unknown): number {
  const l = SINK_LIMITS[name];
  return typeof v === 'number' && Number.isFinite(v) && v >= l.min && v <= l.max ? v : l.value;
}
