import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReins } from '../src/index.js';
import { connectOpts, FakeSocket, fakeGlobal } from './helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const page = (fetch = vi.fn(async (..._a: any[]) => ({ status: 200, headers: new Headers() }))) =>
  fakeGlobal({ fetch, Headers, location: { href: 'http://localhost:5173/invoices?token=abc', origin: 'http://localhost:5173' } });

describe('trace header', () => {
  it('adds x-reins-trace to same-origin calls only, and only while paired', async () => {
    const g = page();
    const raw = g.fetch;
    const r = createReins(g);
    await r.connect(connectOpts);
    await g.fetch('/api/invoices', { headers: { 'Content-Type': 'application/json' } });
    await g.fetch('http://localhost:5173/api/a', { headers: new Headers({ authorization: 'Bearer x' }) });
    await g.fetch('https://payments.example/charge', { headers: { 'Content-Type': 'application/json' } });
    const sent = raw.mock.calls.map((c: any[]) => c[1]?.headers);
    expect(sent[0].get('x-reins-trace')).toMatch(/^[a-z0-9]{1,6}-1$/);
    expect(sent[0].get('content-type')).toBe('application/json');
    expect(sent[1].get('x-reins-trace')).toMatch(/-2$/);
    expect(sent[1].get('authorization')).toBe('Bearer x');
    expect(sent[2]).toEqual({ 'Content-Type': 'application/json' });
    const net = r.network();
    expect(net[0].traceId).toBe(sent[0].get('x-reins-trace'));
    expect(net[2].traceId).toBeUndefined();
    r.disconnect();
    expect(g.fetch).toBe(raw);
  });

  it('does not add it in record mode without a bridge', async () => {
    const g = page();
    const raw = g.fetch;
    const r = createReins(g);
    expect(r.record()).toBe(true);
    await g.fetch('/api/invoices');
    expect(raw.mock.calls[0][1]).toEqual({});
    expect(r.network()[0]).toMatchObject({ url: '/api/invoices', status: 200 });
    r.record(false);
  });
});

describe('record mode', () => {
  it('starts the buffers without a bridge and lets app code run actions and read state', async () => {
    const g = page();
    const raw = g.fetch;
    const r = createReins(g);
    r.action({ name: 'echo', description: 'echo', run: (i: unknown) => i });
    r.state('session', () => ({ user: 'tess', accessToken: 'secret' }));
    await expect(r.run('echo', { a: 1 })).rejects.toThrow(/not paired/);
    expect(r.record({ bufferSize: 2 })).toBe(true);
    expect(r.isPaired()).toBe(false);
    expect(await r.run('echo', { a: 1 })).toEqual({ a: 1 });
    expect(r.snapshot('session')).toEqual({ session: { user: 'tess', accessToken: '[redacted]' } });
    expect(r.snapshot('location')).toEqual({ location: 'http://localhost:5173/invoices?token=[redacted]' });
    g.console.error('boom');
    expect(r.errors()).toEqual([expect.objectContaining({ kind: 'console', message: 'boom' })]);
    for (const u of ['/a', '/b', '/c']) await g.fetch(u);
    expect(r.network().map((e) => e.url)).toEqual(['/b', '/c']);
    expect(g.__reins__).toBeUndefined();
    r.record(false);
    expect(g.fetch).toBe(raw);
    await expect(r.run('echo', {})).rejects.toThrow(/not paired/);
  });

  it('is refused in production builds', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('NODE_ENV', 'production');
    const g = page();
    const raw = g.fetch;
    const r = createReins(g);
    expect(r.record()).toBe(false);
    expect(g.fetch).toBe(raw);
    expect(() => r.snapshot()).toThrow(/not paired/);
  });

  it('keeps recording when the bridge goes away, and stops cleanly after', async () => {
    const g = page();
    const raw = g.fetch;
    const r = createReins(g);
    r.record();
    await r.connect(connectOpts);
    expect(r.isPaired()).toBe(true);
    expect(g.__reins__).toBeDefined();
    r.disconnect();
    expect(g.__reins__).toBeUndefined();
    expect(g.fetch).not.toBe(raw);
    await g.fetch('/still');
    expect(r.network().some((e) => e.url === '/still')).toBe(true);
    r.record(false);
    expect(g.fetch).toBe(raw);
    expect(FakeSocket.last!.closed).toBe(true);
  });
});
