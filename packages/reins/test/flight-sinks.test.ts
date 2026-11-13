// Design section 6, unit u4 behaviours B8 to B12: the webhook, file and function sinks, when a sink is told,
// the hourly limit and digest, the daily summary, one notification with two instances, keys and secrets kept
// out of sinks and the store, and a sink that keeps failing.
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFlight, type Flight } from '../src/flight.js';
import type { Change, FlightFinding } from '../src/flight/findings.js';
import { validateManifest } from '../src/flight/manifest.js';
import { createNotifier, fileSink, fitBody, functionSink, type Notification, SinkError, webhookSink, webhookUrl } from '../src/flight/sinks.js';
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
