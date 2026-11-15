import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createReins } from '@mindmakr/reins';
import { createReinsNode } from '@mindmakr/reins/node';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
import WebSocket from 'ws';
import { fileAudit } from '../src/bridge/audit.js';
import { Hub } from '../src/bridge/hub.js';
import { execMain, packetMain, scenarioMain } from '../src/bridge/oneshot-cli.js';
import { tokenPath } from '../src/bridge/token.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function makeProjectDir() {
  const dir = mkdtempSync(join(tmpdir(), 'reins-oneshot-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFakeConsole() {
  return {
    info() {},
    log() {},
    warn() {},
    groupCollapsed() {},
    groupEnd() {},
    error(..._args: unknown[]) {},
  };
}

async function setupPairedApp(opts: { bufferSize?: number; withDom?: boolean } = {}) {
  const dir = makeProjectDir();
  const auditLines: string[] = [];
  const audit = fileAudit(dir, (l) => auditLines.push(l));
  const hub = await Hub.start({ dir, port: 0, log: () => {}, audit, handshakeMs: 1000 });
  cleanup.push(() => hub.close());

  let locale = 'en';
  let errorSeq = 0;
  const executed: string[] = [];
  const fakeConsole = makeFakeConsole();
  const fakePanelEl = {
    tagName: 'SECTION',
    id: 'summary',
    className: 'cards',
    getAttribute: (k: string) => (k === 'data-reins' ? 'summary' : undefined),
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 120 }),
    scrollWidth: 300,
    clientWidth: 300,
    scrollHeight: 120,
    clientHeight: 120,
    childNodes: [{ nodeType: 3, textContent: 'Summary panel' }],
    children: [],
  };
  const g: any = { console: fakeConsole };
  if (opts.withDom) {
    g.innerWidth = 1280;
    g.innerHeight = 800;
    g.devicePixelRatio = 1;
    g.document = {
      title: 'Test App',
      readyState: 'complete',
      body: fakePanelEl,
      querySelector: (sel: string) => (sel.includes('summary') ? fakePanelEl : null),
      querySelectorAll: () => [fakePanelEl],
      getElementsByTagName: () => [fakePanelEl],
    };
  }
  const app = createReins(g);
  app.action({
    name: 'set-locale',
    description: 'Switch locale',
    input: { type: 'object', properties: { locale: { type: 'string' }, password: { type: 'string' }, token: { type: 'string' } } },
    run: ({ locale: next }: any) => {
      locale = String(next ?? 'en');
      executed.push(`set-locale:${locale}`);
      return { locale };
    },
  });
  app.action({
    name: 'reset-db',
    description: 'Wipe dev DB',
    consequential: true,
    run: () => {
      executed.push('reset-db');
      return { reset: true };
    },
  });
  app.action({
    name: 'soft-fail',
    description: 'Returns ok: false',
    run: () => {
      executed.push('soft-fail');
      return { ok: false, reason: 'validation failed' };
    },
  });
  app.action({
    name: 'trigger-console-error',
    description: 'Logs an uncaught runtime console error',
    run: ({ label }: any = {}) => {
      errorSeq++;
      const tag = label ? String(label) : `err-${errorSeq}`;
      executed.push(`trigger-console-error:${tag}`);
      fakeConsole.error(`Uncaught TypeError: boom-${tag}`);
      return { triggered: tag };
    },
  });
  app.state('session', () => ({ locale, user: 'tess', token: 'super-secret-jwt', password: 'pw' }));

  const paired = await app.connect({
    url: `ws://127.0.0.1:${hub.port}`,
    token: hub.token,
    WebSocket: WebSocket as any,
    reconnect: false,
    lazy: false,
    ...(opts.bufferSize ? { bufferSize: opts.bufferSize } : {}),
  });
  expect(paired).toBe(true);
  cleanup.push(() => app.disconnect());

  return { dir, hub, executed };
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

describe('one-shot CLI (exec, scenario, packet)', () => {
  it('reins exec runs tools and actions, enforces confirm and token auth, and leaves browser token unrotated', async () => {
    const { dir, hub } = await setupPairedApp();
    const tokenBefore = hub.token;

    const c1 = capture();
    expect(await execMain(['reins_list_actions', '--port', String(hub.port), '--dir', dir], dir, c1.out, c1.err)).toBe(0);
    expect(c1.json().actions.map((a: any) => a.name)).toContain('set-locale');
    expect(hub.token).toBe(tokenBefore);

    const c2 = capture();
    expect(await execMain(['set-locale', '--input', '{"locale":"ar"}', '--port', String(hub.port), '--dir', dir], dir, c2.out, c2.err)).toBe(0);
    expect(c2.json()).toEqual({ locale: 'ar' });

    // Consequential action refused without --confirm (exit 2 and audited)
    const cRefuse = capture();
    expect(await execMain(['reset-db', '--port', String(hub.port), '--dir', dir], dir, cRefuse.out, cRefuse.err)).toBe(2);
    expect(cRefuse.stderr.join('\n')).toMatch(/confirm: true required/);

    const cConfirm = capture();
    expect(await execMain(['reset-db', '--confirm', '--port', String(hub.port), '--dir', dir], dir, cConfirm.out, cConfirm.err)).toBe(0);
    expect(cConfirm.json()).toEqual({ reset: true });

    // Action returning { ok: false } exits 2
    const cFail = capture();
    expect(await execMain(['soft-fail', '--port', String(hub.port), '--dir', dir], dir, cFail.out, cFail.err)).toBe(2);
    expect(cFail.json()).toEqual({ ok: false, reason: 'validation failed' });

    // Rejects arbitrary --host flag
    const cHost = capture();
    expect(await execMain(['reins_list_actions', '--host', 'evil.example', '--port', String(hub.port), '--dir', dir], dir, cHost.out, cHost.err)).toBe(2);
    expect(cHost.stderr.join('\n')).toMatch(/unknown option --host/);

    // Refuses invalid token and logs audit refusal
    writeFileSync(tokenPath(dir), 'forged-token\n');
    const cBadToken = capture();
    expect(await execMain(['reins_list_actions', '--port', String(hub.port), '--dir', dir], dir, cBadToken.out, cBadToken.err)).toBe(2);
    expect(cBadToken.stderr.join('\n')).toMatch(/bad or missing token/);

    const log = readFileSync(join(dir, '.reins', 'audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(log.some((e) => e.event === 'reins_run_action' && e.name === 'reset-db' && e.ok === false)).toBe(true);
    expect(log.some((e) => e.event === 'refused' && e.via === 'cli' && e.ok === false)).toBe(true);
  });

  it('reins scenario runs steps sequentially, asserts state, stops on failure or uncaught error, and redacts output', async () => {
    const { dir, hub, executed } = await setupPairedApp();
    const okFile = join(dir, 'ok-scenario.json');
    writeFileSync(
      okFile,
      JSON.stringify({
        steps: [
          { action: 'set-locale', input: { locale: 'fr' }, assertState: { session: { locale: 'fr' } } },
          { action: 'reset-db', confirm: true },
        ],
      }),
    );

    const cOk = capture();
    expect(await scenarioMain([okFile, '--port', String(hub.port), '--dir', dir], dir, cOk.out, cOk.err)).toBe(0);
    const okPacket = cOk.json();
    expect(okPacket.ok).toBe(true);
    expect(okPacket.steps.length).toBe(2);
    expect(okPacket.state.session.token).toBe('[redacted]');
    expect(okPacket.state.session.password).toBe('[redacted]');
    expect(JSON.stringify(okPacket)).not.toContain('super-secret-jwt');

    // Stops immediately when runtime error happens before reaching trailing step
    executed.length = 0;
    const errFile = join(dir, 'err-scenario.json');
    writeFileSync(
      errFile,
      JSON.stringify([
        { action: 'trigger-console-error' },
        { action: 'set-locale', input: { locale: 'should-not-run' } },
      ]),
    );
    const cErr = capture();
    expect(await scenarioMain([errFile, '--port', String(hub.port), '--dir', dir], dir, cErr.out, cErr.err)).toBe(2);
    const errPacket = cErr.json();
    expect(errPacket.ok).toBe(false);
    expect(errPacket.error).toMatch(/uncaught runtime error/);
    expect(executed).toEqual(['trigger-console-error:err-1']);

    // Stops on assertState mismatch
    executed.length = 0;
    const mismatchFile = join(dir, 'mismatch.json');
    writeFileSync(
      mismatchFile,
      JSON.stringify([
        { action: 'set-locale', input: { locale: 'de' }, assertState: { session: { locale: 'ar' } } },
        { action: 'reset-db', confirm: true },
      ]),
    );
    const cMis = capture();
    expect(await scenarioMain([mismatchFile, '--port', String(hub.port), '--dir', dir], dir, cMis.out, cMis.err)).toBe(2);
    expect(cMis.json().error).toMatch(/assertState failed/);
    expect(executed).toEqual(['set-locale:de']);
  });

  it('reins packet captures actions, redacted state, network, errors, and perf in one call', async () => {
    const { dir, hub } = await setupPairedApp();
    const c = capture();
    expect(await packetMain(['--port', String(hub.port), '--dir', dir], dir, c.out, c.err)).toBe(0);
    const pkt = c.json();
    expect(pkt.schemaVersion).toBe('1.0.0');
    expect(pkt.actions.actions.map((a: any) => a.name)).toContain('set-locale');
    expect(pkt.state.session).toEqual({ locale: 'en', user: 'tess', token: '[redacted]', password: '[redacted]' });
    expect(Array.isArray(pkt.network)).toBe(true);
    expect(Array.isArray(pkt.errors)).toBe(true);
    expect(pkt.perf.lifecycle).toBeDefined();
    expect(JSON.stringify(pkt)).not.toContain('super-secret-jwt');
  });

  it('preserves action inputSchema keys named password/token and state source key "session"', async () => {
    const { dir, hub } = await setupPairedApp();
    const cActions = capture();
    expect(await execMain(['reins_list_actions', '--port', String(hub.port), '--dir', dir], dir, cActions.out, cActions.err)).toBe(0);
    const setLocale = cActions.json().actions.find((a: any) => a.name === 'set-locale');
    expect(Object.keys(setLocale.input.properties)).toEqual(['locale', 'password', 'token']);

    const cState = capture();
    expect(await execMain(['reins_state', '--port', String(hub.port), '--dir', dir], dir, cState.out, cState.err)).toBe(0);
    expect(cState.json()).toEqual({ session: { locale: 'en', user: 'tess', token: '[redacted]', password: '[redacted]' } });
  });

  it('tracks errors across allowErrors: true steps and ring-buffer wraparound', async () => {
    const { dir, hub, executed } = await setupPairedApp({ bufferSize: 3 });
    const allowThenPass = join(dir, 'allow-then-pass.json');
    writeFileSync(
      allowThenPass,
      JSON.stringify([
        { action: 'trigger-console-error', input: { label: 'e1' }, allowErrors: true },
        { action: 'trigger-console-error', input: { label: 'e2' }, allowErrors: true },
        { action: 'set-locale', input: { locale: 'es' }, assertState: { session: { locale: 'es' } } },
      ]),
    );
    const cPass = capture();
    expect(await scenarioMain([allowThenPass, '--port', String(hub.port), '--dir', dir], dir, cPass.out, cPass.err)).toBe(0);
    expect(cPass.json().ok).toBe(true);

    // Fill the bufferSize: 3 ring buffer, then trigger a 4th error on a checked step.
    executed.length = 0;
    const overflowFile = join(dir, 'overflow.json');
    writeFileSync(
      overflowFile,
      JSON.stringify([
        { action: 'trigger-console-error', input: { label: 'e3' }, allowErrors: true },
        { action: 'trigger-console-error', input: { label: 'e4' }, allowErrors: true },
        { action: 'trigger-console-error', input: { label: 'e5' } },
      ]),
    );
    const cOverflow = capture();
    expect(await scenarioMain([overflowFile, '--port', String(hub.port), '--dir', dir], dir, cOverflow.out, cOverflow.err)).toBe(2);
    expect(cOverflow.json().ok).toBe(false);
    expect(cOverflow.json().error).toMatch(/uncaught runtime error/);
  });

  it('survives mid-scenario browser token rotation', async () => {
    const { dir, hub } = await setupPairedApp();
    let rotated = false;
    let locale = 'en';

    // Pair a browser client that registers a step triggering a second full Reins browser client
    // (simulating an HMR/tab reload mid-scenario that rotates hub.token).
    const peerA = createReins({ console: makeFakeConsole() as any });
    peerA.action({
      name: 'trigger-rotation',
      description: 'Connects another Reins browser client to rotate hub.token mid-scenario',
      run: async () => {
        const peerB = createReins({ console: makeFakeConsole() as any });
        peerB.action({
          name: 'set-locale',
          description: 'Switch locale',
          run: ({ locale: next }: any) => {
            locale = String(next ?? 'en');
            return { locale };
          },
        });
        peerB.state('session', () => ({ locale, user: 'tess', token: 'super-secret-jwt' }));
        const connected = await peerB.connect({
          url: `ws://127.0.0.1:${hub.port}`,
          token: hub.token,
          WebSocket: WebSocket as any,
          reconnect: false,
          lazy: false,
        });
        expect(connected).toBe(true);
        cleanup.push(() => peerB.disconnect());
        rotated = true;
        return { rotated: true };
      },
    });
    const pA = await peerA.connect({
      url: `ws://127.0.0.1:${hub.port}`,
      token: hub.token,
      WebSocket: WebSocket as any,
      reconnect: false,
      lazy: false,
    });
    expect(pA).toBe(true);
    cleanup.push(() => peerA.disconnect());

    const tokenBefore = hub.token;
    const rotScenario = join(dir, 'rotate.json');
    writeFileSync(
      rotScenario,
      JSON.stringify([
        { action: 'trigger-rotation' },
        { action: 'set-locale', input: { locale: 'ja' }, assertState: { session: { locale: 'ja' } } },
      ]),
    );
    const cRot = capture();
    expect(await scenarioMain([rotScenario, '--port', String(hub.port), '--dir', dir], dir, cRot.out, cRot.err)).toBe(0);
    expect(rotated).toBe(true);
    expect(hub.token).not.toBe(tokenBefore);
    expect(cRot.json().ok).toBe(true);
    expect(cRot.json().state.session.locale).toBe('ja');
  });

  it('honors per-step confirm: false over --confirm', async () => {
    const { dir, hub, executed } = await setupPairedApp();
    const confirmFalseFile = join(dir, 'confirm-false.json');
    writeFileSync(confirmFalseFile, JSON.stringify([{ action: 'reset-db', confirm: false }]));
    const cNoConfirm = capture();
    expect(await scenarioMain([confirmFalseFile, '--confirm', '--port', String(hub.port), '--dir', dir], dir, cNoConfirm.out, cNoConfirm.err)).toBe(2);
    expect(cNoConfirm.json().error).toMatch(/confirm: true required/);
    expect(executed).toEqual([]);
  });

  it('reins packet --panel --snap includes DOM tree and panel snap box', async () => {
    const { dir, hub } = await setupPairedApp({ withDom: true });
    const c = capture();
    expect(await packetMain(['--panel', 'summary', '--snap', '--port', String(hub.port), '--dir', dir], dir, c.out, c.err)).toBe(0);
    const pkt = c.json();
    expect(pkt.dom.tag).toBe('section');
    expect(pkt.dom.panel).toBe('summary');
    expect(pkt.snap.box.id).toBe('summary');
  });

  it('reins exec --target server invokes paired @mindmakr/reins/node actions', async () => {
    const { dir, hub } = await setupPairedApp();
    const rn = createReinsNode({ NODE_ENV: 'development' });
    rn.action({
      name: 'ping-server',
      description: 'Server-side ping',
      readOnly: true,
      run: ({ msg }: any) => ({ pong: msg ?? 'ok' }),
    });
    const paired = await rn.connect({
      url: `ws://127.0.0.1:${hub.port}`,
      token: hub.token,
      WebSocket: WebSocket as any,
      reconnect: false,
      meta: { name: 'api' },
    });
    expect(paired).toBe(true);
    cleanup.push(() => rn.disconnect());

    const c = capture();
    expect(
      await execMain(['ping-server', '--target', 'server', '--input', '{"msg":"hi"}', '--port', String(hub.port), '--dir', dir], dir, c.out, c.err),
    ).toBe(0);
    expect(c.json()).toEqual({ pong: 'hi' });
  });

  const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  it.skipIf(!existsSync(cliPath))('exec, scenario, and packet run cleanly through the built CLI subprocess', async () => {
    const { dir, hub } = await setupPairedApp({ withDom: true });
    const scenarioFile = join(dir, 'subproc.json');
    writeFileSync(scenarioFile, JSON.stringify([{ action: 'set-locale', input: { locale: 'pt' }, assertState: { session: { locale: 'pt' } } }]));

    const runCli = async (args: string[]) => {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: dir });
      return JSON.parse(stdout);
    };

    const execOut = await runCli(['exec', 'set-locale', '--input', '{"locale":"de"}', '--port', String(hub.port), '--dir', dir]);
    expect(execOut).toEqual({ locale: 'de' });

    const scenOut = await runCli(['scenario', scenarioFile, '--port', String(hub.port), '--dir', dir]);
    expect(scenOut.ok).toBe(true);
    expect(scenOut.state.session.locale).toBe('pt');

    const pktOut = await runCli(['packet', '--panel', 'summary', '--port', String(hub.port), '--dir', dir]);
    expect(pktOut.schemaVersion).toBe('1.0.0');
    expect(pktOut.dom.panel).toBe('summary');
  });
});
