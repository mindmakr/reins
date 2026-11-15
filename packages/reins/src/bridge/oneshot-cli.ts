import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redactDeep } from '@mindmakr/reins';
import WebSocket from 'ws';
import { DEFAULT_PORT, HOST } from './hub.js';
import { tokenPath } from './token.js';

export const ONESHOT_USAGE = `usage:
  reins exec <tool_or_action> [--input '<json>'] [--confirm] [--target app|server] [--port <n>] [--dir <path>] [--timeout <ms>]
  reins scenario <file.json> [--confirm] [--panel <id>] [--port <n>] [--dir <path>] [--timeout <ms>]
  reins packet [--panel <id>] [--snap] [--port <n>] [--dir <path>] [--timeout <ms>]

Connects to the running local reins bridge on 127.0.0.1 using the token in <dir>/.reins/token, runs the check, and prints redacted JSON.`;

export interface BridgeCallOptions {
  port?: number;
  dir?: string;
  timeoutMs?: number;
  name: string;
  args?: Record<string, unknown>;
}

export interface BridgeClient {
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface ScenarioStep {
  action?: string;
  tool?: string;
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
  confirm?: boolean;
  target?: 'app' | 'server';
  assertState?: Record<string, unknown>;
  assertNoErrors?: boolean;
  allowErrors?: boolean;
}

export interface ScenarioFile {
  steps: ScenarioStep[];
  panel?: string;
  assertNoErrors?: boolean;
}

export type Printer = (line: string) => void;

export function readBridgeToken(projectDir: string): string {
  const file = tokenPath(resolve(projectDir));
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`missing bridge token at ${file}; start the reins bridge first`);
  }
  if (!raw) throw new Error(`empty bridge token at ${file}; start the reins bridge first`);
  return raw;
}

export function openBridgeClient(opts: { port?: number; dir?: string; timeoutMs?: number } = {}): Promise<BridgeClient> {
  const port = opts.port ?? DEFAULT_PORT;
  const dir = opts.dir ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // Loopback only: HOST is constant 127.0.0.1 with no remote override.
  const url = `ws://${HOST}:${port}`;
  return new Promise((resolveClient, rejectClient) => {
    let token: string;
    try {
      token = readBridgeToken(dir);
    } catch (err) {
      rejectClient(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const ws = new WebSocket(url);
    let nextId = 1;
    let settled = false;
    let sentToken = false;
    const inflight = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

    const failAll = (err: Error) => {
      for (const [id, p] of inflight) {
        inflight.delete(id);
        clearTimeout(p.timer);
        p.reject(err);
      }
      if (!settled) {
        settled = true;
        rejectClient(err);
      }
    };

    const connectTimer = setTimeout(() => {
      ws.terminate();
      failAll(new Error(`timed out connecting to bridge on ${HOST}:${port}`));
    }, timeoutMs);

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(connectTimer);
      failAll(new Error(`bridge rejected WebSocket connection (HTTP ${res.statusCode})`));
    });
    ws.on('error', (err: any) => {
      clearTimeout(connectTimer);
      failAll(new Error(`cannot reach bridge on ${HOST}:${port}: ${err?.message ?? err}`));
    });
    ws.on('close', (code, reason) => {
      clearTimeout(connectTimer);
      const why = reason?.toString() || `code ${code}`;
      failAll(new Error(`bridge closed connection (${why})`));
    });
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'refused') {
        failAll(new Error(String(msg.reason || 'bridge refused connection')));
        ws.close();
        return;
      }
      if (msg.type === 'cli-result' && typeof msg.id === 'number') {
        const entry = inflight.get(msg.id);
        if (!entry) return;
        inflight.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(String(msg.error || 'tool call failed')));
      }
    });
    ws.on('open', () => {
      clearTimeout(connectTimer);
      settled = true;
      resolveClient({
        call(name: string, args: Record<string, unknown> = {}) {
          return new Promise((res, rej) => {
            if (ws.readyState !== WebSocket.OPEN) {
              rej(new Error('bridge socket is not open'));
              return;
            }
            const id = nextId++;
            const timer = setTimeout(() => {
              inflight.delete(id);
              rej(new Error(`tool "${name}" timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            inflight.set(id, { resolve: res, reject: rej, timer });
            const frame = sentToken ? { type: 'cli', id, name, args } : { type: 'cli', id, token, name, args };
            sentToken = true;
            ws.send(JSON.stringify(frame));
          });
        },
        close() {
          return new Promise((done) => {
            if (ws.readyState === WebSocket.CLOSED) {
              done();
              return;
            }
            ws.once('close', () => done());
            ws.close();
            setTimeout(() => {
              if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
              done();
            }, 250).unref?.();
          });
        },
      });
    });
  });
}

export async function callBridge(opts: BridgeCallOptions): Promise<unknown> {
  const client = await openBridgeClient(opts);
  try {
    return await client.call(opts.name, opts.args ?? {});
  } finally {
    await client.close();
  }
}

export interface CommonCliFlags {
  port: number;
  dir: string;
  timeoutMs: number;
  help: boolean;
  positional: string[];
}

function takeValue(args: string[], flag: string): string {
  const v = args.shift();
  if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
  return v;
}

export function parseFlags(argv: string[], cwd: string, valueFlags: Set<string>, boolFlags: Set<string>): {
  common: CommonCliFlags;
  values: Record<string, string>;
  bools: Set<string>;
} {
  const args = [...argv];
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];
  let port = DEFAULT_PORT;
  let dir = resolve(cwd);
  let timeoutMs = 15_000;
  let help = false;

  while (args.length) {
    const a = args.shift()!;
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--port') {
      const n = Number(takeValue(args, a));
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port must be 1-65535');
      port = n;
    } else if (a === '--dir') dir = resolve(cwd, takeValue(args, a));
    else if (a === '--timeout') {
      const n = Number(takeValue(args, a));
      if (!Number.isInteger(n) || n < 100 || n > 120_000) throw new Error('--timeout must be 100-120000 ms');
      timeoutMs = n;
    } else if (valueFlags.has(a)) {
      values[a] = takeValue(args, a);
    } else if (boolFlags.has(a)) {
      bools.add(a);
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { common: { port, dir, timeoutMs, help, positional }, values, bools };
}

function matchesSubset(actual: unknown, expected: unknown, path = 'state'): string | null {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(actual, expected) ? null : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return `${path}: expected array of length ${expected.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const mismatch = matchesSubset(actual[i], expected[i], `${path}[${i}]`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    return `${path}: expected object, got ${JSON.stringify(actual)}`;
  }
  for (const [k, v] of Object.entries(expected)) {
    const mismatch = matchesSubset((actual as Record<string, unknown>)[k], v, `${path}.${k}`);
    if (mismatch) return mismatch;
  }
  return null;
}

function isActionFailure(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && !Array.isArray(result) && (result as Record<string, unknown>).ok === false);
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

export function diffNewErrors(prev: unknown[], curr: unknown[]): unknown[] {
  if (!curr.length) return [];
  if (!prev.length) return curr;
  const prevKeys = prev.map((e) => JSON.stringify(e));
  const currKeys = curr.map((e) => JSON.stringify(e));
  const maxOverlap = Math.min(prevKeys.length, currKeys.length);
  for (let k = maxOverlap; k >= 1; k--) {
    let matched = true;
    const startPrev = prevKeys.length - k;
    for (let i = 0; i < k; i++) {
      if (prevKeys[startPrev + i] !== currKeys[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return curr.slice(k);
  }
  return curr;
}

export function redactStateMap(state: unknown): unknown {
  if (!isPlainObj(state)) return redactDeep(state);
  return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, redactDeep(v)]));
}

function redactResult(value: unknown, toolName?: string): unknown {
  if (toolName === 'reins_state') return redactStateMap(value);
  if (toolName === 'reins_list_actions') return value;
  return redactDeep(value);
}

const formatOut = (value: unknown, toolName?: string) => JSON.stringify(redactResult(value, toolName), null, 2);

/** Runs `reins exec <tool_or_action>` once against the local bridge. Returns 0 on success, 2 on error/refusal. */
export async function execMain(
  argv: string[],
  cwd = process.cwd(),
  print: Printer = (s) => process.stdout.write(s + '\n'),
  err: Printer = (s) => process.stderr.write(s + '\n'),
): Promise<number> {
  try {
    const { common, values, bools } = parseFlags(argv, cwd, new Set(['--input', '--target']), new Set(['--confirm']));
    if (common.help) {
      print(ONESHOT_USAGE);
      return 0;
    }
    const target = common.positional[0];
    if (!target || common.positional.length > 1) {
      err(`reins exec: expected <tool_or_action>\n\n${ONESHOT_USAGE}`);
      return 2;
    }
    let parsedInput: Record<string, unknown> | undefined;
    if (values['--input'] !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(values['--input']);
      } catch {
        throw new Error('--input must be valid JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('--input must be a JSON object');
      }
      parsedInput = parsed as Record<string, unknown>;
    }
    const targetSide = values['--target'];
    if (targetSide !== undefined && targetSide !== 'app' && targetSide !== 'server') {
      throw new Error('--target must be app or server');
    }
    const confirm = bools.has('--confirm');
    const isTool = target.startsWith('reins_');
    const toolName = isTool ? target : 'reins_run_action';
    const toolArgs: Record<string, unknown> = isTool
      ? { ...(parsedInput ?? {}), ...(confirm ? { confirm: true } : {}) }
      : {
          name: target,
          ...(parsedInput !== undefined ? { input: parsedInput } : {}),
          ...(confirm ? { confirm: true } : {}),
          ...(targetSide ? { target: targetSide } : {}),
        };

    const result = await callBridge({
      port: common.port,
      dir: common.dir,
      timeoutMs: common.timeoutMs,
      name: toolName,
      args: toolArgs,
    });
    const failed = isActionFailure(result);
    print(formatOut(result, toolName));
    return failed ? 2 : 0;
  } catch (e: any) {
    const message = e?.message ? String(e.message) : String(e);
    err(`reins exec: ${message}`);
    return 2;
  }
}

function normalizeScenario(raw: unknown): ScenarioFile {
  if (Array.isArray(raw)) return { steps: raw as ScenarioStep[] };
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).steps)) return raw as ScenarioFile;
  throw new Error('scenario file must be a step array or an object with steps[]');
}

/** Runs a JSON scenario against the running local bridge and prints a redacted packet. */
export async function scenarioMain(
  argv: string[],
  cwd = process.cwd(),
  print: Printer = (s) => process.stdout.write(s + '\n'),
  err: Printer = (s) => process.stderr.write(s + '\n'),
): Promise<number> {
  let client: BridgeClient | null = null;
  try {
    const { common, values, bools } = parseFlags(argv, cwd, new Set(['--panel']), new Set(['--confirm']));
    if (common.help) {
      print(ONESHOT_USAGE);
      return 0;
    }
    const fileArg = common.positional[0];
    if (!fileArg || common.positional.length > 1) {
      err(`reins scenario: expected <file.json>\n\n${ONESHOT_USAGE}`);
      return 2;
    }
    const scenario = normalizeScenario(JSON.parse(readFileSync(resolve(cwd, fileArg), 'utf8')));
    const defaultConfirm = bools.has('--confirm');
    const panel = values['--panel'] ?? scenario.panel;
    client = await openBridgeClient({ port: common.port, dir: common.dir, timeoutMs: common.timeoutMs });

    const baselineErrors = await client.call('reins_errors', {});
    let seenErrors: unknown[] = Array.isArray(baselineErrors) ? baselineErrors : [];
    const stepResults: Array<Record<string, unknown>> = [];
    let ok = true;
    let failureReason: string | undefined;

    for (let i = 0; i < scenario.steps.length; i++) {
      const rawStep = scenario.steps[i];
      if (!isPlainObj(rawStep)) {
        ok = false;
        failureReason = `step ${i + 1}: step must be an object`;
        stepResults.push({ step: i + 1, ok: false, error: failureReason });
        break;
      }
      const step = rawStep as ScenarioStep;
      const toolName = typeof step.tool === 'string' && step.tool
        ? step.tool
        : (typeof step.action === 'string' && step.action ? 'reins_run_action' : '');
      if (!toolName) {
        ok = false;
        failureReason = `step ${i + 1}: missing action or tool`;
        stepResults.push({ step: i + 1, ok: false, error: failureReason });
        break;
      }
      const stepName = step.action ?? step.tool;
      try {
        const rawInput = step.tool ? (step.args ?? step.input) : step.input;
        if (rawInput !== undefined && !isPlainObj(rawInput)) {
          throw new Error('args/input must be an object');
        }
        const confirm = step.confirm ?? defaultConfirm;
        const toolArgs: Record<string, unknown> = step.tool
          ? { ...(rawInput ?? {}), ...(step.confirm !== undefined || defaultConfirm ? { confirm } : {}) }
          : {
              name: step.action,
              ...(rawInput !== undefined ? { input: rawInput } : {}),
              ...(step.confirm !== undefined || defaultConfirm ? { confirm } : {}),
              ...(step.target ? { target: step.target } : {}),
            };

        const result = await client.call(toolName, toolArgs);
        const safeResult = redactResult(result, toolName);
        if (isActionFailure(result)) {
          ok = false;
          failureReason = `step ${i + 1} (${stepName}): returned ok: false`;
          stepResults.push({ step: i + 1, name: stepName, ok: false, result: safeResult, error: failureReason });
          break;
        }
        if (step.assertState !== undefined) {
          const snapshot = await client.call('reins_state', {});
          const mismatch = matchesSubset(snapshot, step.assertState);
          if (mismatch) {
            ok = false;
            failureReason = `step ${i + 1} assertState failed: ${mismatch}`;
            stepResults.push({ step: i + 1, name: stepName, ok: false, result: safeResult, error: failureReason });
            break;
          }
        }
        const currentErrors = await client.call('reins_errors', {});
        const newErrors = Array.isArray(currentErrors) ? diffNewErrors(seenErrors, currentErrors) : [];
        if (Array.isArray(currentErrors)) seenErrors = currentErrors;
        const checkErrors = step.assertNoErrors ?? (scenario.assertNoErrors !== false && step.allowErrors !== true);
        if (checkErrors && newErrors.length > 0) {
          ok = false;
          failureReason = `step ${i + 1} triggered ${newErrors.length} uncaught runtime error(s)`;
          stepResults.push({ step: i + 1, name: stepName, ok: false, result: safeResult, error: failureReason });
          break;
        }
        stepResults.push({ step: i + 1, name: stepName, ok: true, result: safeResult });
      } catch (stepErr: any) {
        ok = false;
        failureReason = `step ${i + 1} (${stepName}): ${stepErr?.message ? String(stepErr.message) : String(stepErr)}`;
        stepResults.push({ step: i + 1, name: stepName, ok: false, error: failureReason });
        break;
      }
    }

    const [state, network, errors, perf, dom] = await Promise.all([
      client.call('reins_state', {}).catch(() => null),
      client.call('reins_network', {}).catch(() => null),
      client.call('reins_errors', {}).catch(() => null),
      client.call('reins_perf', {}).catch(() => null),
      panel ? client.call('reins_dom', { panel }).catch(() => null) : Promise.resolve(undefined),
    ]);

    print(JSON.stringify({
      ok,
      ...(failureReason ? { error: failureReason } : {}),
      steps: stepResults,
      state: redactStateMap(state),
      network: redactDeep(network),
      errors: redactDeep(errors),
      perf: redactDeep(perf),
      ...(dom !== undefined ? { dom: redactDeep(dom) } : {}),
    }, null, 2));
    return ok ? 0 : 2;
  } catch (e: any) {
    err(`reins scenario: ${e?.message ? String(e.message) : String(e)}`);
    return 2;
  } finally {
    if (client) await client.close();
  }
}

/** Collects one compact redacted evidence packet from the live bridge. */
export async function packetMain(
  argv: string[],
  cwd = process.cwd(),
  print: Printer = (s) => process.stdout.write(s + '\n'),
  err: Printer = (s) => process.stderr.write(s + '\n'),
): Promise<number> {
  let client: BridgeClient | null = null;
  try {
    const { common, values, bools } = parseFlags(argv, cwd, new Set(['--panel']), new Set(['--snap']));
    if (common.help) {
      print(ONESHOT_USAGE);
      return 0;
    }
    if (common.positional.length) {
      err(`reins packet: unexpected argument ${common.positional[0]}\n\n${ONESHOT_USAGE}`);
      return 2;
    }
    client = await openBridgeClient({ port: common.port, dir: common.dir, timeoutMs: common.timeoutMs });
    const actions = (await client.call('reins_list_actions', {})) as Record<string, any>;
    const panel = values['--panel'] ?? (bools.has('--snap') ? actions?.panels?.[0] : undefined);
    const [state, network, errors, perf] = await Promise.all([
      client.call('reins_state', {}),
      client.call('reins_network', {}),
      client.call('reins_errors', {}),
      client.call('reins_perf', {}),
    ]);
    const dom = panel ? await client.call('reins_dom', { panel }) : undefined;
    const snap = bools.has('--snap') && panel ? await client.call('reins_snap', { id: panel }) : undefined;
    print(JSON.stringify({
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      actions,
      state: redactStateMap(state),
      network: redactDeep(network),
      errors: redactDeep(errors),
      perf: redactDeep(perf),
      ...(dom !== undefined ? { dom: redactDeep(dom) } : {}),
      ...(snap !== undefined ? { snap: redactDeep(snap) } : {}),
    }, null, 2));
    return 0;
  } catch (e: any) {
    err(`reins packet: ${e?.message ? String(e.message) : String(e)}`);
    return 2;
  } finally {
    if (client) await client.close();
  }
}
