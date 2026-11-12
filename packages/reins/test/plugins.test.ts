import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepInBuild, tokenResponse } from '@mindmakr/reins/server';
import { reinsPlugin } from '../src/vite.js';
import { shouldStub as nextShouldStub, withReins as withReinsNext } from '../src/next.js';
import { withReins as withReinsMetro } from '../src/metro.js';

const dirs: string[] = [];
function project(token?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'reins-plugin-'));
  dirs.push(dir);
  if (token) {
    mkdirSync(join(dir, '.reins'));
    writeFileSync(join(dir, '.reins', 'token'), token + '\n');
  }
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeRes() {
  const res: any = { headers: {}, statusCode: 0, body: '' };
  res.setHeader = (k: string, v: string) => (res.headers[k] = v);
  res.end = (b: string) => (res.body = b);
  return res;
}

describe('token route', () => {
  it('serves the current token, refuses cross-site requests, 404s without a bridge', () => {
    const dir = project('tok123');
    expect(tokenResponse(dir, { 'sec-fetch-site': 'same-origin' })).toEqual({ status: 200, body: 'tok123' });
    expect(tokenResponse(dir, {})).toEqual({ status: 200, body: 'tok123' });
    expect(tokenResponse(dir, { 'sec-fetch-site': 'cross-site' }).status).toBe(403);
    expect(tokenResponse(dir, { 'sec-fetch-site': 'same-site' }).status).toBe(403);
    expect(tokenResponse(project(), {}).status).toBe(404);
  });

  it('keeps reins in a build only with REINS_ENABLE=1', () => {
    expect(keepInBuild({})).toBe(false);
    expect(keepInBuild({ REINS_ENABLE: '1' })).toBe(true);
    expect(keepInBuild({ NEXT_PUBLIC_REINS_ENABLE: 'true' })).toBe(true);
    expect(keepInBuild({ REINS_ENABLE: '0' })).toBe(false);
  });
});

describe('@mindmakr/reins/vite', () => {
  async function resolveWith(command: 'build' | 'serve', mode: string) {
    const plugin = reinsPlugin();
    plugin.configResolved({ root: '.', command, mode });
    const resolve = vi.fn(async (id: string) => ({ id: `/abs/${id}` }));
    const to = (id: string) => plugin.resolveId.call({ resolve }, id, '/app/main.ts');
    return { result: await to('@mindmakr/reins'), record: await to('@mindmakr/reins/record'), other: await to('react'), proto: await to('constructor') };
  }

  it('swaps reins for the stub in production builds only', async () => {
    expect((await resolveWith('build', 'production')).result).toEqual({ id: '/abs/@mindmakr/reins/stub' });
    expect((await resolveWith('build', 'production')).other).toBeNull();
    // An import named like an Object.prototype member must not be treated as a stub entry.
    expect((await resolveWith('build', 'production')).proto).toBeNull();
    expect((await resolveWith('serve', 'development')).result).toBeNull();
    expect((await resolveWith('build', 'development')).result).toBeNull();
    vi.stubEnv('REINS_ENABLE', '1');
    expect((await resolveWith('build', 'staging')).result).toBeNull();
  });

  it('swaps @mindmakr/reins/record for its stub in production builds only', async () => {
    expect((await resolveWith('build', 'production')).record).toEqual({ id: '/abs/@mindmakr/reins/record-stub' });
    expect((await resolveWith('serve', 'development')).record).toBeNull();
    vi.stubEnv('REINS_ENABLE', '1');
    expect((await resolveWith('build', 'staging')).record).toBeNull();
  });

  it('serves the token in dev', () => {
    const dir = project('abc');
    let handler: any;
    reinsPlugin().configureServer({ config: { root: dir }, middlewares: { use: (fn) => (handler = fn) } });
    const res = fakeRes();
    handler({ url: '/__reins/token', headers: {} }, res, () => {});
    expect([res.statusCode, res.body, res.headers['Cache-Control']]).toEqual([200, 'abc', 'no-store']);
    const next = vi.fn();
    handler({ url: '/other', headers: {} }, fakeRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('@mindmakr/reins/next', () => {
  it('aliases reins and @mindmakr/reins/record to their stubs in production webpack builds and keeps the user webpack hook', () => {
    const user = vi.fn((c) => c);
    const cfg = withReinsNext({ webpack: user, reactStrictMode: true });
    expect(cfg.reactStrictMode).toBe(true);
    const prod = cfg.webpack({ resolve: { alias: { x: 'y' } } }, { dev: false });
    expect(prod.resolve.alias).toEqual({ x: 'y', '@mindmakr/reins$': '@mindmakr/reins/stub', '@mindmakr/reins/record$': '@mindmakr/reins/record-stub' });
    const dev = cfg.webpack({ resolve: { alias: {} } }, { dev: true });
    expect(dev.resolve.alias).toEqual({});
    expect(user).toHaveBeenCalledTimes(2);
  });

  it('respects REINS_ENABLE and sets a Turbopack alias for production', () => {
    expect(nextShouldStub(false, {}, { REINS_ENABLE: '1' })).toBe(false);
    expect(nextShouldStub(false, {}, {})).toBe(true);
    vi.stubEnv('NODE_ENV', 'production');
    expect(withReinsNext({}).turbopack.resolveAlias).toEqual({ '@mindmakr/reins': '@mindmakr/reins/stub', '@mindmakr/reins/record': '@mindmakr/reins/record-stub' });
  });
});

describe('@mindmakr/reins/metro', () => {
  it('serves the token through Metro middleware', () => {
    const dir = project('metro-token');
    const cfg = withReinsMetro({}, { projectRoot: dir });
    const inner = vi.fn();
    const mw = cfg.server.enhanceMiddleware(inner, {});
    const res = fakeRes();
    mw({ url: '/__reins/token', headers: {} }, res, () => {});
    expect(res.body).toBe('metro-token');
    mw({ url: '/index.bundle', headers: {} }, fakeRes(), () => {});
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('resolves reins and @mindmakr/reins/record to their stubs only in production', () => {
    const resolveRequest = vi.fn((_c, name) => name);
    vi.stubEnv('NODE_ENV', 'production');
    expect(withReinsMetro({}).resolver.resolveRequest({ resolveRequest }, '@mindmakr/reins', 'ios')).toBe('@mindmakr/reins/stub');
    expect(withReinsMetro({}).resolver.resolveRequest({ resolveRequest }, '@mindmakr/reins/record', 'ios')).toBe('@mindmakr/reins/record-stub');
    expect(withReinsMetro({}).resolver.resolveRequest({ resolveRequest }, 'react', 'ios')).toBe('react');
    vi.stubEnv('NODE_ENV', 'development');
    expect(withReinsMetro({}).resolver.resolveRequest({ resolveRequest }, '@mindmakr/reins', 'ios')).toBe('@mindmakr/reins');
    expect(withReinsMetro({}).resolver.resolveRequest({ resolveRequest }, '@mindmakr/reins/record', 'ios')).toBe('@mindmakr/reins/record');
  });
});
