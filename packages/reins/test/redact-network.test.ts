import { describe, expect, it } from 'vitest';
import { createReins } from '../src/index.js';
import { redactBody, redactDeep, redactHeaders, redactUrl, REDACTED } from '../src/redact.js';
import { connectOpts, FakeSocket, fakeGlobal } from './helpers.js';

describe('redaction', () => {
  it('redacts Authorization, Cookie and Set-Cookie unless allowlisted, keeps safe headers', () => {
    const h = { Authorization: 'Bearer x', Cookie: 'a=b', 'Set-Cookie': 'sid=1', 'Content-Type': 'application/json', 'X-Custom': 'v' };
    expect(redactHeaders(h)).toEqual({ authorization: REDACTED, cookie: REDACTED, 'set-cookie': REDACTED, 'content-type': 'application/json', 'x-custom': REDACTED });
    expect(redactHeaders(h, ['x-custom', 'Authorization'])).toMatchObject({ authorization: 'Bearer x', 'x-custom': 'v', cookie: REDACTED });
  });

  it('redacts bodies unless keys are allowlisted', () => {
    expect(redactBody('{"email":"a@b.c","password":"p"}')).toBe(REDACTED);
    expect(redactBody('{"email":"a@b.c","password":"p","items":[{"id":1,"secret":"s"}]}', ['email', 'id'])).toEqual({
      email: 'a@b.c',
      password: REDACTED,
      items: [{ id: 1, secret: REDACTED }],
    });
    expect(redactBody('not json', ['email'])).toBe(REDACTED);
    expect(redactBody(undefined)).toBeUndefined();
  });

  it('redacts sensitive keys deeply, cuts cycles and functions', () => {
    const v: any = { name: 'n', session: { id: 1 }, nested: { apiKey: 'k', ok: 1 }, fn() {} };
    v.self = v;
    expect(redactDeep(v)).toEqual({ name: 'n', session: REDACTED, nested: { apiKey: REDACTED, ok: 1 }, fn: '[function]', self: '[cycle]' });
    expect(redactDeep({ session: 's' }, ['session'])).toEqual({ session: 's' });
  });

  it('redacts sensitive query values', () => {
    expect(redactUrl('/cb?code=1&token=abc&page=2#x')).toBe(`/cb?code=1&token=${REDACTED}&page=2#x`);
    expect(redactUrl('/a?access_token=z', ['access_token'])).toBe('/a?access_token=z');
    expect(redactUrl('/plain')).toBe('/plain');
  });
});

describe('network ring buffer', () => {
  function fakeFetch() {
    return async (_input: unknown, _init?: unknown) => ({ status: 201, headers: new Map([['set-cookie', 'sid=1'], ['content-type', 'application/json']]) });
  }

  it('records fetch calls with redacted headers and bodies, and keeps only the last N', async () => {
    const g = fakeGlobal({ fetch: fakeFetch() });
    const r = createReins(g);
    await r.connect({ ...connectOpts, bufferSize: 3 });
    await g.fetch('/api/login?token=t', { method: 'post', headers: { Authorization: 'Bearer secret' }, body: '{"password":"p"}' });
    const [e] = r.network();
    expect(e).toMatchObject({
      method: 'POST',
      url: `/api/login?token=${REDACTED}`,
      status: 201,
      requestHeaders: { authorization: REDACTED },
      responseHeaders: { 'set-cookie': REDACTED, 'content-type': 'application/json' },
      requestBody: REDACTED,
    });
    expect(e.ms).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 5; i++) await g.fetch(`/api/item/${i}`);
    expect(r.network().map((x) => x.url)).toEqual(['/api/item/2', '/api/item/3', '/api/item/4']);
    const filtered = await FakeSocket.last!.call('network', { url: 'item/4' });
    expect(filtered.result.map((x: any) => x.url)).toEqual(['/api/item/4']);
    r.disconnect();
  });

  it('records failed fetch calls and rethrows', async () => {
    const g = fakeGlobal({
      fetch: async () => {
        throw new Error('offline');
      },
    });
    const r = createReins(g);
    await r.connect(connectOpts);
    await expect(g.fetch('/x')).rejects.toThrow('offline');
    expect(r.network()[0]).toMatchObject({ url: '/x', status: 0, error: 'offline' });
    r.disconnect();
  });

  it('records nothing before pairing', async () => {
    const orig = fakeFetch();
    const g = fakeGlobal({ fetch: orig });
    const r = createReins(g);
    await g.fetch('/early');
    expect(g.fetch).toBe(orig);
    expect(r.network()).toEqual([]);
  });
});
