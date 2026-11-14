// Design section 6, unit u4 behaviours B8 to B12: the webhook, file and function sinks, when a sink is told,
// the hourly limit and digest, the daily summary, one notification with two instances, keys and secrets kept
// out of sinks and the store, and a sink that keeps failing.
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createFlight, type Flight } from '../src/flight.js';
import { type Change, type FlightFinding, STATE_KEY } from '../src/flight/findings.js';
import { validateManifest } from '../src/flight/manifest.js';
import { createNotifier, fileSink, fitBody, functionSink, normaliseSinks, type Notification, SinkError, sinkView, webhookSink, webhookUrl } from '../src/flight/sinks.js';
import { type FlightStore, memoryStore } from '../src/flight/store.js';
import { markDevModule } from '../src/recorder.js';
import { fig, im, MIN } from './flight-fixtures.js';
import { step } from './flight-store-contract.js';

const SECRET = 'a-shared-secret-of-32-bytes-long!';
/** The findings about a server's own way to the store (B13). */
const STORE_KEYS = new Set(['blind:store-unreachable', 'blind:lock-unavailable']);
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

  it('a manifest file that is not JSON is said in fixed words: none of its text reaches a sink, the store or the finding', async () => {
    const dir = tmp();
    const file = join(dir, 'reins.flight.json');
    writeFileSync(file, 'SECRET=hunter2\n');
    const rx = await receiver();
    const got = collect();
    const { f, store } = started([got.sink, functionSink(got.sink, { name: 'keyed', keys: true }), fileSink({ dir }), webhookSink({ url: rx.url, secret: SECRET })], { manifest: file });
    await checkAndDeliver(f);
    const told = got.got.find((n) => n.finding?.key === 'blind:manifest-invalid')!;
    expect(told.finding!.text).toBe('The manifest is invalid, so no promise or probe is checked (the basics still are): 1 problem, the first at (root): is not valid JSON. Run `npx reins flight check`.');
    expect(rx.hits.length).toBeGreaterThan(0);
    const dump = JSON.stringify({
      sinks: got.got,
      webhook: rx.hits,
      file: readFileSync(join(dir, 'notifications.jsonl'), 'utf8'),
      findings: await store.findings(),
      report: f.findings(),
      manifest: f.manifest(),
    });
    expect(dump).not.toMatch(/hunter2|SECRET=/);
    // `strict: true` throws with the same fixed words.
    expect(() => createFlight({}).start({ store: memoryStore(), manifest: file, strict: true, checkEveryMs: 0 })).toThrow(/^reins flight: the manifest is invalid: \(root\) is not valid JSON$/);
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

describe('B10 and B13: findings about the app once across copies, and each copy its own outage', () => {
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
    const waiting: Array<(failed: boolean) => void> = [];
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
          if (m === 'hung') await new Promise<void>((r, j) => waiting.push((failed) => (failed ? j(fail()) : r())));
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
    // `release(true)`: the hung calls fail at last, as when the connection drops; else they go through.
    return { store, ctl, release: (failed = false) => waiting.splice(0).forEach((r) => r(failed)) };
  }
  interface Told {
    inst: string;
    type: Notification['type'];
    key?: string;
    at: number;
    /** A digest: how many it held, and whether it came from the server's own counter (its outages only). */
    held?: number;
    own?: boolean;
  }
  const record = (events: Told[], inst: string) => (n: Notification) =>
    void events.push({ inst, type: n.type, key: n.finding?.key, at: Date.now(), ...(n.type === 'digest' ? { held: n.held, own: (n.findings || []).every((f) => STORE_KEYS.has(f.key)) } : {}) });
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
  /** What the sinks heard of the servers' own ways to the store. */
  const outageTold = (e: Told[]) => changes(e).filter((x) => STORE_KEYS.has(x.key!)).map((x) => `${x.inst}: ${x.type} ${x.key}`);

  it('M1: a late pass after the time-out that opened this server\'s outage tells nothing more of it; the next live pass says it can see again, once', async () => {
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
    // The outage is this server's own: it is not in the store, and its view shows it resolved.
    expect((await w.store.findings()).some((x) => x.key === 'blind:store-unreachable')).toBe(false);
    expect(f.findings().find((x) => x.key === 'blind:store-unreachable')?.state).toBe('resolved');
  });

  it("M2 (security p7): an outage flipping between its two kinds every pass is one outage, told once each way", async () => {
    fakeTime(Date.UTC(2026, 10, 14, 12, 0, 30));
    const w = way(memoryStore(), 100);
    const events: Told[] = [];
    const { f } = started([record(events, 'srv')], { store: w.store, checkTimeoutMs: 100 });
    for (let i = 0; i < 60; i++) {
      w.ctl.mode = i % 2 ? 'slow-lock-refused' : 'refused';
      await period([f]);
    }
    expect(outageTold(events)).toEqual(['srv: opened blind:lock-unavailable']);
    w.ctl.mode = 'ok';
    for (let i = 0; i < 2; i++) await period([f]);
    expect(outageTold(events)).toEqual(['srv: opened blind:lock-unavailable', 'srv: resolved blind:lock-unavailable']);
    expect(events.filter((e) => e.type === 'digest')).toEqual([]);
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

  const of = (inst: string, e: Told[]) => outageTold(e).filter((x) => x.startsWith(`${inst}:`));
  /** Two servers on one memory store, each with its own way to it; A takes the lock in the first period. */
  async function pair() {
    fakeTime();
    const base = memoryStore();
    const wa = way(base, 1000);
    const wb = way(base, 1000);
    const events: Told[] = [];
    const A = started([record(events, 'A')], { store: wa.store, instance: 'A', checkTimeoutMs: 1000 }).f;
    const B = started([record(events, 'B')], { store: wb.store, instance: 'B', checkTimeoutMs: 1000 }).f;
    await period([A]);
    return { base, wa, wb, events, A, B };
  }

  it('B13: when the store fails, each copy tells once that flight cannot see, and once that it can again; a second outage is told again', async () => {
    const { base, wa, wb, events, A, B } = await pair();
    wa.ctl.mode = wb.ctl.mode = 'refused';
    for (let i = 0; i < 10; i++) await period([A, B]);
    expect(of('A', events)).toEqual(['A: opened blind:lock-unavailable']);
    expect(of('B', events)).toEqual(['B: opened blind:lock-unavailable']);
    wa.ctl.mode = wb.ctl.mode = 'ok';
    for (let i = 0; i < 3; i++) await period([A, B]);
    expect(of('A', events)).toEqual(['A: opened blind:lock-unavailable', 'A: resolved blind:lock-unavailable']);
    expect(of('B', events)).toEqual(['B: opened blind:lock-unavailable', 'B: resolved blind:lock-unavailable']);
    // Neither outage is in the store: each lives in its own copy.
    expect((await base.findings()).filter((x) => STORE_KEYS.has(x.key))).toEqual([]);
    // A second outage, this time with no answer at all, is told again by each copy, and its end too.
    events.length = 0;
    wa.ctl.mode = wb.ctl.mode = 'hung';
    for (let i = 0; i < 4; i++) await period([A, B]);
    wa.ctl.mode = wb.ctl.mode = 'ok';
    wa.release();
    wb.release();
    for (let i = 0; i < 3; i++) await period([A, B]);
    expect(of('A', events)).toEqual(['A: opened blind:store-unreachable', 'A: resolved blind:store-unreachable']);
    expect(of('B', events)).toEqual(['B: opened blind:store-unreachable', 'B: resolved blind:store-unreachable']);
  });

  it('B13: a copy that never held the lock tells its own outage at once and its end, while the holder tells nothing of it', async () => {
    const { wb, events, A, B } = await pair();
    await period([A, B]);
    wb.ctl.mode = 'lock-refused';
    await period([A, B]);
    expect(outageTold(events)).toEqual(['B: opened blind:lock-unavailable']);
    for (let i = 0; i < 6; i++) await period([A, B]);
    wb.ctl.mode = 'ok';
    for (let i = 0; i < 3; i++) await period([A, B]);
    expect(outageTold(events)).toEqual(['B: opened blind:lock-unavailable', 'B: resolved blind:lock-unavailable']);
  });

  it("B13 (round 5 H1): a second outage on one copy's own way to the store, the other the healthy holder, is told", async () => {
    const { wb, events, A, B } = await pair();
    await period([A, B]);
    wb.ctl.mode = 'hung';
    for (let i = 0; i < 5; i++) await period([A, B]);
    wb.ctl.mode = 'refused';
    wb.release(true);
    for (let i = 0; i < 2; i++) await period([A, B]);
    wb.ctl.mode = 'ok';
    for (let i = 0; i < 4; i++) await period([A, B]);
    // One outage, whichever kind each pass met: told once each way, under the kind it was told under.
    expect(outageTold(events)).toEqual(['B: opened blind:store-unreachable', 'B: resolved blind:store-unreachable']);
    events.length = 0;
    wb.ctl.mode = 'hung';
    for (let i = 0; i < 8; i++) await period([A, B]);
    expect(outageTold(events)).toEqual(['B: opened blind:store-unreachable']);
    wb.ctl.mode = 'ok';
    wb.release();
  });

  it("B13: a copy's own outage notifications keep the hourly limit, then one digest", async () => {
    fakeTime(Date.UTC(2026, 10, 14, 12, 0, 30));
    const w = way(memoryStore(), 1000);
    const events: Told[] = [];
    const { f } = started([record(events, 'srv')], { store: w.store, checkTimeoutMs: 1000 });
    // The store goes and comes back every other minute for half an hour: 15 outages, 30 notifications.
    for (let i = 0; i < 30; i++) {
      w.ctl.mode = i % 2 ? 'ok' : 'refused';
      await period([f]);
    }
    // The step writes that failed meanwhile are a finding about the app, on the shared counter: not counted here.
    const own = () => outageTold(events).map((x) => x.split(' ')[1]);
    expect(own()).toEqual(['opened', 'resolved', 'opened', 'resolved', 'opened']);
    expect(events.filter((e) => e.type === 'digest')).toEqual([]);
    w.ctl.mode = 'ok';
    for (let i = 0; i < 40; i++) await period([f]);
    const digests = events.filter((e) => e.type === 'digest' && e.own);
    expect(digests).toHaveLength(1);
    expect(digests[0].held).toBe(25);
    expect(own()).toHaveLength(5);
  });

  it('B10: while the store is reachable, two copies notify a finding about the app once across them, as the lock moves', async () => {
    const { base, wb, events, A, B } = await pair();
    await errors(base, 40, 10);
    for (let i = 0; i < 3; i++) await period([A, B]);
    // B takes the lock, as when A's lease has run out, and the finding resolves on its watch.
    wb.ctl.takeover = true;
    await period([B], 3000);
    wb.ctl.takeover = false;
    for (let i = 0; i < 2; i++) await period([B, A]);
    await errors(base, 4000, 0);
    for (let i = 0; i < 3; i++) await period([A, B]);
    expect(changes(events).map((e) => `${e.inst}: ${e.type} ${e.key}`)).toEqual(['A: opened basic:error-share', 'B: resolved basic:error-share']);
  });

  it('M2: only a plan with the summary moves the daily clock', () => {
    const n = createNotifier([{ name: 'chat', send: () => {} }]);
    const hour = Date.UTC(2026, 10, 14, 10);
    expect(n.plan([], { dailyFrom: hour }, hour + 30 * H, 'api').state.dailyFrom).toBe(hour);
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
   * The invariants over what the sinks heard; returns the breaches. Findings about the app are told once across the
   * servers (B10): an opening is told again only after it was told resolved, and a "changed" or "resolved" follows a
   * told opening. Findings about a server's own way to the store are that server's own (B13): per server, "cannot
   * see" and "can see again" alternate, once each per outage, under one key. Counted per hour: the findings about the
   * app on the store's shared counter (both servers' sinks share one name), each server's outages on its own; at
   * most the hourly limit and one digest an hour on each.
   */
  function breaches(events: Told[], perHour: number, paired: boolean): string[] {
    const out: string[] = [];
    const appOpen = new Set<string>();
    const ownOpen = new Map<string, string>();
    const sent = new Map<string, number>();
    const digests = new Map<string, number>();
    for (const e of events) {
      if (e.type === 'summary') continue;
      const own = e.type === 'digest' ? e.own : STORE_KEYS.has(e.key!);
      const counter = `${own ? `${e.inst}'s own counter` : 'the shared counter'} in hour ${Math.floor(e.at / H)}`;
      if (e.type === 'digest') {
        digests.set(counter, (digests.get(counter) || 0) + 1);
        if (digests.get(counter)! > 1) out.push(`${when(e)}${e.inst} got two digests from ${counter}`);
        continue;
      }
      sent.set(counter, (sent.get(counter) || 0) + 1);
      if (sent.get(counter)! > perHour) out.push(`${when(e)}${e.inst} told more than ${perHour} from ${counter}`);
      if (!paired) continue;
      if (own) {
        const was = ownOpen.get(e.inst);
        if (e.type === 'opened') {
          if (was) out.push(`${when(e)}${e.inst} told it cannot see twice in one outage (${was}, ${e.key})`);
          ownOpen.set(e.inst, e.key!);
        } else if (e.type === 'resolved' && was === e.key) ownOpen.delete(e.inst);
        else out.push(`${when(e)}${e.inst} told ${e.key} ${e.type} with no own outage open under that key`);
        continue;
      }
      if (e.type === 'opened') {
        if (appOpen.has(e.key!)) out.push(`${when(e)}${e.inst} told ${e.key} opened again while it was told open`);
        appOpen.add(e.key!);
      } else if (!appOpen.has(e.key!)) out.push(`${when(e)}${e.inst} told ${e.key} ${e.type} with no told opening`);
      else if (e.type === 'resolved') appOpen.delete(e.key!);
    }
    // Once every server reaches the store again, each has told that it can see.
    if (paired) for (const [inst, key] of ownOpen) out.push(`end: ${inst} never told that it can see again (${key})`);
    return out;
  }

  /**
   * The end state: once the store is back for both servers, what the store holds is what the sinks last heard of
   * the app. A finding the store holds open was last told opened (or changed); one it holds resolved, or does not
   * hold, was last told resolved or never told at all. The store holds no server's own outage.
   */
  async function endBreaches(events: Told[], store: FlightStore): Promise<string[]> {
    const out: string[] = [];
    const last = new Map<string, string>();
    for (const e of changes(events)) if (!STORE_KEYS.has(e.key!)) last.set(e.key!, e.type);
    const recs = (await store.findings()).filter((x) => x.key !== STATE_KEY);
    for (const rec of recs) {
      if (STORE_KEYS.has(rec.key)) out.push(`end: the store holds ${rec.key}, a server's own outage`);
      const l = last.get(rec.key);
      if (rec.state === 'resolved' && l && l !== 'resolved') out.push(`end: the store holds ${rec.key} resolved, the sinks last heard ${l}`);
      if (rec.state === 'open' && (!l || l === 'resolved')) out.push(`end: the store holds ${rec.key} open, the sinks last heard ${l ?? 'nothing'}`);
    }
    for (const [k, l] of last) if (l !== 'resolved' && !recs.some((x) => x.key === k)) out.push(`end: ${k} is not in the store, the sinks last heard ${l}`);
    return out;
  }

  // Seeds 1 to 40 by default; INVARIANT_SEEDS=1000 (and INVARIANT_FROM) runs more.
  const SEEDS = Number(process.env.INVARIANT_SEEDS) || 40;
  const FROM = Number(process.env.INVARIANT_FROM) || 1;
  it.each(Array.from({ length: SEEDS }, (_, i) => [i + FROM]))(
    'invariants: two servers on one store through random outages (seed %i): a finding about the app told once across them, each server its own outage once each way, at most the hourly limit and one digest an hour per counter, the store ends as the sinks last heard, and a second outage on one server\'s own path is told',
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
            // Hung calls go through at last, or fail (as when the connection drops).
            if (was === 'hung' && w.ctl.mode !== 'hung') w.release(next() < 0.5);
          }
          if (!settle && next() < 0.1)
            for (const w of ways) {
              if (w.ctl.mode === 'hung') w.release(next() < 0.5);
              w.ctl.mode = 'refused';
            }
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
        // Then one server's own way to the store hangs while the other holds it, fails, and comes back: it tells
        // its outage and its end. Its own way hangs again: it tells this second outage too.
        const v = seed % 2;
        const own = async (mode: Mode, n: number, failed = false) => {
          if (ways[v].ctl.mode === 'hung' && mode !== 'hung') ways[v].release(failed);
          ways[v].ctl.mode = mode;
          steps.push(`${Math.round((Date.now() - START) / MIN)}m ${['A', 'B'][v]} own ${mode} x${n}`);
          for (let i = 0; i < n; i++) await period(fs);
        };
        await own('hung', 5);
        await own('refused', 2, true);
        await own('ok', 4);
        const second = events.length;
        await own('hung', 8);
        const toldSecond = events.slice(second).some((e) => e.inst === ['A', 'B'][v] && e.type === 'opened' && e.key === 'blind:store-unreachable');
        await own('ok', 4, true);
        // Pairing and the end state are checked at perHour 1000 only: past the hourly limit, changes wait for a
        // digest, so the sinks do not hear each one.
        const found = breaches(events, perHour, perHour === 1000);
        if (perHour === 1000) {
          found.push(...(await endBreaches(events, base)));
          if (!toldSecond) found.push(`${['A', 'B'][v]} did not tell the second outage on its own way to the store`);
        }
        expect(found, `seed ${seed}, perHour ${perHour}\nsteps: ${steps.join(', ')}\ntold: ${events.map((e) => `${when(e)} ${e.inst} ${e.type} ${e.key ?? ''}`).join(', ')}`).toEqual([]);
        for (const f of fs) f.stop();
        vi.useRealTimers();
      }
    },
    30_000,
  );
});
