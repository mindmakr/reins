import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReins } from 'reins';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseArgs } from '../src/args.js';
import type { AuditEntry } from '../src/audit.js';
import { fileAudit } from '../src/audit.js';
import { Hub } from '../src/hub.js';
import { isOriginAllowed } from '../src/origin.js';
import { tokenPath, tokensMatch } from '../src/token.js';
import { callTool } from '../src/tools.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'reins-bridge-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startHub(extra: Partial<Parameters<typeof Hub.start>[0]> = {}) {
  const entries: AuditEntry[] = [];
  const hub = await Hub.start({ dir: tempDir(), port: 0, log: () => {}, audit: (e) => entries.push(e), handshakeMs: 500, ...extra });
  cleanup.push(() => hub.close());
  return { hub, entries, url: `ws://127.0.0.1:${hub.port}` };
}

/** Opens a raw client and resolves with what the bridge did: welcome, refused (with close code) or rejected at upgrade. */
function attempt(url: string, opts: { origin?: string; token?: string | null } = {}): Promise<{ result: string; code?: number; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts.origin ? { origin: opts.origin } : {});
    cleanup.push(() => ws.terminate());
    ws.on('unexpected-response', (_req, res) => resolve({ result: 'rejected', status: res.statusCode }));
    ws.on('error', () => {});
    ws.on('open', () => {
      if (opts.token !== null) ws.send(JSON.stringify({ type: 'hello', token: opts.token }));
    });
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.type === 'welcome') resolve({ result: 'welcome' });
    });
    ws.on('close', (code) => resolve({ result: 'closed', code }));
  });
}

const quiet = () => ({ info() {}, log() {}, groupCollapsed() {}, groupEnd() {}, error() {} });

describe('origin allowlist', () => {
  it('allows localhost origins and exact extras only', () => {
    expect(isOriginAllowed('http://localhost:5173')).toBe(true);
    expect(isOriginAllowed('https://127.0.0.1:3000')).toBe(true);
    expect(isOriginAllowed('http://[::1]:8081')).toBe(true);
    expect(isOriginAllowed('http://app.localhost:3000')).toBe(true);
    expect(isOriginAllowed('https://evil.example')).toBe(false);
    expect(isOriginAllowed('http://localhost.evil.example')).toBe(false);
    expect(isOriginAllowed('file://')).toBe(false);
    expect(isOriginAllowed('null')).toBe(false);
    expect(isOriginAllowed('http://my-app.test:3000', ['http://my-app.test:3000'])).toBe(true);
    expect(isOriginAllowed(undefined)).toBe(true);
    expect(isOriginAllowed(undefined, [], false)).toBe(false);
  });
});

describe('token', () => {
  it('compares tokens exactly', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abd', 'abc')).toBe(false);
    expect(tokensMatch('ab', 'abc')).toBe(false);
    expect(tokensMatch(undefined, 'abc')).toBe(false);
    expect(tokensMatch('', '')).toBe(false);
  });
});

describe('hub', () => {
  it('writes the token to .reins/token with a gitignore, and removes it on close', async () => {
    const dir = tempDir();
    const hub = await Hub.start({ dir, port: 0, log: () => {} });
    expect(readFileSync(tokenPath(dir), 'utf8').trim()).toBe(hub.token);
    expect(readFileSync(join(dir, '.reins', '.gitignore'), 'utf8')).toBe('*\n');
    await hub.close();
    expect(existsSync(tokenPath(dir))).toBe(false);
  });

  it('rejects a foreign Origin at the upgrade', async () => {
    const { hub, url, entries } = await startHub();
    expect(await attempt(url, { origin: 'https://evil.example', token: hub.token })).toEqual({ result: 'rejected', status: 403 });
    expect(entries.some((e) => e.event === 'refused')).toBe(true);
  });

  it('refuses a wrong token, and a client that never says hello', async () => {
    const { url } = await startHub();
    expect(await attempt(url, { origin: 'http://localhost:5173', token: 'wrong' })).toEqual({ result: 'closed', code: 4401 });
    expect(await attempt(url, { token: null })).toEqual({ result: 'closed', code: 4401 });
  });

  it('refuses clients without an Origin when browser-only', async () => {
    const { hub, url } = await startHub({ allowNoOrigin: false });
    expect(await attempt(url, { token: hub.token })).toEqual({ result: 'rejected', status: 403 });
  });

  it('pairs with the right token and then rotates it', async () => {
    const { hub, url } = await startHub();
    const first = hub.token;
    expect(await attempt(url, { origin: 'http://localhost:5173', token: first })).toEqual({ result: 'welcome' });
    expect(hub.token).not.toBe(first);
    expect(await attempt(url, { origin: 'http://localhost:5173', token: first })).toEqual({ result: 'closed', code: 4401 });
  });

  it('says so when no app is paired', async () => {
    const { hub } = await startHub();
    await expect(hub.request('list')).rejects.toThrow(/No app is paired/);
  });
});

describe('end to end: reins core <-> bridge <-> tools', () => {
  it('lists and runs actions, enforces confirm, and audits every call', async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const audit = fileAudit(dir, (l) => lines.push(l));
    const { hub, url } = await startHub({ dir, audit });

    const app = createReins({ console: quiet() });
    app.action({ name: 'set-locale', description: 'Switch language', input: { type: 'object', properties: { locale: { type: 'string' } } }, run: ({ locale }: any) => ({ locale }) });
    app.action({ name: 'reset-db', description: 'Reset the dev database', consequential: true, run: () => 'reset' });
    app.state('session', () => ({ user: 'tess', token: 'secret' }));
    expect(await app.connect({ url, token: hub.token, WebSocket: WebSocket as any, reconnect: false, lazy: false })).toBe(true);
    cleanup.push(() => app.disconnect());

    const ctx = { hub, dir, audit };
    const list: any = await callTool(ctx, 'reins_list_actions');
    expect(list.actions.map((a: any) => a.name)).toEqual(['set-locale', 'reset-db']);
    expect(await callTool(ctx, 'reins_run_action', { name: 'set-locale', input: { locale: 'ar' } })).toEqual({ locale: 'ar' });
    await expect(callTool(ctx, 'reins_run_action', { name: 'reset-db' })).rejects.toThrow(/confirm: true/);
    expect(await callTool(ctx, 'reins_run_action', { name: 'reset-db', confirm: true })).toBe('reset');
    expect(await callTool(ctx, 'reins_state', { name: 'session' })).toEqual({ session: { user: 'tess', token: '[redacted]' } });
    app.markComponent('invoice-list');
    const perf: any = await callTool(ctx, 'reins_perf');
    expect(perf.components).toEqual([expect.objectContaining({ id: 'invoice-list', renders: 1 })]);
    expect(await callTool(ctx, 'reins_dom', { panel: 'invoice-list' })).toBeNull();

    const log = readFileSync(join(dir, '.reins', 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.filter((e) => e.source === 'agent').map((e) => [e.event, e.ok])).toEqual([
      ['reins_list_actions', true],
      ['reins_run_action', true],
      ['reins_run_action', false],
      ['reins_run_action', true],
      ['reins_state', true],
      ['reins_perf', true],
      ['reins_dom', true],
    ]);
  });
});

describe('cli arguments', () => {
  it('parses flags and rejects unknown ones', () => {
    expect(parseArgs(['bridge', '--port', '9000', '--origin', 'http://a.test', '--no-rotate'], '/p')).toMatchObject({
      command: 'bridge',
      port: 9000,
      origins: ['http://a.test'],
      rotate: false,
      mcp: true,
      dir: '/p',
    });
    expect(parseArgs([], '/p').command).toBe('help');
    expect(() => parseArgs(['bridge', '--host', '0.0.0.0'], '/p')).toThrow(/unknown option/);
    expect(() => parseArgs(['bridge', '--port'], '/p')).toThrow(/needs a value/);
  });
});
