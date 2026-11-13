// Sinks (design section 6): where findings go. Three ship: a signed webhook, a JSON-lines file and a function
// of the app's. The notifier tells each sink when a finding opens, changes level or resolves, never once per
// occurrence; past the hourly limit it holds the rest for one digest; and it sends a daily summary. Delivery
// runs in the background and never blocks a request or a checker pass. A sink that throws never stops the others.
// Sinks get counts, never process keys, unless the app opts a sink in (C6).
// Imports: Node built-ins and reins' shared modules only (the flight safety test walks this file).
import { createHmac, randomBytes } from 'node:crypto';
import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { errorCode, untracked } from '../recorder.js';
import { type Change, type FlightFinding, type Observation, plural } from './findings.js';
import { SINK_LIMITS, sinkLimit } from './limits.js';
import { sourceLine } from './sources.js';

/** A finding as a sink gets it: no process keys unless the sink opted in. */
export type SinkFinding = Omit<FlightFinding, 'keys'> & { keys?: string[] };

export interface Notification {
  /** `opened`, `changed` (level) and `resolved` carry one finding; `digest` the ones held back; `summary` the open ones. */
  type: 'opened' | 'changed' | 'resolved' | 'digest' | 'summary';
  service: string;
  /** When it was sent, ISO 8601. */
  at: string;
  /** Plain text, so a channel that accepts `{ "text": ... }` shows it readably. */
  text: string;
  finding?: SinkFinding;
  /** For `changed`: the level before. */
  from?: 'error' | 'warn';
  /** For `digest`: how many notifications were held back. */
  held?: number;
  /** For `digest`: the held ones (at most HELD_KEPT); for `summary`: the open findings. */
  findings?: SinkFinding[];
  /** For `summary`: what was checked. */
  checked?: SummaryFigures;
}

export interface SummaryFigures {
  promises: { held: number; broken: number; notChecked: number };
  probes: { held: number; broken: number; notChecked: number };
  /** Open findings by kind. */
  open: Record<string, number>;
  /** What could not be checked at all, in plain words. */
  notChecked: string[];
}

export interface FlightSink {
  /** Unique among the app's sinks: letters, digits, `.`, `_` and `-`. Names the sink in counts and in its blind finding. */
  name: string;
  /** Give this sink the process keys behind a finding (C6). Default false: counts only. */
  keys?: boolean;
  /** How long one notification may take, retries included, before it counts as failed. */
  timeoutMs?: number;
  /** Delivers one notification. A throw or a rejection counts as a failed delivery. */
  send(n: Notification): unknown;
}

/** A sink failure with a short reason only: never a message, which could carry an address or a secret. */
export class SinkError extends Error {
  constructor(readonly reason: string) {
    super(`reins flight sink: ${reason}`);
    this.name = 'SinkError';
  }
}

const NAME = /^[A-Za-z0-9._-]{1,40}$/;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Held notifications kept for a digest; the count goes on past it. */
export const HELD_KEPT = 20;
/** Open findings listed in a daily summary at most. */
const SUMMARY_KEPT = 50;

/** The finding as `sink` may see it: a copy, so a sink that changes it changes nothing of flight's. */
export function sinkView(f: FlightFinding, keys = false): SinkFinding {
  const { keys: k, tags, ...rest } = f;
  return { ...rest, ...(tags ? { tags: [...tags] } : {}), ...(keys && k?.length ? { keys: [...k] } : {}) };
}

// ---- the three sinks --------------------------------------------------------------------------------------

/** The app's own function: it gets each notification and does what it likes (store it, open an issue). */
export function functionSink(fn: (n: Notification) => unknown, o: { name?: string; keys?: boolean; timeoutMs?: number } = {}): FlightSink {
  return {
    name: o.name || 'function',
    ...(o.keys ? { keys: true } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    send: (n) => {
      if (typeof fn !== 'function') throw new SinkError('config');
      return fn(n);
    },
  };
}

export interface FileSinkOptions {
  /** Folder of the file. Default `.reins/flight` in the current directory. */
  dir?: string;
  /** Default `notifications.jsonl`. */
  file?: string;
  name?: string;
  keys?: boolean;
  /** Past this size the file is renamed to `<file>.1` (replacing an older one) and a new one starts. Default 10 MB. */
  maxBytes?: number;
}

/** A file name of the file sink: letters, digits, `.`, `_` and `-`, and not `.` or `..`. */
const FILE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** One JSON line per notification, by default in `.reins/flight/notifications.jsonl`; owner-only file modes. */
export function fileSink(o: FileSinkOptions = {}): FlightSink {
  const dir = typeof o.dir === 'string' && o.dir ? o.dir : join(process.cwd(), '.reins', 'flight');
  const file = join(dir, typeof o.file === 'string' && FILE_NAME.test(o.file) ? o.file : 'notifications.jsonl');
  const max = sinkLimit('fileMaxBytes', o.maxBytes);
  return {
    name: o.name || 'file',
    ...(o.keys ? { keys: true } : {}),
    // Every file call is asynchronous: a send runs in the background, and must not hold the event loop.
    async send(n) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // As the bridge and the file store do: a folder named .reins holds its own .gitignore ('wx': never replaced).
      const top = dirname(dir);
      if (basename(top) === '.reins') await writeFile(join(top, '.gitignore'), '*\n', { mode: 0o600, flag: 'wx' }).catch(() => {});
      try {
        if ((await stat(file)).size >= max) await rename(file, `${file}.1`);
      } catch {}
      await appendFile(file, JSON.stringify(n) + '\n', { mode: 0o600 });
    },
  };
}

export interface WebhookOptions {
  /** https, or http to localhost only. Read it from the environment, never from the manifest. */
  url: string;
  /**
   * The shared secret, 24 to 64 bytes: `whsec_` and base64 (Standard Webhooks), or plain text. Read it from the
   * environment. Each delivery is signed with HMAC-SHA256 over `id.timestamp.body`.
   */
  secret: string;
  name?: string;
  keys?: boolean;
  /** One attempt's time limit. Default 15 s. */
  timeoutMs?: number;
  /** The largest body sent; a longer notification is cut down to fit. Default 20,000 bytes. */
  maxBytes?: number;
  /** Retries after a failed attempt (network error, time-out, 408, 429 or 5xx). Default 3. */
  retries?: number;
  /** The first back-off, doubled for each retry, with full jitter. Default 1 s. */
  backoffMs?: number;
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The webhook address, if it may be used: https, or http to this machine only, and no other scheme. */
export function webhookUrl(u: unknown): URL | null {
  try {
    const url = new URL(String(u));
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && LOCAL.has(url.hostname)) return url;
  } catch {}
  return null;
}

/** The secret's bytes: `whsec_` and base64, or the text itself; null outside 24 to 64 bytes. */
function secretBytes(s: unknown): Buffer | null {
  if (typeof s !== 'string') return null;
  const b = s.startsWith('whsec_') ? Buffer.from(s.slice(6), 'base64') : Buffer.from(s, 'utf8');
  return b.length >= 24 && b.length <= 64 ? b : null;
}

/** The Standard Webhooks signature of `body`: `v1,` and base64 HMAC-SHA256 over `id.timestamp.body`. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = secretBytes(secret);
  if (!key) throw new SinkError('config');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/** The body, cut down to `max` bytes: fewer listed findings first, then shorter texts, then the bare line. */
export function fitBody(n: Notification, max: number): string {
  let body = JSON.stringify(n);
  if (Buffer.byteLength(body) <= max) return body;
  let cut: Notification = { ...n, ...(n.findings ? { findings: [...n.findings] } : {}) };
  while (cut.findings && cut.findings.length && Buffer.byteLength((body = JSON.stringify(cut))) > max) cut.findings = cut.findings.slice(0, Math.floor(cut.findings.length / 2));
  if (Buffer.byteLength((body = JSON.stringify(cut))) <= max) return body;
  const short = (s: string) => (s.length > 500 ? `${s.slice(0, 500)}...` : s);
  cut = { ...cut, text: short(cut.text), ...(cut.finding ? { finding: { ...cut.finding, text: short(cut.finding.text), keys: undefined, why: undefined } } : {}) };
  if (Buffer.byteLength((body = JSON.stringify(cut))) <= max) return body;
  // The bare line: the text cut by bytes (as JSON writes it, escapes included) until the body fits.
  const bare = (text: string) => JSON.stringify({ type: n.type, service: cutBytes(String(n.service), 100), at: n.at, text, truncated: true });
  let text = cutBytes(String(n.text), Math.max(0, max - Buffer.byteLength(bare(''))));
  while (Buffer.byteLength((body = bare(text))) > max && text) text = cutBytes(text, Math.max(0, Buffer.byteLength(text) - (Buffer.byteLength(body) - max)));
  return body;
}

/** `s` cut to at most `bytes` bytes of UTF-8, never inside a character. */
export function cutBytes(s: string, bytes: number): string {
  if (Buffer.byteLength(s) <= bytes) return s;
  const b = Buffer.from(s, 'utf8');
  let end = Math.max(0, Math.floor(bytes));
  // Back to the start of a character: continuation bytes are 10xxxxxx.
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString('utf8');
}

/** The longest delay a timer takes: a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A sink's own time limit, if it is a finite number above zero, raised to the floor of SINK_LIMITS.sinkTimeoutMs
 * (a limit of 1 ms would fail every delivery) and kept within what a timer can wait; else the default. Its ceiling
 * (600,000 ms) is not applied: it bounds the default for function and file sinks, while a webhook sink's own limit
 * covers all its retries and back-offs, which may rightly take longer.
 */
function sinkTimeout(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, SINK_LIMITS.sinkTimeoutMs.min), MAX_TIMER_MS) : sinkLimit('sinkTimeoutMs', undefined);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as any).unref?.();
  });

/**
 * One POST. Resolves with the status, or rejects with a short reason. Redirects are not followed. node:http and
 * node:https are loaded on the first delivery, not on import: importing the flight entry does nothing (design
 * section 7), and loading node:http sets a global.
 */
async function post(url: URL, headers: Record<string, string>, body: string, timeoutMs: number): Promise<number> {
  const { request } = url.protocol === 'https:' ? await import('node:https') : await import('node:http');
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    // Flight's own delivery is not one of the app's upstream calls: the recorder does not see it.
    const req = untracked(() => request(url, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } }));
    const timer = setTimeout(() => {
      settle(() => reject(new SinkError('timeout')));
      req.destroy();
    }, timeoutMs);
    (timer as any).unref?.();
    req.on('response', (res) => {
      const status = res.statusCode || 0;
      // The body is not needed: nothing of it is read or kept.
      res.destroy();
      settle(() => resolve(status));
    });
    req.on('error', (e) => settle(() => reject(new SinkError(errorCode(e)))));
    req.end(body);
  });
}

/**
 * A signed webhook (Standard Webhooks): a JSON POST with a plain `text` field and the finding's fields, headers
 * `webhook-id`, `webhook-timestamp` and `webhook-signature`. https only, except to localhost; no redirects; a
 * time limit per attempt; a size cap; bounded retries with exponential back-off and full jitter. A bad address or
 * secret never throws here: each delivery fails with reason `config`, which the report shows as a failing sink.
 */
export function webhookSink(o: WebhookOptions): FlightSink {
  const opts = o && typeof o === 'object' ? o : ({} as WebhookOptions);
  const url = webhookUrl(opts.url);
  const secret = secretBytes(opts.secret) ? opts.secret : null;
  const timeoutMs = sinkLimit('webhookTimeoutMs', opts.timeoutMs);
  const maxBytes = sinkLimit('webhookMaxBytes', opts.maxBytes);
  const retries = sinkLimit('webhookRetries', opts.retries);
  const backoffMs = sinkLimit('webhookBackoffMs', opts.backoffMs);
  return {
    name: opts.name || 'webhook',
    ...(opts.keys ? { keys: true } : {}),
    // Every attempt at its limit, and the longest back-offs between them.
    timeoutMs: (retries + 1) * timeoutMs + backoffMs * (2 ** (retries + 1)) + 1000,
    async send(n) {
      if (!url || !secret) throw new SinkError('config');
      const body = fitBody(n, maxBytes);
      const id = `msg_${randomBytes(16).toString('hex')}`;
      let reason = 'error';
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt) await sleep(Math.random() * backoffMs * 2 ** (attempt - 1));
        const ts = Math.floor(Date.now() / 1000);
        const headers = {
          'content-type': 'application/json',
          'user-agent': 'reins-flight',
          'webhook-id': id,
          'webhook-timestamp': String(ts),
          'webhook-signature': signWebhook(secret, id, ts, body),
        };
        let status: number;
        try {
          status = await post(url, headers, body, timeoutMs);
        } catch (e) {
          reason = e instanceof SinkError ? e.reason : errorCode(e);
          continue;
        }
        if (status >= 200 && status < 300) return;
        // A redirect is a failure and is not followed; a refusal other than 408 or 429 is not retried.
        if (status >= 300 && status < 400) throw new SinkError(`redirect-${status}`);
        reason = `status-${status}`;
        if (status !== 408 && status !== 429 && status < 500) throw new SinkError(reason);
      }
      throw new SinkError(reason);
    },
  };
}

// ---- the notifier -------------------------------------------------------------------------------------------

export interface NotifyOptions {
  /** Notifications one sink gets in an hour; the rest wait for one digest. Default 5. */
  perHour?: number;
  /** Send a daily summary. Default true. */
  daily?: boolean;
  /** The hour (UTC) after which the daily summary goes. Default 8. */
  dailyHourUtc?: number;
  /** Deliveries in a row a sink may fail before it is reported. Default 3. */
  failures?: number;
}

interface SinkState {
  /** The hour (ms since epoch / HOUR) the count is for. */
  hour: number;
  sent: number;
  held: number;
  kept: Array<{ type: 'opened' | 'changed' | 'resolved'; finding: SinkFinding }>;
}

/** What the notifier keeps in the store (FindingsMemory.notify), so several instances count as one service. */
export interface NotifyState {
  sinks?: Record<string, SinkState>;
  /** When the last daily summary went, or when the notifier first ran. */
  dailyFrom?: number;
}

interface Health {
  failures: number;
  reason: string;
  /** The first failure in the current run of failures. */
  since: number;
}

export interface Delivery {
  sink: FlightSink;
  n: Notification;
}

/** Normalises the app's sinks: functions become function sinks; names are made unique; anything else is left out. */
export function normaliseSinks(list: unknown): FlightSink[] {
  const out: FlightSink[] = [];
  const names = new Set<string>();
  for (const [i, s] of (Array.isArray(list) ? list : list ? [list] : []).entries()) {
    const sink: FlightSink | null = typeof s === 'function' ? functionSink(s as (n: Notification) => unknown) : s && typeof s === 'object' && typeof (s as FlightSink).send === 'function' ? (s as FlightSink) : null;
    if (!sink) continue;
    const base = typeof sink.name === 'string' && NAME.test(sink.name) ? sink.name : `sink-${i + 1}`;
    let name = base;
    // The base is cut before the suffix, so a name of 40 characters still gets a new one.
    for (let k = 2; names.has(name); k++) name = `${base.slice(0, 40 - String(k).length - 1)}-${k}`;
    names.add(name);
    out.push(name === sink.name ? sink : { ...sink, name, send: sink.send.bind(sink) });
  }
  return out;
}

const iso = (t: number) => new Date(t).toISOString();

const LINE: Record<string, string> = { opened: 'Opened', changed: 'Now', resolved: 'Resolved' };

function changeText(service: string, c: Change): string {
  const f = c.finding;
  const head = c.event === 'changed' ? `${LINE.changed} ${f.level} (was ${c.from})` : LINE[c.event];
  return `[${service}] ${head}, ${f.kind} ${f.level}: ${f.text}`;
}

/** The next time the daily summary is due after `from`: the next `hourUtc` o'clock. */
export function nextDaily(from: number, hourUtc: number): number {
  const d = new Date(from);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc);
  if (t <= from) t += DAY;
  return t;
}

/**
 * Plans and sends notifications. `plan` is pure apart from the sink health it reads: it takes the changes of a
 * pass and the shared state, and returns the deliveries and the new state. `dispatch` sends them in the
 * background, one at a time per sink, with a queue bound and a time limit per notification.
 */
export function createNotifier(sinksIn: unknown, o: NotifyOptions = {}) {
  const sinks = normaliseSinks(sinksIn);
  const perHour = sinkLimit('notifyPerHour', o.perHour);
  const daily = o.daily !== false;
  const dailyHourUtc = sinkLimit('dailyHourUtc', o.dailyHourUtc);
  const failuresLimit = sinkLimit('sinkFailures', o.failures);
  const queueLimit = sinkLimit('sinkQueue', undefined);
  const health = new Map<string, Health>();
  const chains = new Map<string, Promise<void>>();
  /** Notifications queued or being sent, per sink. */
  const pending = new Map<string, number>();
  /** Sinks whose last call ran past its time limit and has not settled: no new call starts until it does. */
  const stuck = new Set<string>();
  const counts = { sent: 0, failed: 0, skipped: 0 };

  function failed(sink: FlightSink, reason: string) {
    counts.failed++;
    const h = health.get(sink.name);
    if (h) {
      h.failures++;
      h.reason = reason;
    } else health.set(sink.name, { failures: 1, reason, since: Date.now() });
  }

  function deliver(sink: FlightSink, n: Notification): void {
    const waiting = pending.get(sink.name) || 0;
    if (waiting >= queueLimit) {
      failed(sink, 'queue-full');
      return;
    }
    pending.set(sink.name, waiting + 1);
    const limit = sinkTimeout(sink.timeoutMs);
    const run = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A call that ran past its time limit may still be running: calling the sink again would pile calls up
        // (as with the store, u3). This notification is skipped and counted as a failed delivery instead.
        if (stuck.has(sink.name)) {
          counts.skipped++;
          throw new SinkError('busy');
        }
        const sent = Promise.resolve().then(() => sink.send(n));
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            stuck.add(sink.name);
            const settled = () => stuck.delete(sink.name);
            sent.then(settled, settled);
            reject(new SinkError('timeout'));
          }, limit);
          (timer as any).unref?.();
        });
        await Promise.race([sent, late]);
        counts.sent++;
        health.delete(sink.name);
      } catch (e) {
        failed(sink, e instanceof SinkError ? e.reason : errorCode(e));
      } finally {
        clearTimeout(timer);
        pending.set(sink.name, (pending.get(sink.name) || 1) - 1);
      }
    };
    const next = (chains.get(sink.name) || Promise.resolve()).then(run, run);
    chains.set(sink.name, next);
  }

  return {
    names: () => sinks.map((s) => s.name),
    /** Sinks that keep failing, as blind observations (B12): `blind:sink:<name>`. */
    health(): Observation[] {
      const out: Observation[] = [];
      for (const s of sinks) {
        const h = health.get(s.name);
        if (!h || h.failures < failuresLimit) continue;
        out.push({
          key: `blind:sink:${s.name}`,
          kind: 'blind',
          level: 'warn',
          n: h.failures,
          source: sourceLine('sinks', true),
          text: `Sink ${s.name} has failed its last ${plural(h.failures, 'delivery', 'deliveries')} (${h.reason}), so findings may not reach it.`,
        });
      }
      return out;
    },
    /**
     * The deliveries for this pass's changes, the digests of hours that ended, and the daily summary when due.
     * A sink is not told about its own failure (it is the one failing); the others are.
     */
    plan(changes: Change[], state: NotifyState | undefined, now: number, service: string, summary?: () => { findings: FlightFinding[]; checked: SummaryFigures }): { deliveries: Delivery[]; state: NotifyState } {
      const next: NotifyState = { sinks: { ...((state && state.sinks) || {}) }, dailyFrom: state?.dailyFrom };
      const deliveries: Delivery[] = [];
      const hour = Math.floor(now / HOUR);
      const at = iso(now);
      let summaryDue = false;
      if (daily) {
        if (typeof next.dailyFrom !== 'number' || !Number.isFinite(next.dailyFrom)) next.dailyFrom = now;
        else if (now >= nextDaily(next.dailyFrom, dailyHourUtc)) {
          summaryDue = true;
          next.dailyFrom = now;
        }
      }
      const built = summaryDue && summary ? summary() : null;
      for (const sink of sinks) {
        const prev = next.sinks![sink.name];
        let s: SinkState = prev && typeof prev === 'object' && Number.isFinite(prev.hour) ? { ...prev, kept: Array.isArray(prev.kept) ? [...prev.kept] : [] } : { hour, sent: 0, held: 0, kept: [] };
        if (s.hour !== hour) {
          if (s.held > 0) {
            const lines = s.kept.map((k) => `- ${LINE[k.type] || k.type}: ${k.finding.text}`).join('\n');
            deliveries.push({
              sink,
              n: { type: 'digest', service, at, held: s.held, findings: s.kept.map((k) => k.finding), text: `[${service}] ${s.held} more notifications were held back in the last hour (at most ${perHour} an hour):\n${lines}${s.held > s.kept.length ? `\n- and ${s.held - s.kept.length} more` : ''}` },
            });
          }
          s = { hour, sent: 0, held: 0, kept: [] };
        }
        for (const c of changes) {
          if (c.finding.key === `blind:sink:${sink.name}`) continue;
          const finding = sinkView(c.finding, sink.keys === true);
          if (s.sent < perHour) {
            s.sent++;
            deliveries.push({ sink, n: { type: c.event, service, at, text: changeText(service, c), finding, ...(c.from ? { from: c.from } : {}) } });
          } else {
            s.held++;
            if (s.kept.length < HELD_KEPT) s.kept.push({ type: c.event, finding: sinkView(c.finding) });
          }
        }
        if (built) {
          const open = built.findings.filter((f) => f.state === 'open');
          const kinds = Object.entries(built.checked.open).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
          const p = built.checked.promises;
          const text =
            `[${service}] Daily summary: ${open.length ? `${open.length} open (${kinds})` : 'nothing open'}. ` +
            `Checked ${p.held + p.broken} promises (${p.broken} broken), ${built.checked.probes.held + built.checked.probes.broken} probes and the basics over all instances` +
            `${p.notChecked + built.checked.probes.notChecked ? `; ${p.notChecked + built.checked.probes.notChecked} could not be checked` : ''}.` +
            `${built.checked.notChecked.length ? ` Not checked: ${built.checked.notChecked.join(' ')}` : ''}` +
            `${open.length ? `\n${open.slice(0, 10).map((f) => `- ${f.kind} ${f.level}: ${f.text}`).join('\n')}` : ''}`;
          deliveries.push({ sink, n: { type: 'summary', service, at, text, findings: open.slice(0, SUMMARY_KEPT).map((f) => sinkView(f, sink.keys === true)), checked: built.checked } });
        }
        next.sinks![sink.name] = s;
      }
      // Sinks no longer configured are forgotten.
      for (const k of Object.keys(next.sinks!)) if (!sinks.some((s) => s.name === k)) delete next.sinks![k];
      return { deliveries, state: next };
    },
    /** Sends in the background; returns at once. */
    dispatch(deliveries: Delivery[]): void {
      for (const d of deliveries) {
        try {
          deliver(d.sink, d.n);
        } catch {}
      }
    },
    /** Resolves when every delivery started so far has settled (tests, and `flight.flush`). */
    idle: async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await Promise.all([...chains.values()]);
    },
    /** Deliveries sent and failed (skipped ones among them), and notifications queued or still running, a call that ran past its time limit included. */
    stats: () => ({ ...counts, pending: [...pending.values()].reduce((a, x) => a + x, 0) + stuck.size }),
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
