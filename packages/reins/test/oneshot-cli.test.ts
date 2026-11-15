import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReins } from '@mindmakr/reins';
import { afterEach, describe, expect, it } from 'vitest';
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

async function setupPairedApp() {
  const dir = makeProjectDir();
  const auditLines: string[] = [];
  const audit = fileAudit(dir, (l) => auditLines.push(l));
  const hub = await Hub.start({ dir, port: 0, log: () => {}, audit, handshakeMs: 1000 });
  cleanup.push(() => hub.close());

  let locale = 'en';
  const executed: string[] = [];
  const fakeConsole = makeFakeConsole();
  const app = createReins({ console: fakeConsole as any });
  app.action({
    name: 'set-locale',
    description: 'Switch locale',
    input: { type: 'object', properties: { locale: { type: 'string' } } },
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
    run: () => {
      executed.push('trigger-console-error');
      fakeConsole.error('Uncaught TypeError: cannot read properties of undefined');
      return { triggered: true };
    },
  });
  app.state('session', () => ({ locale, user: 'tess', token: 'super-secret-jwt', password: 'pw' }));

  const paired = await app.connect({
    url: `ws://127.0.0.1:${hub.port}`,
    token: hub.token,
    WebSocket: WebSocket as any,
    reconnect: false,
    lazy: false,
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
    expect(executed).toEqual(['trigger-console-error']);

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
});
