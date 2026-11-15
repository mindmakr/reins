import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createReins } from '@mindmakr/reins';
import { createReinsNode } from '@mindmakr/reins/node';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fileAudit } from '../src/bridge/audit.js';
import { createRng, fuzzMain, generateValueForSchema } from '../src/bridge/fuzz-cli.js';
import { Hub } from '../src/bridge/hub.js';
import { latestSession } from '../src/bridge/session.js';

const execFileAsync = promisify(execFile);

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function makeProjectDir() {
  const dir = mkdtempSync(join(tmpdir(), 'reins-fuzz-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (s: string) => stdout.push(s),
    err: (s: string) => stderr.push(s),
    json: () => JSON.parse(stdout.join('\n')),
  };
}

interface TestHarnessOptions {
  withServerConsequential?: boolean;
  triggerUnhandledRejectionAtCount?: number;
  trigger5xxOnFetch?: boolean;
  clipOnArabic?: boolean;
}

async function setupFuzzHarness(opts: TestHarnessOptions = {}) {
  const dir = makeProjectDir();
  const auditLines: string[] = [];
  const audit = fileAudit(dir, (l) => auditLines.push(l));
  const hub = await Hub.start({ dir, port: 0, log: () => {}, audit, handshakeMs: 1000 });
  cleanup.push(() => hub.close());

  let locale = 'en';
  let stepCounter = 0;
  const invoked: Array<{ target: string; name: string; input: unknown }> = [];
  const listeners = new Map<string, Array<(e: any) => void>>();

  const panelEl: any = {
    tagName: 'SECTION',
    id: 'checkout',
    className: 'panel-rtl-check',
    getAttribute: (k: string) => (k === 'data-reins' ? 'checkout' : undefined),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }),
    get scrollWidth() {
      return opts.clipOnArabic && locale === 'ar' ? 420 : 320;
    },
    clientWidth: 320,
    scrollHeight: 180,
    clientHeight: 180,
    childNodes: [{ nodeType: 3, textContent: 'Checkout' }],
    children: [],
  };

  const g: any = {
    console: { info() {}, log() {}, warn() {}, groupCollapsed() {}, groupEnd() {}, error() {} },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    addEventListener(type: string, fn: (e: any) => void) {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      const arr = listeners.get(type) ?? [];
      listeners.set(type, arr.filter((f) => f !== fn));
    },
    getComputedStyle: () => ({
      display: 'block',
      overflowX: 'hidden',
      overflowY: 'visible',
      direction: locale === 'ar' ? 'rtl' : 'ltr',
    }),
    document: {
      title: 'Fuzz Test App',
      readyState: 'complete',
      body: panelEl,
      querySelector: (sel: string) => (sel.includes('checkout') ? panelEl : null),
      querySelectorAll: () => [panelEl],
      getElementsByTagName: () => [panelEl],
    },
    fetch: async (url: string) => ({
      status: opts.trigger5xxOnFetch ? 502 : 200,
      ok: !opts.trigger5xxOnFetch,
      headers: { get: () => null },
      url,
    }),
  };

  const emitGlobal = (type: string, event: any) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };

  const app = createReins(g);
  app.action({
    name: 'set-locale',
    description: 'Switches active locale',
    input: {
      type: 'object',
      properties: {
        locale: { type: 'string', enum: ['en', 'fr', 'ar'] },
        password: { type: 'string' },
      },
      required: ['locale'],
    },
    run: (input: any) => {
      stepCounter++;
      locale = String(input?.locale ?? 'en');
      invoked.push({ target: 'app', name: 'set-locale', input });
      if (opts.triggerUnhandledRejectionAtCount && stepCounter >= opts.triggerUnhandledRejectionAtCount) {
        emitGlobal('unhandledrejection', { reason: new Error(`async crash at step ${stepCounter}`) });
      }
      return { locale };
    },
  });

  app.action({
    name: 'search-catalog',
    description: 'Filters catalog items',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 10 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        strict: { type: 'boolean' },
      },
      required: ['query', 'limit'],
    },
    run: async (input: any) => {
      stepCounter++;
      invoked.push({ target: 'app', name: 'search-catalog', input });
      if (opts.trigger5xxOnFetch && input?.strict) {
        await g.fetch('/api/catalog?q=' + encodeURIComponent(String(input.query)));
      }
      if (opts.triggerUnhandledRejectionAtCount && stepCounter >= opts.triggerUnhandledRejectionAtCount) {
        emitGlobal('unhandledrejection', { reason: new Error(`async crash at step ${stepCounter}`) });
      }
      return { ok: true };
    },
  });

  app.action({
    name: 'delete-account',
    description: 'Destructive consequential action',
    consequential: true,
    input: { type: 'object', properties: { reason: { type: 'string' } } },
    run: (input: any) => {
      invoked.push({ target: 'app', name: 'delete-account', input });
      return { deleted: true };
    },
  });

  app.registerPanel('checkout', () => ({
    id: 'checkout',
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
    viewportWidth: 1280,
    viewportHeight: 800,
  }));

  const pairedApp = await app.connect({
    url: `ws://127.0.0.1:${hub.port}`,
    token: hub.token,
    WebSocket: WebSocket as any,
    reconnect: false,
    lazy: false,
  });
  expect(pairedApp).toBe(true);
  cleanup.push(() => app.disconnect());

  if (opts.withServerConsequential) {
    const rn = createReinsNode({ NODE_ENV: 'development' });
    rn.action({
      name: 'drop-fixtures',
      description: 'Destructive server action',
      consequential: true,
      run: () => {
        invoked.push({ target: 'server', name: 'drop-fixtures', input: {} });
        return { dropped: true };
      },
    });
    await rn.connect({
      url: `ws://127.0.0.1:${hub.port}`,
      token: hub.token,
      WebSocket: WebSocket as any,
      reconnect: false,
      meta: { name: 'api' },
    });
    cleanup.push(() => rn.disconnect());
  }

  return {
    dir,
    hub,
    invoked,
    auditLines,
    resetState: () => {
      locale = 'en';
      stepCounter = 0;
      invoked.length = 0;
    },
  };
}

describe('reins fuzz (property-based UI invariant fuzzer)', () => {
  it('excludes consequential: true actions across app and server during a 40-step fuzz run', async () => {
    const { dir, hub, invoked } = await setupFuzzHarness({ withServerConsequential: true });
    const c = capture();

    const code = await fuzzMain(['--steps', '40', '--seed', '42', '--port', String(hub.port), '--dir', dir], dir, c.out, c.err);
    expect(code).toBe(0);

    const out = c.json();
    expect(out.ok).toBe(true);
    expect(out.stepsRun).toBe(40);
    expect(out.skippedConsequential).toEqual(['delete-account', 'drop-fixtures']);
    expect(invoked).toHaveLength(40);
    expect(invoked.some((i) => i.name === 'delete-account' || i.name === 'drop-fixtures')).toBe(false);

    // Password keys generated from schemas are redacted in stdout trace.
    const serialized = JSON.stringify(out.trace);
    const hasPasswordKey = serialized.includes('"password"');
    if (hasPasswordKey) {
      for (const t of out.trace) {
        if ('password' in t.input) expect(t.input.password).toBe('[redacted]');
      }
    }
    expect(existsSync(join(dir, '.reins', 'sessions'))).toBe(false);
  });

  it('reproduces an Arabic RTL horizontal-clip failure deterministically from its emitted --seed', async () => {
    const h1 = await setupFuzzHarness({ clipOnArabic: true });
    const c1 = capture();

    const code1 = await fuzzMain(['--steps', '40', '--panel', 'checkout', '--port', String(h1.hub.port), '--dir', h1.dir], h1.dir, c1.out, c1.err);
    expect(code1).toBe(2);

    const out1 = c1.json();
    expect(out1.ok).toBe(false);
    expect(typeof out1.seed).toBe('string');
    expect(out1.failedStep).toBeGreaterThan(0);
    expect(out1.failures.some((f: any) => f.type === 'dom-layout' && f.issue === 'horizontal-clip' && f.panel === 'checkout')).toBe(true);

    // Verify minimal trace artifact was written under .reins/sessions/ and .reins/.gitignore exists.
    expect(existsSync(out1.artifact)).toBe(true);
    expect(out1.artifact).toContain(join('.reins', 'sessions'));
    expect(readFileSync(join(h1.dir, '.reins', '.gitignore'), 'utf8')).toBe('*\n');
    const saved = JSON.parse(readFileSync(out1.artifact, 'utf8'));
    expect(saved.seed).toBe(out1.seed);
    expect(saved.trace).toHaveLength(out1.failedStep);

    // Replay on a fresh paired app using the emitted --seed.
    const h2 = await setupFuzzHarness({ clipOnArabic: true });
    const c2 = capture();
    const code2 = await fuzzMain(
      ['--steps', '40', '--seed', out1.seed, '--panel', 'checkout', '--port', String(h2.hub.port), '--dir', h2.dir],
      h2.dir,
      c2.out,
      c2.err,
    );
    expect(code2).toBe(2);
    const out2 = c2.json();
    expect(out2.seed).toBe(out1.seed);
    expect(out2.failedStep).toBe(out1.failedStep);
    expect(out2.trace.map((t: any) => ({ action: t.action, input: t.input }))).toEqual(
      out1.trace.map((t: any) => ({ action: t.action, input: t.input })),
    );
    expect(out2.failures.some((f: any) => f.type === 'dom-layout' && f.issue === 'horizontal-clip')).toBe(true);
  });

  it('exits with code 2 and saves trace on unhandled promise rejections and 5xx network errors', async () => {
    const rej = await setupFuzzHarness({ triggerUnhandledRejectionAtCount: 2 });
    const cRej = capture();
    expect(
      await fuzzMain(['--steps', '10', '--seed', 'rej-seed', '--port', String(rej.hub.port), '--dir', rej.dir], rej.dir, cRej.out, cRej.err),
    ).toBe(2);
    const outRej = cRej.json();
    expect(outRej.failedStep).toBe(2);
    expect(outRej.failures.some((f: any) => f.type === 'unhandled-rejection')).toBe(true);
    expect(readdirSync(join(rej.dir, '.reins', 'sessions')).some((f) => f.startsWith('fuzz-rej-seed-'))).toBe(true);

    const net = await setupFuzzHarness({ trigger5xxOnFetch: true });
    const cNet = capture();
    expect(
      await fuzzMain(['--steps', '25', '--seed', 'net-5xx-seed', '--port', String(net.hub.port), '--dir', net.dir], net.dir, cNet.out, cNet.err),
    ).toBe(2);
    const outNet = cNet.json();
    expect(outNet.failures.some((f: any) => f.type === 'http-5xx' && f.detail?.status === 502)).toBe(true);
  });

  it('requires --confirm with --allow-consequential and generates deterministic schema-valid payloads', async () => {
    const { dir, hub, invoked } = await setupFuzzHarness();
    const cRefuse = capture();
    expect(
      await fuzzMain(['--steps', '5', '--allow-consequential', '--port', String(hub.port), '--dir', dir], dir, cRefuse.out, cRefuse.err),
    ).toBe(2);
    expect(cRefuse.stderr.join('\n')).toMatch(/--allow-consequential requires --confirm/);
    expect(invoked).toHaveLength(0);

    const cAllow = capture();
    expect(
      await fuzzMain(
        ['--steps', '12', '--seed', '77', '--allow-consequential', '--confirm', '--port', String(hub.port), '--dir', dir],
        dir,
        cAllow.out,
        cAllow.err,
      ),
    ).toBe(0);
    expect(invoked.some((i) => i.name === 'delete-account')).toBe(true);

    const r1 = createRng('same-seed');
    const r2 = createRng('same-seed');
    const schema = {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        tags: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 2, maxLength: 6 } },
        count: { type: 'integer', minimum: 5, maximum: 10 },
      },
      required: ['email', 'tags', 'count', 'extraRequired'],
    };
    const v1: any = generateValueForSchema(schema, r1);
    const v2: any = generateValueForSchema(schema, r2);
    expect(v1).toEqual(v2);
    expect(v1.email).toMatch(/@example\.com$/);
    expect(v1.tags.length).toBeGreaterThanOrEqual(1);
    expect(v1.count).toBeGreaterThanOrEqual(5);
    expect(v1.count).toBeLessThanOrEqual(10);
    expect(typeof v1.extraRequired).toBe('string');

    // Schema generator edge cases: fixed min=max, multipleOf, maxLength=0, minItems>8, depth>=5 primitives.
    const edgeRng = createRng('edge-cases');
    for (let i = 0; i < 20; i++) {
      expect(generateValueForSchema({ type: 'integer', minimum: 5, maximum: 5 }, edgeRng)).toBe(5);
      expect(generateValueForSchema({ type: 'number', minimum: 0, maximum: 0 }, edgeRng)).toBe(0);
      const mult = generateValueForSchema({ type: 'integer', minimum: 1, maximum: 10, multipleOf: 5 }, edgeRng) as number;
      expect([5, 10]).toContain(mult);
      const decMult = generateValueForSchema({ type: 'number', minimum: 0.2, maximum: 1.0, multipleOf: 0.25 }, edgeRng) as number;
      expect([0.25, 0.5, 0.75, 1]).toContain(decMult);
      expect(generateValueForSchema({ type: 'string', maxLength: 0 }, edgeRng)).toBe('');
      const longArr = generateValueForSchema(
        { type: 'array', minItems: 10, maxItems: 12, items: { type: 'boolean' } },
        edgeRng,
      ) as unknown[];
      expect(longArr.length).toBeGreaterThanOrEqual(10);
      expect(longArr.length).toBeLessThanOrEqual(12);
    }
    const deep = generateValueForSchema(
      {
        type: 'object',
        required: ['a'],
        properties: {
          a: {
            type: 'object',
            required: ['b'],
            properties: {
              b: {
                type: 'object',
                required: ['c'],
                properties: {
                  c: {
                    type: 'object',
                    required: ['d'],
                    properties: {
                      d: {
                        type: 'object',
                        required: ['leaf'],
                        properties: { leaf: { type: 'string', const: 'ok' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      edgeRng,
    ) as any;
    expect(deep.a.b.c.d.leaf).toBe('ok');
    expect(generateValueForSchema({ type: 'object', required: ['leaf'], properties: { leaf: { type: 'string', format: 'uuid' } } }, edgeRng, 4)).toMatchObject({
      leaf: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4/),
    });
    expect(generateValueForSchema({ anyOf: [{ type: 'null' }, { type: 'string', format: 'date' }] }, edgeRng)).toBe('2026-01-15');
  });

  it('validates flags, handles safe server/empty actions, catches uncaught errors + DOM vertical-clip/zero-size, and skips fuzz artifacts in latestSession', async () => {
    const h = await setupFuzzHarness({ triggerUnhandledRejectionAtCount: 1 });
    const cHelp = capture();
    expect(await fuzzMain(['--help'], h.dir, cHelp.out, cHelp.err)).toBe(0);
    expect(cHelp.stdout.join('\n')).toMatch(/usage:/);

    for (const badArgs of [
      ['--steps', '0'],
      ['--steps', '-1'],
      ['--steps', '1.5'],
      ['--steps', 'abc'],
      ['--steps', '10001'],
      ['--seed', ''],
      ['--host', '0.0.0.0'],
      ['unexpected'],
    ]) {
      const cb = capture();
      expect(await fuzzMain(badArgs, h.dir, cb.out, cb.err)).toBe(2);
    }

    // Security checks: token unrotated, bad token rejected, path traversal slugged, saved trace redacted, symlink blocked.
    const tokenBefore = h.hub.token;
    const cSec = capture();
    expect(
      await fuzzMain(
        ['--steps', '3', '--seed', '../../etc/passwd', '--port', String(h.hub.port), '--dir', h.dir],
        h.dir,
        cSec.out,
        cSec.err,
      ),
    ).toBe(2);
    expect(h.hub.token).toBe(tokenBefore);
    const outSec = cSec.json();
    expect(outSec.artifact).toContain(join(h.dir, '.reins', 'sessions'));
    expect(outSec.artifact).not.toContain('etc/passwd');
    const savedRaw = readFileSync(outSec.artifact, 'utf8');
    expect(savedRaw).toContain('"schemaVersion": "1.0.0"');
    const savedJson = JSON.parse(savedRaw);
    for (const st of savedJson.trace) {
      if ('password' in st.input) expect(st.input.password).toBe('[redacted]');
    }
    // latestSession must skip fuzz-*.json so `reins report` keeps working.
    expect(latestSession(h.dir)).toBeUndefined();
    const realReportPath = join(h.dir, '.reins', 'sessions', '2026-11-15T10-00-00-000Z-demo.json');
    writeFileSync(realReportPath, JSON.stringify({ schemaVersion: 1 }));
    expect(latestSession(h.dir)).toBe(realReportPath);

    writeFileSync(join(h.dir, '.reins', 'token'), 'forged-token\n');
    const cBadTok = capture();
    expect(await fuzzMain(['--steps', '2', '--port', String(h.hub.port), '--dir', h.dir], h.dir, cBadTok.out, cBadTok.err)).toBe(2);
    expect(cBadTok.stderr.join('\n')).toMatch(/bad or missing token/);

    // Symlink/junction escape on .reins/sessions is refused.
    const symDir = makeProjectDir();
    const outsideDir = makeProjectDir();
    const symAudit = fileAudit(symDir, () => {});
    const symHub = await Hub.start({ dir: symDir, port: 0, log: () => {}, audit: symAudit, handshakeMs: 1000 });
    cleanup.push(() => symHub.close());
    const symListeners = new Map<string, Array<(e: any) => void>>();
    const symG: any = {
      console: { info() {}, log() {}, warn() {}, groupCollapsed() {}, groupEnd() {}, error() {} },
      addEventListener: (t: string, fn: (e: any) => void) => symListeners.set(t, [...(symListeners.get(t) ?? []), fn]),
      removeEventListener: () => {},
    };
    const symApp = createReins(symG);
    symApp.action({
      name: 'crash-window',
      description: 'Triggers window error',
      run: () => {
        for (const fn of symListeners.get('error') ?? []) fn({ error: new Error('window crash') });
        return { ok: true };
      },
    });
    await symApp.connect({ url: `ws://127.0.0.1:${symHub.port}`, token: symHub.token, WebSocket: WebSocket as any, reconnect: false, lazy: false });
    cleanup.push(() => symApp.disconnect());
    mkdirSync(join(symDir, '.reins'), { recursive: true });
    symlinkSync(outsideDir, join(symDir, '.reins', 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    const cSym = capture();
    expect(await fuzzMain(['--steps', '2', '--seed', 'sym', '--port', String(symHub.port), '--dir', symDir], symDir, cSym.out, cSym.err)).toBe(2);
    expect(cSym.stderr.join('\n')).toMatch(/outside project root/);

    // Safe non-consequential server actions, consequential-only app returning 0, vertical-clip & zero-size detection.
    const srvDir = makeProjectDir();
    const srvHub = await Hub.start({ dir: srvDir, port: 0, log: () => {}, audit: fileAudit(srvDir, () => {}), handshakeMs: 1000 });
    cleanup.push(() => srvHub.close());
    const srvOnly = createReinsNode({ NODE_ENV: 'development' });
    srvOnly.action({ name: 'only-danger', description: 'Danger', consequential: true, run: () => ({}) });
    await srvOnly.connect({ url: `ws://127.0.0.1:${srvHub.port}`, token: srvHub.token, WebSocket: WebSocket as any, reconnect: false, meta: { name: 'srv' } });
    cleanup.push(() => srvOnly.disconnect());
    const cEmpty = capture();
    expect(await fuzzMain(['--steps', '5', '--seed', 's', '--port', String(srvHub.port), '--dir', srvDir], srvDir, cEmpty.out, cEmpty.err)).toBe(0);
    expect(cEmpty.json().stepsRun).toBe(0);

    let zeroSize = false;
    const domDir = makeProjectDir();
    const domHub = await Hub.start({ dir: domDir, port: 0, log: () => {}, audit: fileAudit(domDir, () => {}), handshakeMs: 1000 });
    cleanup.push(() => domHub.close());
    const childZero: any = {
      tagName: 'SPAN',
      id: 'empty-badge',
      className: '',
      getAttribute: () => undefined,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: zeroSize ? 0 : 20, height: 10 }),
      scrollWidth: 20,
      clientWidth: 20,
      scrollHeight: 10,
      clientHeight: 10,
      childNodes: [],
      children: [],
    };
    const rootPanel: any = {
      tagName: 'SECTION',
      id: 'main',
      className: '',
      getAttribute: (k: string) => (k === 'data-reins' ? 'main' : undefined),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
      scrollWidth: 200,
      clientWidth: 200,
      get scrollHeight() {
        return zeroSize ? 180 : 100;
      },
      clientHeight: 100,
      childNodes: [],
      children: [childZero],
    };
    const domApp = createReins({
      console: { info() {}, log() {}, warn() {}, groupCollapsed() {}, groupEnd() {}, error() {} },
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      getComputedStyle: () => ({ display: 'block', overflowX: 'visible', overflowY: 'hidden', direction: 'ltr' }),
      document: { title: 'DOM Clip', readyState: 'complete', body: rootPanel, querySelector: () => rootPanel },
    } as any);
    domApp.registerPanel('main', () => ({ id: 'main', x: 0, y: 0, width: 200, height: 100, scrollX: 0, scrollY: 0, devicePixelRatio: 1, viewportWidth: 1280, viewportHeight: 800 }));
    await domApp.connect({ url: `ws://127.0.0.1:${domHub.port}`, token: domHub.token, WebSocket: WebSocket as any, reconnect: false, lazy: false });
    cleanup.push(() => domApp.disconnect());
    const domSrv = createReinsNode({ NODE_ENV: 'development' });
    domSrv.action({ name: 'trigger-clip', description: 'Triggers vertical clip and zero size', run: () => ((zeroSize = true), { ok: true }) });
    await domSrv.connect({ url: `ws://127.0.0.1:${domHub.port}`, token: domHub.token, WebSocket: WebSocket as any, reconnect: false, meta: { name: 'dom-srv' } });
    cleanup.push(() => domSrv.disconnect());
    const cDom = capture();
    expect(await fuzzMain(['--steps', '3', '--seed', 'dom', '--port', String(domHub.port), '--dir', domDir], domDir, cDom.out, cDom.err)).toBe(2);
    const issues = cDom.json().failures.map((f: any) => f.issue);
    expect(issues).toContain('vertical-clip');
    expect(issues).toContain('zero-size');
  });

  const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  it.skipIf(!existsSync(cliPath))('runs `reins fuzz` end-to-end via built CLI subprocess and preserves hook exit code 2', async () => {
    const h = await setupFuzzHarness({ triggerUnhandledRejectionAtCount: 1 });
    let exitCode = 0;
    let stdout = '';
    try {
      const res = await execFileAsync(
        process.execPath,
        [cliPath, 'fuzz', '--steps', '5', '--seed', 'cli-hook', '--port', String(h.hub.port), '--dir', h.dir],
        { cwd: h.dir },
      );
      stdout = res.stdout;
    } catch (e: any) {
      exitCode = e.code ?? 1;
      stdout = String(e.stdout ?? '');
    }
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(stdout);
    expect(parsed.failedStep).toBe(1);
    expect(parsed.failures.some((f: any) => f.type === 'unhandled-rejection')).toBe(true);
  });
});
