import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { redactDeep } from '@mindmakr/reins';
import { outside } from './flight.js';
import { writeJsonAtomic } from './map-cli.js';
import { type BridgeClient, diffNewErrors, openBridgeClient, parseFlags, type Printer } from './oneshot-cli.js';
import { reinsDir } from './token.js';

export const FUZZ_USAGE = `usage:
  reins fuzz [--steps <n>] [--seed <seed>] [--panel <id>] [--allow-consequential --confirm] [--port <n>] [--dir <path>] [--timeout <ms>]

Generates schema-valid inputs from reins_list_actions against the running local bridge,
excludes consequential: true actions by default, and checks errors, 5xx network calls,
and DOM layout invariants after every step. Writes a minimal reproducible trace under
.reins/sessions/ and exits with code 2 when an invariant fails.`;

const LAYOUT_ISSUE_TYPES = new Set(['horizontal-clip', 'vertical-clip', 'zero-size']);

const DEFAULT_STRING_POOL = [
  'en',
  'ar',
  'default',
  'sample',
  'long-rtl-تفاصيل الفاتورة الطويلة جدا للتحقق من القص',
  'filter-all',
  '0',
  'test-item',
];

export interface FuzzActionTarget {
  name: string;
  target: 'app' | 'server';
  server?: string;
  consequential: boolean;
  readOnly?: boolean;
  input?: Record<string, unknown>;
}

export interface FuzzFailure {
  type: 'uncaught-error' | 'unhandled-rejection' | 'http-5xx' | 'dom-layout';
  panel?: string;
  issue?: string;
  detail: unknown;
}

export interface FuzzStepRecord {
  step: number;
  target: 'app' | 'server';
  action: string;
  input: Record<string, unknown>;
  ok: boolean;
  rpcError?: string;
  failures: FuzzFailure[];
}

/** Creates a deterministic Mulberry32 PRNG seeded from an unsigned integer or arbitrary string. */
export function createRng(seedInput: string | number): () => number {
  const s = String(seedInput);
  let state: number;
  if (/^\d+$/.test(s)) {
    state = Number(s) >>> 0;
  } else {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    state = h >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickIndex(rng: () => number, len: number): number {
  return Math.min(len - 1, Math.floor(rng() * len));
}

function randomAlphaNum(rng: () => number, length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[pickIndex(rng, chars.length)];
  return out;
}

function clampStringLength(raw: string, minLen: number, maxLen: number, rng: () => number): string {
  let out = raw;
  while (out.length < minLen) out += randomAlphaNum(rng, Math.max(1, minLen - out.length));
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

function generateStringValue(schema: Record<string, unknown>, rng: () => number): string {
  const hasMax = typeof schema.maxLength === 'number' && Number.isFinite(schema.maxLength) && schema.maxLength >= 0;
  const rawMax = hasMax ? Math.trunc(schema.maxLength as number) : undefined;
  const hasMin = typeof schema.minLength === 'number' && Number.isFinite(schema.minLength) && schema.minLength >= 0;
  const minLen = hasMin ? Math.min(Math.trunc(schema.minLength as number), 4096) : rawMax === 0 ? 0 : 1;
  const maxLen = rawMax !== undefined ? Math.max(minLen, Math.min(rawMax, 4096)) : Math.max(minLen, 48);
  if (maxLen === 0) return '';
  const fmt = typeof schema.format === 'string' ? schema.format : '';
  if (fmt === 'email') return clampStringLength(`user${pickIndex(rng, 100)}@example.com`, minLen, maxLen, rng);
  if (fmt === 'uri' || fmt === 'url') return clampStringLength(`https://example.com/${randomAlphaNum(rng, 6)}`, minLen, maxLen, rng);
  if (fmt === 'date') return clampStringLength('2026-01-15', minLen, maxLen, rng);
  if (fmt === 'date-time') return clampStringLength('2026-01-15T12:00:00Z', minLen, maxLen, rng);
  if (fmt === 'uuid') {
    const hex = () => Math.floor(rng() * 0x10000).toString(16).padStart(4, '0');
    return clampStringLength(`${hex()}${hex()}-${hex()}-4${hex().slice(1)}-8${hex().slice(1)}-${hex()}${hex()}${hex()}`, minLen, maxLen, rng);
  }
  if (rng() < 0.5) {
    const picked = DEFAULT_STRING_POOL[pickIndex(rng, DEFAULT_STRING_POOL.length)];
    return clampStringLength(picked, minLen, maxLen, rng);
  }
  const len = minLen + Math.floor(rng() * Math.max(1, Math.min(maxLen, 16) - minLen + 1));
  return clampStringLength(randomAlphaNum(rng, len), minLen, maxLen, rng);
}

function decimalPlaces(step: number): number {
  const m = String(step).match(/(?:\.(\d+))?(?:[eE]-(\d+))?$/);
  return Math.min(12, (m?.[1]?.length ?? 0) + Number(m?.[2] ?? 0));
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function integerStride(step: number): number {
  if (Number.isInteger(step)) return step;
  const places = Math.min(6, decimalPlaces(step));
  const scale = 10 ** places;
  const scaled = Math.round(step * scale);
  if (!scaled) return 1;
  return Math.max(1, Math.round(scaled / gcd(scaled, scale)));
}

function generateNumberValue(schema: Record<string, unknown>, rng: () => number, isInt: boolean): number {
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const hasMin = finite(schema.minimum) || finite(schema.exclusiveMinimum);
  const hasMax = finite(schema.maximum) || finite(schema.exclusiveMaximum);
  const minStrict = !finite(schema.minimum) && finite(schema.exclusiveMinimum) ? schema.exclusiveMinimum : undefined;
  const maxStrict = !finite(schema.maximum) && finite(schema.exclusiveMaximum) ? schema.exclusiveMaximum : undefined;

  let lo: number;
  let hi: number;
  if (isInt) {
    const intLo = finite(schema.minimum)
      ? Math.ceil(schema.minimum)
      : minStrict !== undefined
        ? Math.floor(minStrict) + 1
        : undefined;
    const intHi = finite(schema.maximum)
      ? Math.floor(schema.maximum)
      : maxStrict !== undefined
        ? Math.ceil(maxStrict) - 1
        : undefined;
    if (intLo !== undefined && intHi !== undefined) {
      lo = Math.min(intLo, intHi);
      hi = Math.max(intLo, intHi);
    } else if (intLo !== undefined) {
      lo = intLo;
      hi = Math.max(lo + 100, 100);
    } else if (intHi !== undefined) {
      hi = intHi;
      lo = hi < 0 ? hi - 100 : 0;
    } else {
      lo = 0;
      hi = 100;
    }
  } else {
    const rawMinBase = finite(schema.minimum) ? schema.minimum : minStrict ?? 0;
    const rawMaxBase = finite(schema.maximum)
      ? schema.maximum
      : maxStrict !== undefined
        ? maxStrict
        : hasMin
          ? Math.max(rawMinBase + 100, 100)
          : 100;
    const negMax = rawMaxBase < 0 || (rawMaxBase === 0 && maxStrict !== undefined);
    const baseLo = hasMin ? rawMinBase : negMax ? rawMaxBase - 100 : 0;
    const baseHi = hasMax ? rawMaxBase : Math.max(baseLo + 100, 100);
    const rawSpan = Math.max(0, baseHi - baseLo);
    const eps = rawSpan > 0 ? Math.min(0.01, rawSpan * 0.1) : 1e-6;
    const adjLo = minStrict !== undefined ? baseLo + eps : baseLo;
    const adjHi = maxStrict !== undefined ? baseHi - eps : baseHi;
    lo = Math.min(adjLo, adjHi);
    hi = Math.max(adjLo, adjHi);
  }

  const span = hi - lo;
  let value = span > 0 ? lo + rng() * span : lo;
  if (finite(schema.multipleOf) && schema.multipleOf > 0) {
    const rawStep = schema.multipleOf;
    const step = isInt ? integerStride(rawStep) : rawStep;
    let kMin = Math.ceil(lo / step - 1e-12);
    let kMax = Math.floor(hi / step + 1e-12);
    if (minStrict !== undefined && kMin * step <= minStrict + 1e-12) kMin++;
    if (maxStrict !== undefined && kMax * step >= maxStrict - 1e-12) kMax--;
    if (kMin <= kMax) {
      const k = kMin + Math.floor(rng() * (kMax - kMin + 1));
      value = k * step;
    } else {
      value = lo;
    }
    const decimals = decimalPlaces(step);
    return isInt ? Math.round(value) : decimals > 0 ? Number(value.toFixed(decimals)) : Math.round(value);
  }
  if (isInt) {
    const rounded = Math.round(value);
    return Math.min(hi, Math.max(lo, rounded));
  }
  const rounded3 = Math.round(value * 1000) / 1000;
  const okMin = minStrict !== undefined ? rounded3 > minStrict : rounded3 >= lo;
  const okMax = maxStrict !== undefined ? rounded3 < maxStrict : rounded3 <= hi;
  if (okMin && okMax) return rounded3;
  return Number(value.toPrecision(12));
}

/** Generates a deterministic schema-valid JSON value from a JSON Schema fragment. */
export function generateValueForSchema(
  schema: Record<string, unknown> | undefined,
  rng: () => number,
  depth = 0,
): unknown {
  if (!schema || typeof schema !== 'object') return {};
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[pickIndex(rng, schema.enum.length)];
  }
  const unions = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (unions && unions.length > 0 && depth < 5) {
    const nonNull = unions.filter((b: any) => b && typeof b === 'object' && b.type !== 'null');
    const pool = nonNull.length ? nonNull : unions;
    const chosen = pool[pickIndex(rng, pool.length)];
    return generateValueForSchema(chosen as Record<string, unknown>, rng, depth + 1);
  }
  const typeVal = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== 'null') ?? schema.type[0]
    : schema.type ?? (schema.properties ? 'object' : 'object');

  if (typeVal === 'object') {
    if (depth >= 5) return {};
    const props = schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const keys = Object.keys(props).sort();
    const obj: Record<string, unknown> = {};
    for (const k of keys) {
      const include = required.has(k) || rng() >= 0.3;
      if (include) obj[k] = generateValueForSchema(props[k], rng, depth + 1);
    }
    for (const reqKey of required) {
      if (!Object.hasOwn(obj, reqKey)) obj[reqKey] = generateValueForSchema({ type: 'string' }, rng, depth + 1);
    }
    return obj;
  }
  if (typeVal === 'array') {
    if (depth >= 5) return [];
    const rawMin = typeof schema.minItems === 'number' && Number.isFinite(schema.minItems) && schema.minItems >= 0
      ? Math.trunc(schema.minItems)
      : 0;
    const minItems = Math.min(rawMin, 64);
    const rawMax = typeof schema.maxItems === 'number' && Number.isFinite(schema.maxItems) && schema.maxItems >= minItems
      ? Math.trunc(schema.maxItems)
      : minItems + 3;
    const maxItems = Math.max(minItems, Math.min(minItems + 8, rawMax));
    const count = minItems + Math.floor(rng() * (maxItems - minItems + 1));
    const itemSchema = schema.items && typeof schema.items === 'object' ? (schema.items as Record<string, unknown>) : {};
    return Array.from({ length: count }, () => generateValueForSchema(itemSchema, rng, depth + 1));
  }
  if (typeVal === 'string') return generateStringValue(schema, rng);
  if (typeVal === 'integer') return generateNumberValue(schema, rng, true);
  if (typeVal === 'number') return generateNumberValue(schema, rng, false);
  if (typeVal === 'boolean') return rng() >= 0.5;
  if (typeVal === 'null') return null;
  return {};
}

/** Collects universal DOM layout invariant violations from a DomNode subtree. */
export function collectDomIssues(node: unknown, panel?: string): FuzzFailure[] {
  const out: FuzzFailure[] = [];
  const walk = (cur: any) => {
    if (!cur || typeof cur !== 'object') return;
    if (Array.isArray(cur.issues)) {
      for (const issue of cur.issues) {
        if (LAYOUT_ISSUE_TYPES.has(issue)) {
          out.push({
            type: 'dom-layout',
            ...(panel ? { panel } : cur.panel ? { panel: String(cur.panel) } : {}),
            issue: String(issue),
            detail: redactDeep({
              tag: cur.tag,
              id: cur.id,
              classes: cur.classes,
              direction: cur.styles?.direction,
              box: cur.box,
            }),
          });
        }
      }
    }
    if (Array.isArray(cur.children)) {
      for (const child of cur.children) walk(child);
    }
  };
  walk(node);
  return out;
}

/** Extracts candidate actions from `reins_list_actions` and filters out consequential ones by default. */
export function collectFuzzTargets(listed: Record<string, any>, allowConsequential: boolean): {
  eligible: FuzzActionTarget[];
  skippedConsequential: string[];
  panels: string[];
} {
  const all: FuzzActionTarget[] = [];
  if (Array.isArray(listed?.actions)) {
    for (const a of listed.actions) {
      if (!a || typeof a.name !== 'string') continue;
      all.push({
        name: a.name,
        target: 'app',
        consequential: Boolean(a.consequential),
        readOnly: Boolean(a.readOnly),
        input: a.input && typeof a.input === 'object' ? a.input : { type: 'object', properties: {} },
      });
    }
  }
  if (Array.isArray(listed?.servers)) {
    for (const srv of listed.servers) {
      const serverName = String(srv?.meta?.name || srv?.title || '');
      if (!Array.isArray(srv?.actions)) continue;
      for (const a of srv.actions) {
        if (!a || typeof a.name !== 'string') continue;
        all.push({
          name: a.name,
          target: 'server',
          ...(serverName ? { server: serverName } : {}),
          consequential: Boolean(a.consequential),
          readOnly: Boolean(a.readOnly),
          input: a.input && typeof a.input === 'object' ? a.input : { type: 'object', properties: {} },
        });
      }
    }
  }

  all.sort((a, b) => {
    const ak = `${a.target}:${a.server ?? ''}:${a.name}`;
    const bk = `${b.target}:${b.server ?? ''}:${b.name}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  const skippedConsequential = allowConsequential ? [] : all.filter((a) => a.consequential).map((a) => a.name);
  const eligible = allowConsequential ? all : all.filter((a) => !a.consequential);
  const panels = Array.isArray(listed?.panels)
    ? [...new Set(listed.panels.filter((p: unknown): p is string => typeof p === 'string'))].sort()
    : [];
  return { eligible, skippedConsequential, panels };
}

function classifyErrorFailures(newErrors: unknown[]): FuzzFailure[] {
  const failures: FuzzFailure[] = [];
  for (const e of newErrors as any[]) {
    const kind = e && typeof e === 'object' ? String(e.kind ?? '') : '';
    if (kind === 'console') continue;
    failures.push({
      type: kind === 'rejection' || kind === 'unhandledrejection' ? 'unhandled-rejection' : 'uncaught-error',
      detail: redactDeep(e),
    });
  }
  return failures;
}

function classifyNetworkFailures(newNetwork: unknown[]): FuzzFailure[] {
  const failures: FuzzFailure[] = [];
  for (const entry of newNetwork as any[]) {
    if (entry && typeof entry.status === 'number' && entry.status >= 500 && entry.status < 600) {
      failures.push({
        type: 'http-5xx',
        detail: redactDeep(entry),
      });
    }
  }
  return failures;
}

function safeSeedSlug(seed: string): string {
  return seed.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'seed';
}

function assertExistingPathInsideRoot(rootReal: string, candidate: string): string {
  if (!existsSync(candidate)) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new Error('refusing to write fuzz trace outside project root');
      }
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    return candidate;
  }
  const real = realpathSync.native(candidate);
  if (outside(rootReal, real)) {
    throw new Error('refusing to write fuzz trace outside project root');
  }
  return real;
}

function writeFuzzTraceArtifact(projectDir: string, seed: string, report: Record<string, unknown>): string {
  const rootReal = realpathSync.native(resolve(projectDir));
  const dotReinsReal = assertExistingPathInsideRoot(rootReal, join(rootReal, '.reins'));
  assertExistingPathInsideRoot(rootReal, join(dotReinsReal, 'sessions'));
  const gitignorePath = join(dotReinsReal, '.gitignore');
  assertExistingPathInsideRoot(rootReal, gitignorePath);
  try {
    if (lstatSync(gitignorePath).isSymbolicLink()) {
      throw new Error('refusing to write through symlinked .reins/.gitignore');
    }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }

  const sessionsCandidate = join(reinsDir(rootReal), 'sessions');
  mkdirSync(sessionsCandidate, { recursive: true });
  const sessionsReal = realpathSync.native(sessionsCandidate);
  if (outside(rootReal, sessionsReal)) {
    throw new Error('refusing to write fuzz trace outside project root');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(3).toString('hex');
  const filePath = join(sessionsReal, `fuzz-${safeSeedSlug(seed)}-${stamp}-${suffix}.json`);
  writeJsonAtomic(filePath, JSON.stringify(redactDeep(structuredClone(report)), null, 2) + '\n');
  return filePath;
}

function quoteCliArg(v: string): string {
  return /^[A-Za-z0-9_.:-]+$/.test(v) ? v : JSON.stringify(v);
}

function parseStepsCount(raw: string | undefined): number {
  if (raw === undefined) return 40;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 10000) {
    throw new Error('--steps must be a positive integer between 1 and 10000');
  }
  return n;
}

/** Runs `reins fuzz` against the local bridge, exiting 0 on clean pass or 2 on invariant failure/error. */
export async function fuzzMain(
  argv: string[],
  cwd = process.cwd(),
  print: Printer = (s) => process.stdout.write(s + '\n'),
  err: Printer = (s) => process.stderr.write(s + '\n'),
): Promise<number> {
  let client: BridgeClient | null = null;
  try {
    const { common, values, bools } = parseFlags(
      argv,
      cwd,
      new Set(['--steps', '--seed', '--panel']),
      new Set(['--allow-consequential', '--confirm']),
    );
    if (common.help) {
      print(FUZZ_USAGE);
      return 0;
    }
    if (common.positional.length) {
      err(`reins fuzz: unexpected argument ${common.positional[0]}\n\n${FUZZ_USAGE}`);
      return 2;
    }
    const allowConsequential = bools.has('--allow-consequential');
    if (allowConsequential && !bools.has('--confirm')) {
      err('reins fuzz: --allow-consequential requires --confirm in an isolated test harness');
      return 2;
    }
    const stepsRequested = parseStepsCount(values['--steps']);
    const seed = values['--seed'] !== undefined
      ? values['--seed']
      : String(randomBytes(4).readUInt32BE(0));
    if (!seed) throw new Error('--seed must not be empty');
    const panelFilter = values['--panel'];
    const rng = createRng(seed);

    client = await openBridgeClient({ port: common.port, dir: common.dir, timeoutMs: common.timeoutMs });
    const listed = (await client.call('reins_list_actions', {})) as Record<string, any>;
    const { eligible, skippedConsequential, panels } = collectFuzzTargets(listed, allowConsequential);

    if (!eligible.length) {
      print(JSON.stringify(redactDeep({
        schemaVersion: '1.0.0',
        ok: true,
        seed,
        stepsRequested,
        stepsRun: 0,
        skippedConsequential,
        panelsChecked: panelFilter ? [panelFilter] : panels,
        note: 'no eligible non-consequential actions registered',
        trace: [],
        failures: [],
      }), null, 2));
      return 0;
    }

    const panelsToCheck = panelFilter ? [panelFilter] : panels;
    let seenErrors = (await client.call('reins_errors', {})) as unknown[];
    let seenNetwork = (await client.call('reins_network', {})) as unknown[];
    if (!Array.isArray(seenErrors)) seenErrors = [];
    if (!Array.isArray(seenNetwork)) seenNetwork = [];

    const trace: FuzzStepRecord[] = [];
    let failedStep: number | null = null;
    let failingReasons: FuzzFailure[] = [];

    for (let step = 1; step <= stepsRequested; step++) {
      const action = eligible[pickIndex(rng, eligible.length)];
      const rawInput = generateValueForSchema(action.input, rng);
      const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : {};

      let rpcError: string | undefined;
      try {
        await client.call('reins_run_action', {
          name: action.name,
          input,
          target: action.target,
          ...(allowConsequential ? { confirm: true } : {}),
        });
      } catch (e: any) {
        rpcError = e?.message ? String(e.message) : String(e);
      }

      const [currErrorsRaw, currNetworkRaw] = await Promise.all([
        client.call('reins_errors', {}),
        client.call('reins_network', {}),
      ]);
      const currErrors = Array.isArray(currErrorsRaw) ? currErrorsRaw : [];
      const currNetwork = Array.isArray(currNetworkRaw) ? currNetworkRaw : [];
      const newErrors = diffNewErrors(seenErrors, currErrors);
      const newNetwork = diffNewErrors(seenNetwork, currNetwork);
      seenErrors = currErrors;
      seenNetwork = currNetwork;

      const domFailures: FuzzFailure[] = [];
      if (panelsToCheck.length) {
        for (const p of panelsToCheck) {
          const domRoot = await client.call('reins_dom', { panel: p, depth: 8, maxNodes: 400 });
          domFailures.push(...collectDomIssues(domRoot, p));
        }
      } else {
        const domRoot = await client.call('reins_dom', { depth: 8, maxNodes: 400 });
        domFailures.push(...collectDomIssues(domRoot));
      }

      const stepFailures = [
        ...classifyErrorFailures(newErrors),
        ...classifyNetworkFailures(newNetwork),
        ...domFailures,
      ];

      trace.push({
        step,
        target: action.target,
        action: action.name,
        input: redactDeep(input) as Record<string, unknown>,
        ok: stepFailures.length === 0 && !rpcError,
        ...(rpcError ? { rpcError } : {}),
        failures: stepFailures,
      });

      if (stepFailures.length > 0) {
        failedStep = step;
        failingReasons = stepFailures;
        break;
      }
    }

    const baseReport = {
      schemaVersion: '1.0.0',
      ok: failedStep === null,
      seed,
      command: `npx reins fuzz --steps ${trace.length || stepsRequested} --seed ${quoteCliArg(seed)}${panelFilter ? ` --panel ${quoteCliArg(panelFilter)}` : ''}${allowConsequential ? ' --allow-consequential --confirm' : ''}`,
      stepsRequested,
      stepsRun: trace.length,
      failedStep,
      skippedConsequential,
      panelsChecked: panelsToCheck,
      failures: structuredClone(failingReasons),
      trace,
      scenario: {
        ...(panelFilter ? { panel: panelFilter } : {}),
        steps: trace.map((t) => ({
          target: t.target,
          action: t.action,
          input: structuredClone(t.input),
          ...(allowConsequential ? { confirm: true } : {}),
        })),
      },
    };

    if (failedStep !== null) {
      const artifactPath = writeFuzzTraceArtifact(common.dir, seed, baseReport);
      const out = { ...baseReport, artifact: artifactPath };
      print(JSON.stringify(redactDeep(structuredClone(out)), null, 2));
      err(`reins fuzz: invariant failed at step ${failedStep} (${failingReasons.map((f) => f.type).join(', ')}); trace saved to ${artifactPath}`);
      return 2;
    }

    print(JSON.stringify(redactDeep(structuredClone(baseReport)), null, 2));
    return 0;
  } catch (e: any) {
    err(`reins fuzz: ${e?.message ? String(e.message) : String(e)}`);
    return 2;
  } finally {
    if (client) await client.close();
  }
}
