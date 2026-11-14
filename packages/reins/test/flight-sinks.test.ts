// Design section 6, unit u4 behaviours B8 to B12: the webhook, file and function sinks, when a sink is told,
// the hourly limit and digest, the daily summary, one notification with two instances, keys and secrets kept
// out of sinks and the store, and a sink that keeps failing.
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createFlight, type Flight } from '../src/flight.js';
import type { Change, FlightFinding } from '../src/flight/findings.js';
import { validateManifest } from '../src/flight/manifest.js';
import { createNotifier, fileSink, fitBody, functionSink, mergeNotify, normaliseSinks, type Notification, SinkError, sinkView, webhookSink, webhookUrl } from '../src/flight/sinks.js';
import { type FlightStore, memoryStore } from '../src/flight/store.js';
import { markDevModule } from '../src/recorder.js';
import { fig, im, MIN } from './flight-fixtures.js';
import { step } from './flight-store-contract.js';

const SECRET = 'a-shared-secret-of-32-bytes-long!';
const H = 60 * MIN;

interface Hit {
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
const servers: Server[] = [];
const flights: Flight[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const f of flights.splice(0)) f.stop();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A local receiver: records each request, and answers with `answer` (or never, when it returns false). */
async function receiver(answer: (hit: Hit, n: number, res: ServerResponse) => boolean | void = () => {}) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const hit = { url: req.url || '', headers: req.headers, body };
      hits.push(hit);
      if (answer(hit, hits.length, res) === false) return;
      if (!res.headersSent) res.writeHead(200).end('ok');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server };
}

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'reins-sinks-'));
  dirs.push(d);
  return d;
};

const finding = (over: Partial<FlightFinding> = {}): FlightFinding => ({
  key: 'basic:error-share',
  kind: 'basic',
  level: 'warn',
  text: '10% of requests failed.',
  count: 4,
  firstAt: 1,
  lastAt: 2,
  state: 'open',
  ...over,
});
const note = (over: Partial<Notification> = {}): Notification => ({ type: 'opened', service: 'api', at: new Date(0).toISOString(), text: '[api] Opened, basic warn: 10% of requests failed.', finding: finding(), ...over });

/** A started flight with a memory store, the checker run by hand, and the given sinks. */
function started(sinks: unknown[], o: Record<string, unknown> = {}): { f: Flight; store: FlightStore } {
  const store = (o.store as FlightStore) || memoryStore();
  const f = createFlight({});
  flights.push(f);
  expect(f.start({ store, sinks: sinks as any, checkEveryMs: 0, flushMs: 10_000, instance: 'srv', notify: { daily: false, ...((o.notify as object) || {}) }, ...o })).toBe(true);
  return { f, store };
}
const collect = () => {
  const got: Notification[] = [];
  return { got, sink: (n: Notification) => void got.push(n) };
};
/** A minute of instance `a` now, with `errors` failed of `count` requests. */
const errors = (store: FlightStore, count: number, failed: number, at = Date.now()) => store.putMinute(im('a', at, { requests: [['GET', '/api/x', fig(count, failed)]] }));
async function checkAndDeliver(f: Flight) {
  const r = await f.checkNow();
  await f.sinksIdle();
  return r;
}

describe('B8: the webhook sink', () => {
  it('sends a JSON POST with a plain text field and the finding fields, signed with the secret and a timestamp', async () => {
    const rx = await receiver();
    const { f, store } = started([webhookSink({ url: `${rx.url}/hook`, secret: SECRET })]);
    await errors(store, 40, 4);
    await checkAndDeliver(f);
    expect(rx.hits).toHaveLength(1);
    const [hit] = rx.hits;
    expect(hit.url).toBe('/hook');
    expect(hit.headers['content-type']).toBe('application/json');
    const body = JSON.parse(hit.body);
    expect(body.text).toBe('[server] Opened, basic error: 10% of requests failed in the last 5 min (4 of 40), over the limit of 5%.');
    expect(body.finding).toMatchObject({ key: 'basic:error-share', kind: 'basic', level: 'error', count: 4, state: 'open' });
    expect(body.finding.firstAt).toBeTypeOf('number');
    // Standard Webhooks: v1 and base64 HMAC-SHA256 over id.timestamp.body.
    const id = hit.headers['webhook-id'] as string;
    const ts = Number(hit.headers['webhook-timestamp']);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(60);
    const want = createHmac('sha256', Buffer.from(SECRET)).update(`${id}.${ts}.${hit.body}`).digest('base64');
    expect(hit.headers['webhook-signature']).toBe(`v1,${want}`);
    // Flight's own delivery is not one of the app's upstream calls.
    const rec = f.recorder()!;
    expect([...rec.upstream(), ...rec.summaries().flatMap((m) => m.upstream)]).toEqual([]);
  });

  it('goes to https only, except localhost', async () => {
    for (const u of ['https://hooks.example.com/x', 'http://localhost:3000/x', 'http://127.0.0.1:9/x', 'http://[::1]:9/x']) expect(webhookUrl(u), u).not.toBeNull();
    for (const u of ['http://hooks.example.com/x', 'http://10.0.0.5/x', 'ftp://localhost/x', 'file:///etc/passwd', 'javascript:alert(1)', '', 'not a url']) expect(webhookUrl(u), u).toBeNull();
    await expect(webhookSink({ url: 'http://hooks.example.com/x', secret: SECRET }).send(note())).rejects.toMatchObject({ reason: 'config' });
    // A secret outside 24 to 64 bytes is refused the same way.
    await expect(webhookSink({ url: 'https://hooks.example.com/x', secret: 'short' }).send(note())).rejects.toMatchObject({ reason: 'config' });
  });

  it('follows no redirect', async () => {
    const elsewhere = await receiver();
    const rx = await receiver((_, __, res) => void res.writeHead(302, { location: `${elsewhere.url}/stolen` }).end());
    await expect(webhookSink({ url: rx.url, secret: SECRET, backoffMs: 10 }).send(note())).rejects.toMatchObject({ reason: 'redirect-302' });
    expect(rx.hits).toHaveLength(1);
    expect(elsewhere.hits).toHaveLength(0);
  });

  it('has a time limit', async () => {
    const rx = await receiver(() => false);
    const t0 = Date.now();
    await expect(webhookSink({ url: rx.url, secret: SECRET, timeoutMs: 200, retries: 0 }).send(note())).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('caps the body size', async () => {
    const rx = await receiver();
    const big = note({ text: 'x'.repeat(50_000), finding: finding({ text: 'y'.repeat(50_000) }) });
    await webhookSink({ url: rx.url, secret: SECRET, maxBytes: 2000 }).send(big);
    expect(Buffer.byteLength(rx.hits[0].body)).toBeLessThanOrEqual(2000);
    expect(JSON.parse(rx.hits[0].body).type).toBe('opened');
    const digest = note({ type: 'digest', finding: undefined, findings: Array.from({ length: 200 }, (_, i) => finding({ key: `k${i}` })) });
    expect(Buffer.byteLength(fitBody(digest, 5000))).toBeLessThanOrEqual(5000);
  });

  it('retries a bounded number of times with back-off, and not a refusal', async () => {
    const down = await receiver((_, __, res) => void res.writeHead(500).end());
    await expect(webhookSink({ url: down.url, secret: SECRET, retries: 2, backoffMs: 10 }).send(note())).rejects.toMatchObject({ reason: 'status-500' });
    expect(down.hits).toHaveLength(3);
    // One message id across the attempts, so the receiver can tell a retry from a new message.
    expect(new Set(down.hits.map((h) => h.headers['webhook-id'])).size).toBe(1);

    const flaky = await receiver((_, n, res) => void (n === 1 ? res.writeHead(503).end() : undefined));
    await webhookSink({ url: flaky.url, secret: SECRET, retries: 3, backoffMs: 10 }).send(note());
    expect(flaky.hits).toHaveLength(2);

    const refuses = await receiver((_, __, res) => void res.writeHead(400).end());
    await expect(webhookSink({ url: refuses.url, secret: SECRET, retries: 3, backoffMs: 10 }).send(note())).rejects.toMatchObject({ reason: 'status-400' });
    expect(refuses.hits).toHaveLength(1);
  });

  it('does not block a request or the checker', async () => {
    const hang = await receiver(() => false);
    const { f, store } = started([webhookSink({ url: hang.url, secret: SECRET, timeoutMs: 5000 })]);
    const app = createServer(f.wrapHandler((_req: IncomingMessage, res: ServerResponse) => res.end('hi')));
    servers.push(app);
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    await errors(store, 40, 4);
    const t0 = Date.now();
    await f.checkNow();
    const res = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/`);
    expect(await res.text()).toBe('hi');
    expect(Date.now() - t0).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(hang.hits).toHaveLength(1);
  });
});

describe('B9: the file and function sinks', () => {
  it('the file sink writes one JSON line per notification under .reins/flight by default', async () => {
    const dir = tmp();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const sink = fileSink();
      await sink.send(note());
      await sink.send(note({ type: 'resolved' }));
    } finally {
      process.chdir(cwd);
    }
    const lines = readFileSync(join(dir, '.reins', 'flight', 'notifications.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['opened', 'resolved']);
    expect(existsSync(join(dir, '.reins', '.gitignore'))).toBe(true);
  });

  it('the function sink hands the finding to the app', async () => {
    const c = collect();
    const { f, store } = started([functionSink(c.sink, { name: 'app' })]);
    await errors(store, 40, 4);
    await checkAndDeliver(f);
    expect(c.got.map((n) => [n.type, n.finding?.key])).toEqual([['opened', 'basic:error-share']]);
  });

  it('a sink that throws does not stop the checker or the other sinks', async () => {
    const c = collect();
    const dir = tmp();
    const { f, store } = started([
      () => {
        throw new Error('boom');
      },
      async () => {
        throw new Error('later boom');
      },
      { name: 'odd', send: () => new Promise(() => {}), timeoutMs: 50 },
      c.sink,
      fileSink({ dir }),
    ]);
    await errors(store, 40, 4);
    expect(await checkAndDeliver(f)).not.toBeNull();
    expect(c.got).toHaveLength(1);
    expect(readFileSync(join(dir, 'notifications.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    await errors(store, 40, 0, Date.now() - MIN);
    await store.putMinute(im('a', Date.now(), { requests: [['GET', '/api/x', fig(2000, 0)]] }));
    expect(await checkAndDeliver(f)).not.toBeNull();
    expect(c.got.map((n) => n.type)).toEqual(['opened', 'resolved']);
  });
});

describe('B10: when a sink is told', () => {
  it('when a finding opens, changes level or resolves, not once per occurrence', async () => {
    const c = collect();
    const { f, store } = started([c.sink]);
    const at = Date.now();
    await errors(store, 40, 3, at);
    for (let i = 0; i < 3; i++) await checkAndDeliver(f);
    expect(c.got.map((n) => n.type)).toEqual(['opened']);
    await errors(store, 40, 10, at);
    await checkAndDeliver(f);
    await checkAndDeliver(f);
    expect(c.got.map((n) => [n.type, n.finding?.level, n.from])).toEqual([
      ['opened', 'warn', undefined],
      ['changed', 'error', 'warn'],
    ]);
    await errors(store, 4000, 10, at);
    await checkAndDeliver(f);
    await checkAndDeliver(f);
    expect(c.got.map((n) => n.type)).toEqual(['opened', 'changed', 'resolved']);
  });

  it('past 5 notifications an hour, one digest', () => {
    const n = createNotifier([{ name: 'chat', send: () => {} }]);
    const hour = Date.UTC(2026, 10, 14, 10);
    const changes: Change[] = Array.from({ length: 8 }, (_, i) => ({ event: 'opened', finding: finding({ key: `basic:slow-route:GET /r${i}`, text: `Route ${i} is slow.` }) }));
    const one = n.plan(changes, undefined, hour + 5 * MIN, 'api');
    expect(one.deliveries.map((d) => d.n.type)).toEqual(['opened', 'opened', 'opened', 'opened', 'opened']);
    const more = n.plan(changes.slice(0, 2), one.state, hour + 50 * MIN, 'api');
    expect(more.deliveries).toEqual([]);
    const next = n.plan([], more.state, hour + 65 * MIN, 'api');
    expect(next.deliveries).toHaveLength(1);
    const d = next.deliveries[0].n;
    expect(d).toMatchObject({ type: 'digest', held: 5 });
    expect(d.findings).toHaveLength(5);
    expect(d.text).toMatch(/^\[api\] 5 more notifications were held back in the last hour \(at most 5 an hour\):\n- Opened: Route 5 is slow\./);
    // The new hour starts its own count.
    expect(n.plan(changes.slice(0, 3), next.state, hour + 66 * MIN, 'api').deliveries).toHaveLength(3);
  });

  it('a daily summary by default, after the hour set', () => {
    const n = createNotifier([{ name: 'chat', send: () => {} }]);
    const day = Date.UTC(2026, 10, 14);
    const summary = () => ({ findings: [finding()], checked: { promises: { held: 3, broken: 1, notChecked: 0 }, probes: { held: 1, broken: 0, notChecked: 0 }, open: { blind: 0, basic: 1, broken: 0, drifting: 0, unusual: 0 }, notChecked: [] } });
    const first = n.plan([], undefined, day + 7 * H, 'api', summary);
    expect(first.deliveries).toEqual([]);
    expect(n.plan([], first.state, day + 7.5 * H, 'api', summary).deliveries).toEqual([]);
    const due = n.plan([], first.state, day + 8 * H + MIN, 'api', summary);
    expect(due.deliveries.map((d) => d.n.type)).toEqual(['summary']);
    expect(due.deliveries[0].n.text).toMatch(/^\[api\] Daily summary: 1 open \(1 basic\)\. Checked 4 promises \(1 broken\), 1 probes and the basics over all instances\./);
    expect(n.plan([], due.state, day + 20 * H, 'api', summary).deliveries).toEqual([]);
    expect(n.plan([], due.state, day + 32 * H + MIN, 'api', summary).deliveries.map((d) => d.n.type)).toEqual(['summary']);
    const off = createNotifier([{ name: 'chat', send: () => {} }], { daily: false });
    expect(off.plan([], first.state, day + 9 * H, 'api', summary).deliveries).toEqual([]);
  });

  it('with two instances on one store, a finding is notified once', async () => {
    const store = memoryStore();
    const a = collect();
    const b = collect();
    const one = started([a.sink], { store, instance: 'one' }).f;
    const two = started([b.sink], { store, instance: 'two' }).f;
    await errors(store, 40, 4);
    for (let i = 0; i < 3; i++) {
      await checkAndDeliver(one);
      await checkAndDeliver(two);
    }
    // The first instance stops and gives the lock up; the second takes over and reads what was told.
    one.stop();
    await new Promise((r) => setTimeout(r, 20));
    await checkAndDeliver(two);
    await store.putMinute(im('a', Date.now(), { requests: [['GET', '/api/x', fig(4000, 0)]] }));
    await checkAndDeliver(two);
    const all = [...a.got, ...b.got].map((n) => `${n.type} ${n.finding?.key}`);
    expect(all).toEqual(['opened basic:error-share', 'resolved basic:error-share']);
  });
});

describe('B11: what sinks and the store never get', () => {
  const manifest = {
    schema: 1,
    service: 'invoice-api',
    processes: [{ name: 'payout', key: 'the payout id', steps: ['ledger.debited'], ends: ['ledger.debited'], promises: [{ id: 'one-debit', kind: 'once', step: 'ledger.debited' }] }],
    basics: { minRequests: 1, minCalls: 1, errorShare: 0 },
  };
  it('uses a valid manifest', () => expect(validateManifest(manifest).ok).toBe(true));

  it('counts and not process keys, unless the app opts a sink in', async () => {
    const plain = collect();
    const keyed = collect();
    const dir = tmp();
    const { f, store } = started([plain.sink, functionSink(keyed.sink, { name: 'keyed', keys: true }), fileSink({ dir })], { manifest });
    await store.addSteps([step('payout-7731', 'ledger.debited', Date.now() - 2000), step('payout-7731', 'ledger.debited', Date.now() - 1000)]);
    await checkAndDeliver(f);
    const told = plain.got.find((n) => n.finding?.key === 'promise:payout:one-debit')!;
    expect(told.finding).toMatchObject({ count: 1, kind: 'broken' });
    expect(JSON.stringify(plain.got)).not.toContain('payout-7731');
    expect(readFileSync(join(dir, 'notifications.jsonl'), 'utf8')).not.toContain('payout-7731');
    expect(keyed.got.find((n) => n.finding?.key === 'promise:payout:one-debit')!.finding!.keys).toEqual(['payout-7731']);
    // The keys stay server-side: in the store's finding, for the report.
    expect(JSON.stringify(await store.findings())).toContain('payout-7731');
  });

  it('secrets fed through a header, a path, a query string and an error message reach no sink and not the store', async () => {
    const got = collect();
    const dir = tmp();
    const { f, store } = started([got.sink, fileSink({ dir }), functionSink(got.sink, { name: 'keyed', keys: true })], { manifest });
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const app = createServer(
      f.wrapHandler(async (_req: IncomingMessage, res: ServerResponse) => {
        try {
          f.span('db.query', () => {
            throw new Error('password=SECRET-IN-MESSAGE');
          });
        } catch {}
        await fetch(`http://127.0.0.1:${closedPort}/SECRET-IN-UPSTREAM-PATH?key=SECRET-IN-UPSTREAM-QUERY`, { headers: { authorization: 'SECRET-IN-UPSTREAM-HEADER' } }).catch(() => {});
        res.writeHead(500).end('no');
      }),
    );
    servers.push(app);
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    for (let i = 0; i < 3; i++) await fetch(`${base}/users/SECRET-IN-PATH?token=SECRET-IN-QUERY`, { headers: { authorization: 'Bearer SECRET-IN-HEADER', cookie: 'sid=SECRET-IN-COOKIE' } });
    await f.flush();
    await checkAndDeliver(f);
    const keys = got.got.map((n) => n.finding?.key);
    expect(keys).toContain('basic:error-share');
    expect(keys).toContain('unusual:code:ECONNREFUSED');
    const dump = JSON.stringify({
      sinks: got.got,
      file: readFileSync(join(dir, 'notifications.jsonl'), 'utf8'),
      findings: await store.findings(),
      minutes: await store.minutes(0),
      probes: await store.probes(),
      steps: await store.runSteps('payout', 0),
      report: f.findings(),
    });
    expect(dump).not.toMatch(/SECRET/);
  });
});

describe('B12: security findings and a failing sink', () => {
  it('a sink that keeps failing gives a blind finding on the other sinks', async () => {
    const good = collect();
    const bad: Notification[] = [];
    const { f, store } = started(
      [
        {
          name: 'bad',
          send: (n: Notification) => {
            bad.push(n);
            throw new SinkError('status-500');
          },
        },
        good.sink,
      ],
      { notify: { failures: 2 } },
    );
    const at = Date.now();
    await errors(store, 40, 3, at);
    await checkAndDeliver(f);
    await errors(store, 40, 10, at);
    await checkAndDeliver(f);
    expect(bad).toHaveLength(2);
    await checkAndDeliver(f);
    const told = good.got.find((n) => n.finding?.key === 'blind:sink:bad')!;
    expect(told).toMatchObject({ type: 'opened', finding: { kind: 'blind', count: 2 } });
    expect(told.text).toBe('[server] Opened, blind warn: Sink bad has failed its last 2 deliveries (status-500), so findings may not reach it.');
    expect(bad.some((n) => n.finding?.key === 'blind:sink:bad')).toBe(false);
    expect(f.findings().find((x) => x.key === 'blind:sink:bad')!.state).toBe('open');
  });

  it('a spike of refused responses and the development module loaded in production are tagged security', async () => {
    const c = collect();
    const store = memoryStore();
    const f = createFlight({ NODE_ENV: 'production' });
    flights.push(f);
    f.start({ store, sinks: [c.sink], checkEveryMs: 0, instance: 'srv', notify: { daily: false } });
    markDevModule();
    await store.putMinute(im('a', Date.now(), { requests: [['POST', '/login', fig(40, 0, 20, { '401': 40 })]] }));
    await f.flush();
    await checkAndDeliver(f);
    const tagged = c.got.filter((n) => n.finding?.tags?.includes('security')).map((n) => n.finding!.key).sort();
    expect(tagged).toEqual(['basic:refused', 'security:dev-module']);
  });
});

describe("round 2: the critics' findings on sinks and the notifier", () => {
  it('H1: makes names unique within 40 characters, even for two sinks named with 40 characters', () => {
    const name = 'a'.repeat(40);
    const out = normaliseSinks([{ name, send() {} }, { name, send() {} }, { name: 'bad name!', send() {} }, { name: 'sink-3', send() {} }]);
    expect(out.map((s) => s.name)).toEqual([name, `${'a'.repeat(38)}-2`, 'sink-3', 'sink-3-2']);
    for (const s of out) expect(s.name).toMatch(/^[A-Za-z0-9._-]{1,40}$/);
  });

  it('S1: a hung sink has one call in flight at most; later notifications are skipped and counted, and pending says so', async () => {
    let calls = 0;
    const n = createNotifier([functionSink(() => (calls++, new Promise(() => {})), { timeoutMs: 50 })], { daily: false, perHour: 1000 });
    const ch = (i: number): Change => ({ event: 'opened', finding: finding({ key: `basic:slow-route:GET /r${i}` }) });
    for (let round = 0; round < 3; round++) n.dispatch(n.plan([0, 1, 2, 3, 4].map((i) => ch(round * 10 + i)), undefined, Date.now(), 'api').deliveries);
    await n.idle();
    expect(calls).toBe(1);
    expect(n.stats()).toEqual({ sent: 0, failed: 15, skipped: 14, pending: 1 });
    expect(n.health()[0].text).toBe('Sink function has failed its last 15 deliveries (busy), so findings may not reach it.');
  });

  it('L1: the last cut of a body counts bytes, not characters', () => {
    const big = note({ text: '€'.repeat(30000), finding: finding({ text: '€'.repeat(30000) }) });
    for (const max of [1000, 2000, 20000]) expect(Buffer.byteLength(fitBody(big, max)), String(max)).toBeLessThanOrEqual(max);
    const emoji = note({ type: 'digest', text: '\u{1F600}'.repeat(20000), finding: undefined });
    const body = fitBody(emoji, 20000);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(20000);
    expect(JSON.parse(body).text).not.toMatch(/[\ud800-\udbff]$/);
  });

  it('L2: a sink time limit out of range is clamped, never fired at once', async () => {
    const slow = () => new Promise((r) => setTimeout(r, 30));
    const n = createNotifier([{ name: 'big', timeoutMs: 2 ** 31, send: slow }, { name: 'inf', timeoutMs: Infinity, send: slow }], { daily: false });
    n.dispatch(n.plan([{ event: 'opened', finding: finding() }], undefined, Date.now(), 'api').deliveries);
    await n.idle();
    expect(n.stats()).toMatchObject({ sent: 2, failed: 0 });
  });

  it('N1: a sink time limit under the 100 ms floor is raised to it', async () => {
    const n = createNotifier([{ name: 'quick', timeoutMs: 1, send: () => new Promise((r) => setTimeout(r, 30)) }], { daily: false });
    n.dispatch(n.plan([{ event: 'opened', finding: finding() }], undefined, Date.now(), 'api').deliveries);
    await n.idle();
    expect(n.stats()).toMatchObject({ sent: 1, failed: 0 });
  });

  it('N1, S3 and S4: tags are copied, file names "." and ".." are refused, only a folder named .reins gets a .gitignore, one failure is singular', async () => {
    const f = finding({ tags: ['security'] });
    expect(sinkView(f).tags).toEqual(['security']);
    expect(sinkView(f).tags).not.toBe(f.tags);
    const dir = tmp();
    for (const file of ['.', '..']) await fileSink({ dir: join(dir, 'not.reins', 'flight'), file }).send(note());
    expect(readFileSync(join(dir, 'not.reins', 'flight', 'notifications.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(existsSync(join(dir, 'not.reins', '.gitignore'))).toBe(false);
    const n = createNotifier([{ name: 'bad', send: () => Promise.reject(new SinkError('status-500')) }], { daily: false, failures: 1 });
    n.dispatch(n.plan([{ event: 'opened', finding: finding() }], undefined, Date.now(), 'api').deliveries);
    await n.idle();
    expect(n.health()[0].text).toBe('Sink bad has failed its last delivery (status-500), so findings may not reach it.');
  });
});

describe("round 2: the critics' findings on store outages", () => {
  /** A store that can go down (every call rejects), whose lock `takeover` takes as if the holder's lease ran out, and whose findings write can be slow. */
  function flaky(base: FlightStore = memoryStore()) {
    const ctl = { down: false, takeover: '', slowWrite: 0, fail: '' };
    const store = new Proxy(base, {
      get(t, k) {
        const v = (t as any)[k];
        if (typeof v !== 'function') return v;
        return async (...a: unknown[]) => {
          if (ctl.down || ctl.fail === k) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
          if (k === 'lock' && ctl.takeover && String(a[0]).startsWith(ctl.takeover)) a = [a[0], a[1], Date.now() + 10 * MIN];
          if (k === 'putFindings' && ctl.slowWrite) await new Promise((r) => setTimeout(r, ctl.slowWrite));
          return v.apply(t, a);
        };
      },
    }) as FlightStore;
    return { store, ctl };
  }
  const told = () => {
    const got: string[] = [];
    return { got, as: (inst: string) => (n: Notification) => void got.push(`${inst}: ${n.type} ${n.finding?.key}`) };
  };

  it('M2: an outage told by one instance is resolved once by the instance that next holds the lock', async () => {
    const { store, ctl } = flaky();
    const t = told();
    const one = started([t.as('one')], { store, instance: 'one' }).f;
    const two = started([t.as('two')], { store, instance: 'two' }).f;
    await checkAndDeliver(one);
    await checkAndDeliver(two);
    ctl.down = true;
    await checkAndDeliver(one);
    await checkAndDeliver(two);
    await checkAndDeliver(one);
    ctl.down = false;
    ctl.takeover = 'two-';
    for (let i = 0; i < 3; i++) {
      await checkAndDeliver(two);
      await checkAndDeliver(one);
    }
    expect(t.got).toEqual(['one: opened blind:lock-unavailable', 'two: resolved blind:lock-unavailable']);
  });

  /** A clock the test moves on: flight, the store's lock and the findings all read Date.now. */
  function clock() {
    const c = { now: Date.UTC(2026, 10, 14, 12, 0, 30) };
    vi.spyOn(Date, 'now').mockImplementation(() => c.now);
    onTestFinished(() => void vi.restoreAllMocks());
    return c;
  }
  /** One round: each server runs a pass and delivers, then the clock moves on a minute (one period). */
  async function round(c: { now: number }, ...fs: Flight[]) {
    for (const f of fs) await checkAndDeliver(f);
    c.now += MIN;
  }

  it('H1: one server whose store is down from boot tells the outage once it has lasted the lock lease, and its end', async () => {
    const c = clock();
    const { store, ctl } = flaky();
    ctl.down = true;
    const t = told();
    const { f } = started([t.as('srv')], { store });
    for (let i = 0; i < 3; i++) await round(c, f);
    // Two minutes in: shorter than the lease (three periods of at least a minute), so a holder could still tell it.
    expect(t.got).toEqual([]);
    expect(f.findings().find((x) => x.key === 'blind:lock-unavailable')?.state).toBe('open');
    for (let i = 0; i < 3; i++) await round(c, f);
    expect(t.got).toEqual(['srv: opened blind:lock-unavailable']);
    ctl.down = false;
    for (let i = 0; i < 3; i++) await round(c, f);
    expect(t.got).toEqual(['srv: opened blind:lock-unavailable', 'srv: resolved blind:lock-unavailable']);
  });

  it('H1: two servers whose store is down from boot each tell the outage at most once, and its end is told once', async () => {
    const c = clock();
    const { store, ctl } = flaky();
    ctl.down = true;
    const t = told();
    const one = started([t.as('one')], { store, instance: 'one' }).f;
    const two = started([t.as('two')], { store, instance: 'two' }).f;
    for (let i = 0; i < 6; i++) await round(c, one, two);
    ctl.down = false;
    for (let i = 0; i < 4; i++) await round(c, one, two);
    expect(t.got).toEqual(['one: opened blind:lock-unavailable', 'two: opened blind:lock-unavailable', 'one: resolved blind:lock-unavailable']);
    expect((await store.findings()).find((x) => x.key === 'blind:lock-unavailable')?.state).toBe('resolved');
  });

  it('H1: a store that comes back before the lease has run tells nothing, and no unpaired "resolved"', async () => {
    const c = clock();
    const { store, ctl } = flaky();
    ctl.down = true;
    const t = told();
    const one = started([t.as('one')], { store, instance: 'one' }).f;
    const two = started([t.as('two')], { store, instance: 'two' }).f;
    for (let i = 0; i < 2; i++) await round(c, one, two);
    ctl.down = false;
    for (let i = 0; i < 4; i++) await round(c, one, two);
    expect(t.got).toEqual([]);
  });

  it('L2 and L3: a server that told an outage hands it over to the holder, and a failed hand-over is not a lock failure', async () => {
    const c = clock();
    const base = memoryStore();
    const a = flaky(base);
    const b = flaky(base);
    const t = told();
    const one = started([t.as('one')], { store: a.store, instance: 'one' }).f;
    const two = started([t.as('two')], { store: b.store, instance: 'two' }).f;
    await checkAndDeliver(one);
    b.ctl.down = true;
    for (let i = 0; i < 4; i++) await round(c, one, two);
    expect(t.got).toEqual(['two: opened blind:lock-unavailable']);
    b.ctl.down = false;
    b.ctl.fail = 'findings';
    expect(await two.checkNow()).toBeNull();
    b.ctl.fail = '';
    for (let i = 0; i < 2; i++) await round(c, two, one);
    expect(t.got).toEqual(['two: opened blind:lock-unavailable', 'one: resolved blind:lock-unavailable']);
  });

  it('M1: after a time-out, the late findings write tells only what the time-out step had not told', async () => {
    const { store, ctl } = flaky();
    const t = told();
    const bad = { name: 'bad', send: () => Promise.reject(new SinkError('status-500')) };
    const { f } = started([bad, t.as('srv')], { store, checkTimeoutMs: 200, notify: { failures: 1 }, manifest: { schema: 1, service: 'x', processes: 'not a list' } });
    await checkAndDeliver(f);
    expect(t.got).toEqual(['srv: opened blind:manifest-invalid']);
    ctl.slowWrite = 400;
    await f.checkNow();
    await new Promise((r) => setTimeout(r, 700));
    await f.sinksIdle();
    ctl.slowWrite = 0;
    await checkAndDeliver(f);
    expect(t.got.filter((x) => x.includes('blind:sink:bad'))).toEqual(['srv: opened blind:sink:bad']);
  });

  it('L1: a late findings write tells nothing when another server holds the lock by then', async () => {
    const base = memoryStore();
    const a = flaky(base);
    const b = flaky(base);
    b.ctl.takeover = 'B-';
    const t = told();
    const A = started([t.as('A')], { store: a.store, instance: 'A', checkTimeoutMs: 200 }).f;
    const B = started([t.as('B')], { store: b.store, instance: 'B' }).f;
    await checkAndDeliver(A);
    await errors(base, 40, 10);
    a.ctl.slowWrite = 500;
    expect((await A.checkNow())?.blind.map((x) => x.kind)).toEqual(['store-unreachable']);
    await checkAndDeliver(B);
    await new Promise((r) => setTimeout(r, 700));
    await A.sinksIdle();
    expect(t.got.filter((x) => x.includes('basic:error-share'))).toEqual(['B: opened basic:error-share']);
  });

  it('L4: a findings write that lands after stop() tells no sink', async () => {
    const { store, ctl } = flaky();
    const t = told();
    const { f } = started([t.as('srv')], { store });
    await errors(store, 40, 10);
    ctl.slowWrite = 300;
    const p = f.checkNow();
    await new Promise((r) => setTimeout(r, 100));
    f.stop();
    await p;
    await new Promise((r) => setTimeout(r, 400));
    expect(t.got).toEqual([]);
  });

  it('M3: a pass whose findings write outlives the time limit still tells what it wrote, once', async () => {
    const { store, ctl } = flaky();
    const t = told();
    const { f } = started([t.as('srv')], { store, checkTimeoutMs: 200 });
    await errors(store, 40, 10);
    ctl.slowWrite = 400;
    await f.checkNow();
    await new Promise((r) => setTimeout(r, 600));
    ctl.slowWrite = 0;
    for (let i = 0; i < 3; i++) await checkAndDeliver(f);
    expect(t.got.filter((x) => x.includes('basic:error-share'))).toEqual(['srv: opened basic:error-share']);
    expect(t.got.filter((x) => x.includes('blind:store-unreachable'))).toEqual(['srv: opened blind:store-unreachable', 'srv: resolved blind:store-unreachable']);
    expect(f.findings().find((x) => x.key === 'basic:error-share')?.state).toBe('open');
  });

  it.each([
    ['', false],
    [', even with every pass in the same millisecond', true],
  ])('M5: a finding that resolved during an outage is not resolved and told again after it%s', async (_, frozen) => {
    if (frozen) vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 14, 12, 0, 30));
    onTestFinished(() => void vi.restoreAllMocks());
    const { store, ctl } = flaky();
    const good = told();
    let failing = true;
    const bad = { name: 'bad', send: () => (failing ? Promise.reject(new SinkError('status-500')) : undefined) };
    const { f } = started([bad, good.as('srv')], { store, notify: { failures: 1 } });
    await errors(store, 40, 10);
    await checkAndDeliver(f);
    await checkAndDeliver(f);
    expect(good.got).toContain('srv: opened blind:sink:bad');
    failing = false;
    ctl.down = true;
    await checkAndDeliver(f);
    await checkAndDeliver(f);
    ctl.down = false;
    for (let i = 0; i < 3; i++) await checkAndDeliver(f);
    expect(good.got.filter((x) => x.includes('blind:sink:bad'))).toEqual(['srv: opened blind:sink:bad', 'srv: resolved blind:sink:bad']);
    expect((await store.findings()).find((x) => x.key === 'blind:sink:bad')?.state).toBe('resolved');
  });
});

describe('round 4: one rule on the store-outage path', () => {
  /** How one server reaches a shared store this period. */
  type Mode = 'ok' | 'refused' | 'lock-refused' | 'slow-lock' | 'slow-lock-refused' | 'slow-read' | 'slow-write' | 'slow-check' | 'hung';
  const fail = () => Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
  /**
   * One server's way to a shared store: refused, slow (twice `slowMs`) at the lock, the findings read, the
   * findings write or the check's reads, or hung until it recovers (`release`). `takeover` takes the lock as if
   * the holder's lease ran out; `failLockAfterWrite` refuses the next lock call after a findings write.
   */
  function way(base: FlightStore, slowMs: number) {
    const ctl = { mode: 'ok' as Mode, takeover: false, failLockAfterWrite: false };
    const waiting: Array<() => void> = [];
    let lockFails = false;
    const store = new Proxy(base, {
      get(t, k) {
        const v = (t as any)[k];
        if (typeof v !== 'function') return v;
        return async (...a: unknown[]) => {
          const m = ctl.mode;
          if (m === 'refused' || (m === 'lock-refused' && k === 'lock')) throw fail();
          if (k === 'lock' && lockFails) {
            lockFails = false;
            throw fail();
          }
          if (m === 'hung') await new Promise<void>((r) => waiting.push(r));
          if (m === 'slow-lock-refused' && k === 'lock') {
            await new Promise((r) => setTimeout(r, 2 * slowMs));
            throw fail();
          }
          const slow = (m === 'slow-lock' && k === 'lock') || (m === 'slow-read' && k === 'findings') || (m === 'slow-write' && k === 'putFindings') || (m === 'slow-check' && k === 'minutes');
          if (slow) await new Promise((r) => setTimeout(r, 2 * slowMs));
          if (k === 'lock' && ctl.takeover) a = [a[0], a[1], Date.now() + 10 * MIN];
          const out = await v.apply(t, a);
          if (k === 'putFindings' && ctl.failLockAfterWrite) lockFails = true;
          return out;
        };
      },
    }) as FlightStore;
    return { store, ctl, release: () => waiting.splice(0).forEach((r) => r()) };
  }
  interface Told {
    inst: string;
    type: Notification['type'];
    key?: string;
    at: number;
  }
  const record = (events: Told[], inst: string) => (n: Notification) => void events.push({ inst, type: n.type, key: n.finding?.key, at: Date.now() });
  /** Fake timers and clock: time-outs, slow calls, the store's lock and the findings all move only when the test moves them. */
  function fakeTime(start = Date.UTC(2026, 10, 14, 12, 0, 30)) {
    vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    onTestFinished(() => void vi.useRealTimers());
  }
  /** One period: every server starts a pass at once, `ms` of time passes, and the passes and deliveries settle. */
  async function period(fs: Flight[], ms = MIN) {
    const passes = fs.map((f) => f.checkNow());
    await vi.advanceTimersByTimeAsync(ms);
    await Promise.all(passes);
    for (const f of fs) await f.sinksIdle();
  }
  const changes = (e: Told[]) => e.filter((x) => x.type === 'opened' || x.type === 'changed' || x.type === 'resolved');

  it('M1: a late pass that resolves the outage its time-out opened clears that entry, so it is not resolved again', async () => {
    fakeTime();
    const w = way(memoryStore(), 200);
    const events: Told[] = [];
    const { f } = started([record(events, 'srv')], { store: w.store, checkTimeoutMs: 200 });
    await period([f]);
    w.ctl.mode = 'slow-read';
    await period([f], 1000);
    w.ctl.mode = 'ok';
    for (let i = 0; i < 3; i++) await period([f]);
    expect(changes(events).map((e) => `${e.type} ${e.key}`)).toEqual(['opened blind:store-unreachable', 'resolved blind:store-unreachable']);
    expect((await w.store.findings()).find((x) => x.key === 'blind:store-unreachable')?.state).toBe('resolved');
  });

  it('M2: a server that never held the lock tells an outage flipping between its two kinds within the hourly limit, then one digest', async () => {
    fakeTime(Date.UTC(2026, 10, 14, 12, 0, 30));
    const w = way(memoryStore(), 100);
    const events: Told[] = [];
    const { f } = started([record(events, 'srv')], { store: w.store, checkTimeoutMs: 100 });
    // The security critic's p7: every pass the store's failure flips between a refused lock and a lock with no answer in time.
    for (let i = 0; i < 60; i++) {
      w.ctl.mode = i % 2 ? 'slow-lock-refused' : 'refused';
      await period([f]);
    }
    expect(changes(events)).toHaveLength(5);
    expect(events.filter((e) => e.type === 'digest')).toHaveLength(0);
    await period([f]);
    expect(events.filter((e) => e.type === 'digest')).toHaveLength(1);
  });

  it('L1: a late findings write still tells what it wrote when the lock check after it fails for a moment', async () => {
    fakeTime();
    const base = memoryStore();
    const w = way(base, 200);
    const events: Told[] = [];
    const { f } = started([record(events, 'srv')], { store: w.store, checkTimeoutMs: 200 });
    await period([f]);
    await errors(base, 40, 10);
    w.ctl.mode = 'slow-write';
    w.ctl.failLockAfterWrite = true;
    await period([f], 1000);
    w.ctl.mode = 'ok';
    w.ctl.failLockAfterWrite = false;
    for (let i = 0; i < 2; i++) await period([f]);
    expect(changes(events).filter((e) => e.key === 'basic:error-share').map((e) => e.type)).toEqual(['opened']);
  });

  it('L3: a server whose store never answers tells the outage one lease after the pass that found it, on 59.999 s periods', async () => {
    fakeTime();
    const w = way(memoryStore(), 1000);
    w.ctl.mode = 'hung';
    const events: Told[] = [];
    const { f } = started([record(events, 'srv')], { store: w.store });
    // The first pass waits the whole 30 s time limit; the passes after it find the store work still hanging.
    for (let i = 0; i < 3; i++) await period([f], 59_999);
    expect(changes(events)).toEqual([]);
    await period([f], 59_999);
    expect(changes(events).map((e) => `${e.type} ${e.key}`)).toEqual(['opened blind:store-unreachable']);
    w.ctl.mode = 'ok';
    w.release();
  });

  it('M2: a notify state merges per sink by the later hour and the higher counts, and only a plan with the summary moves its clock', () => {
    const n = createNotifier([{ name: 'chat', send: () => {} }]);
    const hour = Date.UTC(2026, 10, 14, 10);
    const opened = (i: number): Change => ({ event: 'opened', finding: finding({ key: `basic:slow-route:GET /r${i}` }) });
    // The store says 2 sent this hour; this server told 4 while it could not reach it: 4 count, so one more goes.
    const stored = n.plan([opened(0), opened(1)], undefined, hour + MIN, 'api').state;
    const mine = n.plan([0, 1, 2, 3].map(opened), undefined, hour + 2 * MIN, 'api').state;
    expect(n.plan([opened(4), opened(5)], mergeNotify(stored, mine), hour + 3 * MIN, 'api').deliveries).toHaveLength(1);
    // A later hour wins over an earlier one, with what it held.
    const later = n.plan([], mine, hour + H + MIN, 'api').state;
    expect(mergeNotify(stored, later)!.sinks!.chat.hour).toBe(Math.floor((hour + H) / H));
    // No summary given: the daily clock stays where the plan that sends the summary left it.
    expect(n.plan([], { dailyFrom: hour }, hour + 30 * H, 'api').state.dailyFrom).toBe(hour);
    expect(mergeNotify({ dailyFrom: hour }, n.plan([], undefined, hour + H, 'api').state)!.dailyFrom).toBe(hour);
  });

  /** A small seeded generator, so a failing sequence can be run again. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const MODES: Mode[] = ['ok', 'ok', 'ok', 'refused', 'lock-refused', 'slow-lock', 'slow-lock-refused', 'slow-read', 'slow-write', 'slow-check', 'hung'];
  /** The minute of the sequence a notification came in, for the failure message. */
  const START = Date.UTC(2026, 10, 14, 12, 40, 30);
  const when = (e: Told) => `${Math.round((e.at - START) / MIN)}m `;

  /**
   * The invariants over what the sinks heard; returns the breaches. During an outage two servers may each tell the
   * same opening once (design: a duplicate accepted, so every sink hears of it). So, per finding: a server tells an
   * opening again only after someone told it resolved (`since`: the servers whose opening no one has resolved
   * since); and every "resolved" matches a told opening: the server's own, which it has not told resolved yet
   * (`open`), or one that no one has told resolved since (`since`). A "resolved" covers every opening told before it.
   */
  function breaches(events: Told[], perHour: number, paired: boolean): string[] {
    const out: string[] = [];
    const since = new Map<string, Set<string>>();
    const open = new Map<string, Set<string>>();
    const sent = new Map<string, number>();
    const digests = new Map<string, number>();
    for (const e of events) {
      const hour = `${e.inst}@${Math.floor(e.at / H)}`;
      if (e.type === 'digest') {
        digests.set(hour, (digests.get(hour) || 0) + 1);
        if (digests.get(hour)! > 1) out.push(`${when(e)}${e.inst} got two digests in one hour`);
        continue;
      }
      if (e.type === 'summary') continue;
      sent.set(hour, (sent.get(hour) || 0) + 1);
      if (sent.get(hour)! > perHour) out.push(`${when(e)}${e.inst} told more than ${perHour} in one hour`);
      if (!paired) continue;
      const told = since.get(e.key!) || new Set<string>();
      const still = open.get(e.key!) || new Set<string>();
      since.set(e.key!, told);
      open.set(e.key!, still);
      if (e.type === 'opened') {
        if (told.has(e.inst)) out.push(`${when(e)}${e.inst} told ${e.key} opened twice for one opening`);
        told.add(e.inst);
        still.add(e.inst);
      } else if (!still.has(e.inst) && !told.size) out.push(`${when(e)}${e.inst} told ${e.key} ${e.type} with no told opening`);
      else if (e.type === 'resolved') {
        since.set(e.key!, new Set());
        still.delete(e.inst);
      }
    }
    return out;
  }

  it.each(Array.from({ length: 40 }, (_, i) => [i + 1]))(
    'invariants: two servers on one store through random outages (seed %i): each opening told at most once per server, no unpaired "resolved", at most the hourly limit and one digest an hour',
    async (seed) => {
      for (const perHour of [1000, 5]) {
        fakeTime(Date.UTC(2026, 10, 14, 12, 40, 30));
        const next = rng(seed);
        const base = memoryStore();
        const ways = [way(base, 1000), way(base, 1000)];
        const events: Told[] = [];
        const fs = ['A', 'B'].map((inst, i) => started([record(events, inst)], { store: ways[i].store, instance: inst, checkTimeoutMs: 1000, notify: { perHour } }).f);
        const steps: string[] = [];
        for (let s = 0; s < 70; s++) {
          const settle = s >= 60;
          for (const w of ways) {
            const was = w.ctl.mode;
            // Mostly the same as last period, so outages last; sometimes both servers lose the store together.
            w.ctl.mode = settle ? 'ok' : next() < 0.6 ? was : MODES[Math.floor(next() * MODES.length)];
            if (was === 'hung' && w.ctl.mode !== 'hung') w.release();
          }
          if (!settle && next() < 0.1) for (const w of ways) w.ctl.mode = 'refused';
          if (next() < 0.3) await errors(base, 40, next() < 0.5 ? 10 : 0);
          // The lock moves as when the holder's lease has run out: one server takes it, in a pass of its own before
          // the other server's (a live pass renews its lease as it starts, so no server takes the lock during one).
          const taker = !settle && next() < 0.12 ? Math.floor(next() * 2) : -1;
          steps.push(`${Math.round((Date.now() - START) / MIN)}m ` + ways.map((w, i) => `${w.ctl.mode}${i === taker ? '+takeover' : ''}`).join('/'));
          const ms = MIN * (1 + Math.floor(next() * 2));
          const order = next() < 0.5 ? fs : [...fs].reverse();
          if (taker >= 0) {
            ways[taker].ctl.takeover = true;
            await period([fs[taker]], 3000);
            ways[taker].ctl.takeover = false;
          }
          await period(
            order.filter((_, i) => taker < 0 || order[i] !== fs[taker]),
            ms - (taker >= 0 ? 3000 : 0),
          );
        }
        for (const w of ways) w.release();
        const found = breaches(events, perHour, perHour === 1000);
        expect(found, `seed ${seed}, perHour ${perHour}\nsteps: ${steps.join(', ')}\ntold: ${events.map((e) => `${when(e)} ${e.inst} ${e.type} ${e.key ?? ''}`).join(', ')}`).toEqual([]);
        for (const f of fs) f.stop();
        vi.useRealTimers();
      }
    },
    30_000,
  );
});
