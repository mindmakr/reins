import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createReins } from '@mindmakr/reins';
import { createReinsNode } from '@mindmakr/reins/node';
import { main as verifyMain } from '@mindmakr/reins/verify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fileAudit } from '../src/bridge/audit.js';
import { Hub } from '../src/bridge/hub.js';
import { buildFeatureMap, mapMain } from '../src/bridge/map-cli.js';

const execFileAsync = promisify(execFile);

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'reins-map-'));
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

async function setupBridgeWithAppAndServer() {
  const dir = makeTempDir();
  const audit = fileAudit(dir, () => {});
  const hub = await Hub.start({ dir, port: 0, log: () => {}, audit, handshakeMs: 1000 });
  cleanup.push(() => hub.close());

  const app = createReins({
    console: { info() {}, log() {}, warn() {}, groupCollapsed() {}, groupEnd() {}, error() {} },
  } as any);
  app.action({
    name: 'submit-login',
    description: 'Submit sign-in form',
    input: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        password: { type: 'string' },
        token: { type: 'string' },
      },
      required: ['email', 'password'],
    },
    run: () => ({ ok: true }),
  });
  app.action({
    name: 'wipe-cache',
    description: 'Clear cached responses',
    consequential: true,
    run: () => ({ cleared: true }),
  });
  app.state('session', () => ({ user: 'ada', role: 'admin' }));
  app.registerPanel('summary', () => ({
    id: 'summary',
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
    meta: { env: 'dev', apiKey: 'must-be-redacted' },
  });
  expect(pairedApp).toBe(true);
  cleanup.push(() => app.disconnect());

  const rn = createReinsNode({ NODE_ENV: 'development' });
  rn.action({
    name: 'reseed-dev',
    description: 'Reseed dev fixtures',
    consequential: true,
    run: () => ({ seeded: true }),
  });
  const pairedNode = await rn.connect({
    url: `ws://127.0.0.1:${hub.port}`,
    token: hub.token,
    WebSocket: WebSocket as any,
    reconnect: false,
    meta: { name: 'billing-api', secret: 'server-secret' },
  });
  expect(pairedNode).toBe(true);
  cleanup.push(() => rn.disconnect());

  return { dir, hub };
}

describe('reins map (feature-map.json export)', () => {
  it('exports live client actions, server actions, states, and panels to feature-map.json while redacting meta secrets', async () => {
    const { dir, hub } = await setupBridgeWithAppAndServer();
    const tokenBefore = hub.token;

    const c = capture();
    expect(await mapMain(['--port', String(hub.port), '--dir', dir], dir, c.out, c.err)).toBe(0);
    expect(hub.token).toBe(tokenBefore);

    const summary = c.json();
    expect(summary.ok).toBe(true);
    expect(summary.source).toBe('live');

    const written = JSON.parse(readFileSync(join(dir, 'feature-map.json'), 'utf8'));
    expect(written.schemaVersion).toBe('1.0.0');
    expect(written.source).toBe('live');
    expect(written.states).toEqual(['session']);
    expect(written.panels).toEqual(['summary']);

    // Input schema keys named `password` and `token` stay intact while app/server meta secrets are redacted.
    const submit = written.actions.find((a: any) => a.name === 'submit-login');
    expect(submit).toBeDefined();
    expect(submit.target).toBe('app');
    expect(Object.keys(submit.input.properties)).toEqual(['email', 'password', 'token']);

    const reseed = written.actions.find((a: any) => a.name === 'reseed-dev');
    expect(reseed).toMatchObject({ name: 'reseed-dev', consequential: true, target: 'server', server: 'billing-api' });

    expect(written.app.meta).toEqual({ env: 'dev', apiKey: '[redacted]' });
    expect(written.servers[0].meta).toMatchObject({ name: 'billing-api', platform: 'node', secret: '[redacted]' });
    expect(JSON.stringify(written)).not.toContain('server-secret');
    expect(JSON.stringify(written)).not.toContain('must-be-redacted');
  });

  it('merges live bridge contracts with static Coordinator surfaces and runs cleanly in --offline mode', async () => {
    const { dir, hub } = await setupBridgeWithAppAndServer();
    const staticFile = join(dir, 'coord-map.json');
    writeFileSync(
      staticFile,
      JSON.stringify({
        surfaces: [
          { id: 'route:GET /api/invoices a.ts', kind: 'route', method: 'GET', path: '/api/invoices', file: 'src/routes/invoices.ts', line: 12 },
          { id: 'screen:/checkout b.tsx', kind: 'screen', path: '/checkout', file: 'src/pages/checkout.tsx', line: 1 },
        ],
        panels: ['checkout', 'summary'],
        routes: ['/health'],
        screens: ['/login'],
        // Stale static entries for live actions must never overwrite live schemas or consequential flags.
        actions: [
          { name: 'wipe-cache', description: 'stale static copy', consequential: false },
          { name: 'reseed-dev', target: 'server', server: 'billing-api', description: 'stale server copy', consequential: false },
          { name: 'static-only', description: 'Offline route action', consequential: false },
        ],
      }),
    );

    const outPath = join(dir, 'out', 'custom-map.json');
    const cMerged = capture();
    expect(await mapMain(['--port', String(hub.port), '--dir', dir, '--static', staticFile, '--out', outPath], dir, cMerged.out, cMerged.err)).toBe(0);
    const merged = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(merged.source).toBe('merged');
    expect(merged.panels).toEqual(['checkout', 'summary']);
    expect(merged.actions.map((a: any) => a.name)).toContain('submit-login');
    expect(merged.actions.find((a: any) => a.name === 'wipe-cache')).toMatchObject({ consequential: true, target: 'app' });
    expect(merged.actions.find((a: any) => a.name === 'reseed-dev')).toMatchObject({ consequential: true, target: 'server', server: 'billing-api' });
    expect(merged.actions.find((a: any) => a.name === 'static-only')).toMatchObject({ description: 'Offline route action', target: 'app' });
    expect(merged.routes).toEqual([
      { method: 'GET', path: '/api/invoices', file: 'src/routes/invoices.ts', line: 12, id: 'route:GET /api/invoices a.ts' },
      { path: '/health' },
    ]);
    expect(merged.screens).toEqual([
      { path: '/checkout', file: 'src/pages/checkout.tsx', line: 1, id: 'screen:/checkout b.tsx' },
      { path: '/login' },
    ]);

    // Offline export with --static --stdout needs no running bridge and creates no default file.
    const offlineDir = makeTempDir();
    writeFileSync(join(offlineDir, 'static.json'), JSON.stringify({ routes: [{ method: 'POST', path: '/api/pay' }], panels: ['cart'] }));
    const cOff = capture();
    expect(await mapMain(['--static', join(offlineDir, 'static.json'), '--offline', '--stdout', '--dir', offlineDir], offlineDir, cOff.out, cOff.err)).toBe(0);
    expect(existsSync(join(offlineDir, 'feature-map.json'))).toBe(false);
    const offMap = cOff.json();
    expect(offMap.source).toBe('static');
    expect(offMap.panels).toEqual(['cart']);
    expect(offMap.routes).toEqual([{ method: 'POST', path: '/api/pay' }]);
  });

  it('keeps production bundles clean under reins verify even with feature-map.json present', async () => {
    const dir = makeTempDir();
    const distDir = join(dir, 'dist');
    mkdirSync(distDir, { recursive: true });
    const featureMap = buildFeatureMap(
      {
        app: { url: 'http://localhost:5173/', title: 'Demo' },
        actions: [{ name: 'toggle-theme', description: 'Switch theme', consequential: false, readOnly: false }],
        states: ['theme'],
        panels: ['hero'],
      },
      { routes: [{ method: 'GET', path: '/' }], screens: [{ path: '/' }] },
    );
    writeFileSync(join(distDir, 'app.js'), 'console.log("production bundle");\n');
    writeFileSync(join(distDir, 'feature-map.json'), JSON.stringify(featureMap, null, 2));

    const c = capture();
    expect(verifyMain([distDir], c.out, c.err)).toBe(0);
    expect(c.stdout.join('\n')).toContain('clean');
  });

  it('validates flags and fails cleanly with exit 2 when inputs or bridge are missing', async () => {
    const dir = makeTempDir();

    const cHelp = capture();
    expect(await mapMain(['--help'], dir, cHelp.out, cHelp.err)).toBe(0);
    expect(cHelp.stdout.join('\n')).toContain('reins map');

    const cOfflineNoStatic = capture();
    expect(await mapMain(['--offline'], dir, cOfflineNoStatic.out, cOfflineNoStatic.err)).toBe(2);
    expect(cOfflineNoStatic.stderr.join('\n')).toMatch(/--offline requires --static/);

    const cBadPos = capture();
    expect(await mapMain(['extra-arg'], dir, cBadPos.out, cBadPos.err)).toBe(2);
    expect(cBadPos.stderr.join('\n')).toMatch(/unexpected argument/);

    const badStatic = join(dir, 'bad.json');
    writeFileSync(badStatic, '{not json');
    const cBadJson = capture();
    expect(await mapMain(['--static', badStatic, '--offline'], dir, cBadJson.out, cBadJson.err)).toBe(2);
    expect(cBadJson.stderr.join('\n')).toMatch(/not valid JSON/);

    const cNoToken = capture();
    expect(await mapMain(['--dir', dir], dir, cNoToken.out, cNoToken.err)).toBe(2);
    expect(cNoToken.stderr.join('\n')).toMatch(/missing bridge token/);

    // Empty flag values, --host, missing static file, non-object static JSON, and forged tokens are rejected.
    const cEmptyOut = capture();
    expect(await mapMain(['--out', ''], dir, cEmptyOut.out, cEmptyOut.err)).toBe(2);
    expect(cEmptyOut.stderr.join('\n')).toMatch(/--out needs a value/);

    const cEmptyStatic = capture();
    expect(await mapMain(['--static', '', '--offline'], dir, cEmptyStatic.out, cEmptyStatic.err)).toBe(2);
    expect(cEmptyStatic.stderr.join('\n')).toMatch(/--static needs a value/);

    const cHost = capture();
    expect(await mapMain(['--host', '0.0.0.0'], dir, cHost.out, cHost.err)).toBe(2);
    expect(cHost.stderr.join('\n')).toMatch(/unknown option --host/);

    const cMissingStatic = capture();
    expect(await mapMain(['--static', join(dir, 'nope.json'), '--offline'], dir, cMissingStatic.out, cMissingStatic.err)).toBe(2);
    expect(cMissingStatic.stderr.join('\n')).toMatch(/cannot read static map/);

    const arrStatic = join(dir, 'arr.json');
    writeFileSync(arrStatic, '[]');
    const cArrStatic = capture();
    expect(await mapMain(['--static', arrStatic, '--offline'], dir, cArrStatic.out, cArrStatic.err)).toBe(2);
    expect(cArrStatic.stderr.join('\n')).toMatch(/must be a JSON object/);

    const { dir: liveDir, hub } = await setupBridgeWithAppAndServer();
    writeFileSync(join(liveDir, '.reins', 'token'), 'forged-token\n');
    const cBadToken = capture();
    expect(await mapMain(['--port', String(hub.port), '--dir', liveDir], liveDir, cBadToken.out, cBadToken.err)).toBe(2);
    expect(cBadToken.stderr.join('\n')).toMatch(/bad or missing token/);
  });

  it('handles relative cwd without doubling paths and falls back to server title when meta.name is empty', async () => {
    const built = buildFeatureMap({
      actions: [],
      states: [],
      panels: [],
      servers: [{ client: 1, title: 'worker-proc', meta: { name: '' }, actions: [{ name: 'ping', consequential: false }] }],
    });
    expect(built.actions[0]).toMatchObject({ name: 'ping', target: 'server', server: 'worker-proc' });

    const relParent = mkdtempSync(join(tmpdir(), 'reins-map-rel-'));
    cleanup.push(() => rmSync(relParent, { recursive: true, force: true }));
    writeFileSync(join(relParent, 'static.json'), JSON.stringify({ panels: ['main'] }));
    const origCwd = process.cwd();
    const child = mkdtempSync(join(process.cwd(), '.reins-rel-tmp-'));
    cleanup.push(() => rmSync(child, { recursive: true, force: true }));
    const relChild = child.slice(origCwd.length + 1);
    const c = capture();
    expect(await mapMain(['--static', join(relParent, 'static.json'), '--offline'], relChild, c.out, c.err)).toBe(0);
    expect(existsSync(join(child, 'feature-map.json'))).toBe(true);
  });

  const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  it.skipIf(!existsSync(cliPath))('runs `reins map` end-to-end via the built CLI subprocess', async () => {
    const { dir, hub } = await setupBridgeWithAppAndServer();
    const { stdout } = await execFileAsync(process.execPath, [cliPath, 'map', '--port', String(hub.port), '--dir', dir], { cwd: dir });
    const summary = JSON.parse(stdout);
    expect(summary.ok).toBe(true);
    expect(summary.source).toBe('live');

    const written = JSON.parse(readFileSync(join(dir, 'feature-map.json'), 'utf8'));
    expect(written.panels).toEqual(['summary']);
    expect(written.states).toEqual(['session']);
    expect(written.actions.map((a: any) => a.name)).toContain('submit-login');
  });
});
