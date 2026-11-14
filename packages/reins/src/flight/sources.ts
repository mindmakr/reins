// The documents flight's built-in checks and default limits follow (design C11, section 5, "Sources"): one
// list, each with the date it was read. A limit whose number is reins' own choice says so (`LIMITS[name].chosen`),
// and so does a check with no document behind it (source `reins`). The report links here.
// Imports: none (the flight safety test walks this file).

export interface Source {
  title: string;
  url: string;
  /** The date the document was read and the cited part confirmed, as YYYY-MM-DD. */
  read: string;
  /** What flight takes from it, in one sentence. */
  says: string;
}

export const SOURCES = {
  'sre-monitoring': {
    title: 'Google, Site Reliability Engineering, chapter 6: Monitoring Distributed Systems',
    url: 'https://sre.google/sre-book/monitoring-distributed-systems/',
    read: '2026-11-14',
    says: 'The four golden signals are latency, traffic, errors and saturation; every page should be actionable, about a novel problem, with good signal and very low noise.',
  },
  'web-dev-ttfb': {
    title: 'web.dev, Time to First Byte (TTFB)',
    url: 'https://web.dev/articles/ttfb',
    read: '2026-11-14',
    says: 'Good TTFB values are 0.8 seconds or less, and poor values are greater than 1.8 seconds.',
  },
  'node-event-loop': {
    title: "Node.js, Don't Block the Event Loop (or the Worker Pool)",
    url: 'https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop',
    read: '2026-11-14',
    says: 'All incoming requests and outgoing responses pass through the event loop, so while it is blocked no other client gets a turn. It gives no fixed number.',
  },
  'node-memory': {
    title: 'Node.js, Understanding and Tuning Memory (diagnostics: memory)',
    url: 'https://nodejs.org/en/learn/diagnostics/memory',
    read: '2026-11-14',
    says: 'A leak shows as continuously increasing memory usage, fast or slow, until the process crashes and restarts. It gives no fixed number.',
  },
  'owasp-logging': {
    title: 'OWASP Logging Cheat Sheet',
    url: 'https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html',
    read: '2026-11-14',
    says: 'Log authentication failures and authorization (access control) failures, watch for rapid bursts of them, and never log session ids, access tokens, passwords or keys directly.',
  },
  'rfc-9110': {
    title: 'RFC 9110, HTTP Semantics, sections 15.5.2 (401 Unauthorized) and 15.5.4 (403 Forbidden)',
    url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
    read: '2026-11-14',
    says: '401 means the request lacks valid credentials, 403 that the server refuses to fulfil it.',
  },
  'rfc-6585': {
    title: 'RFC 6585, Additional HTTP Status Codes, section 4 (429 Too Many Requests)',
    url: 'https://www.rfc-editor.org/rfc/rfc6585.html',
    read: '2026-11-14',
    says: 'The 429 status code indicates that the user has sent too many requests in a given amount of time ("rate limiting").',
  },
  'standard-webhooks': {
    title: 'Standard Webhooks specification',
    url: 'https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md',
    read: '2026-11-14',
    says: 'Sign msg_id.timestamp.payload with HMAC-SHA256 in the webhook-id, webhook-timestamp and webhook-signature (v1,base64) headers; a 3xx is a failure, not followed; time out between 15 and 30 s; keep payloads under about 20 kB; retry with exponential back-off and jitter.',
  },
  'aws-backoff': {
    title: 'AWS Architecture Blog, Exponential Backoff And Jitter',
    url: 'https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/',
    read: '2026-11-14',
    says: 'Jittered back-off should be considered a standard approach for remote clients.',
  },
  'flight-design': {
    title: 'reins flight design, docs/design/flight.md (sections 5 and 6, approved by the owner)',
    url: 'docs/design/flight.md',
    read: '2026-11-14',
    says: 'At most 5 notifications an hour per sink, then one digest; a daily summary by default; one finding per key.',
  },
  reins: {
    title: "reins' own choice",
    url: '',
    read: '2026-11-14',
    says: 'No document gives this number; reins chose it, and the manifest can change it.',
  },
} as const satisfies Record<string, Source>;

export type SourceId = keyof typeof SOURCES;

/** Each built-in check: the finding key it gives (its prefix), what it watches, and the document it follows. */
export const CHECKS = {
  'error-share': { source: 'sre-monitoring', what: 'The share of failed requests (5xx, no response or an error code) across all instances.' },
  'slow-route': { source: 'web-dev-ttfb', what: 'The 95th percentile time of each route across all instances.' },
  upstream: { source: 'sre-monitoring', what: 'The share of failed calls to each upstream host across all instances.' },
  'event-loop': { source: 'node-event-loop', what: 'The 99th percentile event-loop delay of each instance.' },
  memory: { source: 'node-memory', what: 'The heap of each instance, minute by minute.' },
  refused: { source: 'owasp-logging', what: 'Responses with status 401, 403 or 429 across all instances, against the hour before.' },
  baseline: { source: 'sre-monitoring', what: 'Route and upstream 95th percentile times against their own recent past.' },
  'promise-drift': { source: 'reins', what: 'The 95th percentile time of within and ends promises against their limit.' },
  'silent-step': { source: 'reins', what: 'Declared steps that stopped while their process goes on.' },
  'new-code': { source: 'sre-monitoring', what: 'Error codes not seen before ("a novel problem").' },
  'dev-module': { source: 'flight-design', what: 'Development reins loaded in a production process (design C12).' },
  sinks: { source: 'flight-design', what: 'Notification limits, digests, daily summaries and sinks that keep failing.' },
  webhook: { source: 'standard-webhooks', what: 'Webhook signing, redirects, time-outs, size and retries.' },
} as const satisfies Record<string, { source: SourceId; what: string }>;

export type CheckId = keyof typeof CHECKS;

/** One line naming a check's document and the date it was read, for a finding's `source`. */
export function sourceLine(check: CheckId, chosen = false): string {
  const s: Source = SOURCES[CHECKS[check].source];
  const doc = s.url ? `${s.title} (${s.url}), read ${s.read}` : s.title;
  return chosen && s.url ? `${doc}; the limit's number is reins' own choice` : doc;
}
