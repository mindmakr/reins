import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReins, DEV_MARKER } from '../src/index.js';
import { connectOpts, FakeSocket, fakeGlobal, GOOD } from './helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const echo = { name: 'echo', description: 'Returns its input', run: (input: unknown) => input };

describe('registry', () => {
  it('registers, lists and removes actions', () => {
    const r = createReins(fakeGlobal());
    const off = r.action({ ...echo, input: { type: 'object', properties: { a: { type: 'number' } } } });
    expect(r.actions()).toEqual([
      { name: 'echo', description: 'Returns its input', input: { type: 'object', properties: { a: { type: 'number' } } }, consequential: false, readOnly: false },
    ]);
    off();
    expect(r.actions()).toEqual([]);
  });

  it('rejects bad names and missing run functions', () => {
    const r = createReins(fakeGlobal());
    expect(() => r.action({ ...echo, name: 'has space' })).toThrow(/bad action name/);
    expect(() => r.action({ ...echo, name: '' })).toThrow(/bad action name/);
    expect(() => r.action({ name: 'x', description: '', run: undefined as any })).toThrow(/run function/);
  });

  it('a newer registration under the same name survives the old unregister', () => {
    const r = createReins(fakeGlobal());
    const off1 = r.action(echo);
    r.action({ ...echo, description: 'second' });
    off1();
    expect(r.actions().map((a) => a.description)).toEqual(['second']);
  });

  it('carries the dev marker', () => {
    expect(createReins(fakeGlobal()).marker).toBe(DEV_MARKER);
  });
});

describe('pairing', () => {
  it('does nothing without a token: no socket, no patches, no handle', async () => {
    const fetch = vi.fn(async () => ({ ok: false, text: async () => '' }));
    const g = fakeGlobal({ fetch });
    const r = createReins(g);
    r.action(echo);
    const before = FakeSocket.created;
    expect(await r.connect({ WebSocket: FakeSocket as any, reconnect: false, lazy: false })).toBe(false);
    expect(FakeSocket.created).toBe(before);
    expect(g.fetch).toBe(fetch);
    expect(g.__reins__).toBeUndefined();
    await expect(r.run('echo', {})).rejects.toThrow(/not paired/);
    expect(() => r.snapshot()).toThrow(/not paired/);
  });

  it('is refused with a wrong token and stays inert', async () => {
    const fetch = vi.fn();
    const g = fakeGlobal({ fetch });
    const r = createReins(g);
    expect(await r.connect({ ...connectOpts, token: 'wrong' })).toBe(false);
    expect(r.isPaired()).toBe(false);
    expect(g.fetch).toBe(fetch);
    expect(FakeSocket.last!.closed).toBe(true);
  });

  it('fetches the token from the token URL when not given one', async () => {
    const fetch = vi.fn(async () => ({ ok: true, text: async () => GOOD + '\n' }));
    const r = createReins(fakeGlobal({ fetch }));
    expect(await r.connect({ ...connectOpts, token: undefined })).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/__reins/token', expect.anything());
    r.disconnect();
  });

  it('does not connect in production builds', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('NODE_ENV', 'production');
    const r = createReins(fakeGlobal());
    const before = FakeSocket.created;
    expect(await r.connect(connectOpts)).toBe(false);
    expect(FakeSocket.created).toBe(before);
  });

  it('pairs with the right token, sends the marker, and unpairs cleanly', async () => {
    const fetch = vi.fn();
    const g = fakeGlobal({ fetch });
    const r = createReins(g);
    expect(await r.connect(connectOpts)).toBe(true);
    expect(r.isPaired()).toBe(true);
    expect(FakeSocket.last!.sent[0]).toMatchObject({ type: 'hello', token: GOOD, marker: DEV_MARKER });
    expect(g.fetch).not.toBe(fetch);
    expect(Object.isFrozen(g.__reins__)).toBe(true);
    r.disconnect();
    expect(r.isPaired()).toBe(false);
    expect(g.fetch).toBe(fetch);
    expect(g.__reins__).toBeUndefined();
  });
});

describe('actions over the bridge', () => {
  it('runs actions and refuses consequential ones without confirm', async () => {
    const del = vi.fn(() => 'deleted');
    const r = createReins(fakeGlobal());
    r.action(echo);
    r.action({ name: 'delete-account', description: 'Deletes the account', consequential: true, run: del });
    await r.connect(connectOpts);
    const ws = FakeSocket.last!;

    expect(await ws.call('run', { name: 'echo', input: { a: 1 } })).toMatchObject({ ok: true, result: { a: 1 } });
    expect(await ws.call('run', { name: 'nope' })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown action/) });

    const refused = await ws.call('run', { name: 'delete-account' });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/confirm: true/) });
    expect(del).not.toHaveBeenCalled();

    expect(await ws.call('run', { name: 'delete-account', confirm: true })).toMatchObject({ ok: true, result: 'deleted' });
    expect(del).toHaveBeenCalledOnce();

    const list = await ws.call('list');
    expect(list.result.actions.map((a: any) => [a.name, a.consequential])).toEqual([
      ['echo', false],
      ['delete-account', true],
    ]);
    r.disconnect();
  });

  it('reports devtools calls to the bridge audit log', async () => {
    const g = fakeGlobal();
    const r = createReins(g);
    r.action(echo);
    await r.connect(connectOpts);
    await g.__reins__.run('echo', { x: 1 });
    expect(FakeSocket.last!.sent.find((m) => m.type === 'audit')).toMatchObject({ entry: { method: 'run', name: 'echo', via: 'devtools', ok: true } });
    r.disconnect();
  });

  it('returns redacted state snapshots', async () => {
    const r = createReins(fakeGlobal());
    r.state('auth', () => ({ user: { id: 7, name: 'Tess' }, accessToken: 'abc' }));
    await r.connect(connectOpts);
    const res = await FakeSocket.last!.call('state', { name: 'auth' });
    expect(res.result).toEqual({ auth: { user: { id: 7, name: 'Tess' }, accessToken: '[redacted]' } });
    r.disconnect();
  });

  it('records console errors after pairing only', async () => {
    const g = fakeGlobal();
    const r = createReins(g);
    g.console.error('before');
    await r.connect(connectOpts);
    g.console.error('boom', { code: 1 });
    const res = await FakeSocket.last!.call('errors');
    expect(res.result).toEqual([expect.objectContaining({ kind: 'console', message: 'boom {"code":1}' })]);
    r.disconnect();
  });
});
