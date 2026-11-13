// The flight manifest, reins.flight.json (docs/design/flight.md section 4): its types, the
// duration parser and the validator. The validator never throws: every problem comes back as
// data, with its path in the document, so an invalid manifest can never crash a server (C8).
// This module imports only Node built-ins.
import { readFileSync } from 'node:fs';

/** The manifest schema this release understands. A higher number is refused with "update reins". */
export const MANIFEST_SCHEMA = 1;
/** The manifest's file name, read from the project root unless another path is given. */
export const MANIFEST_FILE = 'reins.flight.json';
/** The look-back window of a promise that does not set `window` (C15): 24 hours. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The limits `basics` may override, each with its allowed range. This is the one list of allowed
 * names: add a basic check's limit here and the validator accepts it.
 */
export const BASIC_LIMITS = {
  errorShare: { min: 0, max: 1 },
} as const satisfies Record<string, { min: number; max: number }>;
export type BasicName = keyof typeof BASIC_LIMITS;
export const BASIC_NAMES = Object.keys(BASIC_LIMITS) as BasicName[];

/** Durations are written 30s, 15m, 4h or 7d. */
export type Duration = string;

interface PromiseBase {
  id: string;
  why?: string;
  /** The look-back window as written, when the promise sets one. */
  window?: Duration;
  /** The look-back window in milliseconds: `window`, or DEFAULT_WINDOW_MS. */
  windowMs: number;
}
export interface WithinPromise extends PromiseBase {
  kind: 'within';
  after: string;
  expect: string[];
  within: Duration;
  withinMs: number;
}
export interface OncePromise extends PromiseBase {
  kind: 'once';
  step: string;
}
export interface OrderPromise extends PromiseBase {
  kind: 'order';
  first: string;
  then: string;
}
export interface EndsPromise extends PromiseBase {
  kind: 'ends';
  within: Duration;
  withinMs: number;
}
export type FlightPromise = WithinPromise | OncePromise | OrderPromise | EndsPromise;
export type PromiseKind = FlightPromise['kind'];
export const PROMISE_KINDS: readonly PromiseKind[] = ['within', 'once', 'order', 'ends'];

export interface FlightProcess {
  name: string;
  /** For people: what identifies one run of the process. */
  key: string;
  steps: string[];
  ends: string[];
  /** Built-in retries per step: the step may be recorded 1 + n times for one key. */
  retries: Record<string, number>;
  promises: FlightPromise[];
}

export interface FlightProbe {
  id: string;
  every: Duration;
  everyMs: number;
  why?: string;
}

export interface FlightManifest {
  schema: typeof MANIFEST_SCHEMA;
  service: string;
  upstreams: string[];
  processes: FlightProcess[];
  probes: FlightProbe[];
  basics: Partial<Record<BasicName, number>>;
}

/** One problem in a manifest. `path` is where in the document, such as `processes[0].promises[1].within`. */
export interface ManifestProblem {
  path: string;
  message: string;
}

export type ManifestResult =
  | { ok: true; manifest: FlightManifest; problems: [] }
  | { ok: false; manifest?: undefined; problems: ManifestProblem[] };

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION = /^([1-9][0-9]{0,8})([smhd])$/;
/** The longest duration: 365 days, well inside safe integers and timer limits. */
const MAX_DURATION_MS = 365 * 86_400_000;
/** Names of processes and steps, and ids of promises and probes. */
const NAME = /^[a-z0-9.-]+$/;
const MAX_NAME = 100;
/** Whether `s` is a valid process or step name: lowercase letters, digits, dots and hyphens, at most 100. */
export const isName = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= MAX_NAME && NAME.test(s);
const MAX_TEXT = 1000;
const MAX_RETRIES = 1000;

/** Parses a duration such as `30s`, `15m`, `4h` or `7d` to milliseconds, up to 365 days. Anything else gives undefined. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = DURATION.exec(value);
  const ms = m ? Number(m[1]) * UNITS[m[2]] : undefined;
  return ms !== undefined && ms <= MAX_DURATION_MS ? ms : undefined;
}

const ROOT = '(root)';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : v === undefined ? 'undefined' : `a ${typeof v}`);
/** Builds a problem path: `processes[0].retries["bank.sent"]`. Keys that are not plain identifiers are quoted. */
const join = (path: string, key: string | number) => {
  const base = path === ROOT ? '' : path;
  if (typeof key === 'number') return `${base}[${key}]`;
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) return `${base}[${JSON.stringify(key)}]`;
  return base ? `${base}.${key}` : key;
};

class Checker {
  problems: ManifestProblem[] = [];

  add(path: string, message: string) {
    this.problems.push({ path, message });
  }

  /** Refuses every key of `obj` not in `allowed`. */
  known(obj: Record<string, unknown>, path: string, allowed: readonly string[], what: string) {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) this.add(join(path, k), `unknown field "${k}" in ${what}`);
  }

  text(v: unknown, path: string, { required = true, max = MAX_TEXT } = {}): string | undefined {
    if (v === undefined) {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    if (typeof v !== 'string') return void this.add(path, `must be a string, not ${typeName(v)}`);
    if (!v.trim()) return void this.add(path, 'must not be empty');
    if (v.length > max) return void this.add(path, `must be at most ${max} characters`);
    return v;
  }

  name(v: unknown, path: string, what = 'name'): string | undefined {
    if (v === undefined) return void this.add(path, 'is required');
    if (typeof v !== 'string') return void this.add(path, `must be a string, not ${typeName(v)}`);
    if (!NAME.test(v) || v.length > MAX_NAME)
      return void this.add(path, `${what} "${v.slice(0, MAX_NAME)}" must use only lowercase letters, digits, dots and hyphens (at most ${MAX_NAME})`);
    return v;
  }

  duration(v: unknown, path: string, required = true): { text: Duration; ms: number } | undefined {
    if (v === undefined) {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    const ms = parseDuration(v);
    if (ms === undefined) {
      if (typeof v === 'string' && DURATION.test(v)) return void this.add(path, `"${v}" is too long: a duration may be at most 365 days`);
      const shown = typeof v === 'string' ? `"${v.slice(0, 40)}"` : typeName(v);
      return void this.add(path, `${shown} is not a duration: write a whole number and s, m, h or d, such as 30s, 15m, 4h or 7d`);
    }
    return { text: v as string, ms };
  }

  array(v: unknown, path: string, required: boolean): unknown[] | undefined {
    if (v === undefined) {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    if (!Array.isArray(v)) return void this.add(path, `must be an array, not ${typeName(v)}`);
    return v;
  }

  /** An optional or required object. */
  object(v: unknown, path: string, required: boolean): Record<string, unknown> | undefined {
    if (v === undefined) {
      if (required) this.add(path, 'is required');
      return undefined;
    }
    if (!isObject(v)) return void this.add(path, `must be an object, not ${typeName(v)}`);
    return v;
  }

  /** A step reference: a valid name that the process declares. With `declared` null (the steps list itself failed), only the name is checked. */
  step(v: unknown, path: string, declared: Set<string> | null, processName: string): string | undefined {
    const s = this.name(v, path, 'step');
    if (s === undefined) return undefined;
    if (declared && !declared.has(s)) return void this.add(path, `step "${s}" is not declared in the steps of process "${processName}"`);
    return s;
  }
}

const ROOT_FIELDS = ['schema', 'service', 'upstreams', 'processes', 'probes', 'basics'] as const;
const PROCESS_FIELDS = ['name', 'key', 'steps', 'ends', 'retries', 'promises'] as const;
const PROBE_FIELDS = ['id', 'every', 'why'] as const;
const PROMISE_COMMON = ['id', 'kind', 'why', 'window'] as const;
const KIND_FIELDS: Record<PromiseKind, readonly string[]> = {
  within: ['after', 'expect', 'within'],
  once: ['step'],
  order: ['first', 'then'],
  ends: ['within'],
};
const ANY_PROMISE_FIELDS = [...PROMISE_COMMON, ...new Set(Object.values(KIND_FIELDS).flat())];

/**
 * Validates a parsed manifest. Lists every problem it finds, not only the first, each with its
 * path. Never throws. On success, returns a typed manifest with defaults filled in.
 */
export function validateManifest(input: unknown): ManifestResult {
  const c = new Checker();
  let manifest: FlightManifest | undefined;
  try {
    manifest = check(input, c);
  } catch (e) {
    // Not reachable from JSON input; kept so that no input can make the validator throw.
    c.add(ROOT, `could not be checked${e instanceof Error && typeof e.message === 'string' ? `: ${e.message.slice(0, 200)}` : ''}`);
  }
  if (c.problems.length || !manifest) return { ok: false, problems: c.problems.length ? c.problems : [{ path: ROOT, message: 'is not valid' }] };
  return { ok: true, manifest, problems: [] };
}

function check(input: unknown, c: Checker): FlightManifest | undefined {
  if (!isObject(input)) return void c.add(ROOT, `the manifest must be a JSON object, not ${typeName(input)}`);

  // The schema comes first: a newer file may use fields this release does not know, so it is
  // refused as a whole rather than reported field by field.
  const schema = input.schema;
  if (schema === undefined) c.add('schema', `is required: set it to ${MANIFEST_SCHEMA}`);
  else if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) c.add('schema', `must be ${MANIFEST_SCHEMA}, not ${typeof schema === 'number' ? schema : typeName(schema)}`);
  else if (schema > MANIFEST_SCHEMA) {
    c.add('schema', `schema ${schema} is newer than this reins understands (${MANIFEST_SCHEMA}): update reins`);
    return undefined;
  }

  c.known(input, ROOT, ROOT_FIELDS, 'the manifest');
  const service = c.text(input.service, 'service', { max: MAX_NAME });

  const upstreams: string[] = [];
  const ups = c.array(input.upstreams, 'upstreams', false) ?? [];
  ups.forEach((u, i) => {
    const path = join('upstreams', i);
    const host = c.text(u, path, { max: 253 });
    if (host === undefined) return;
    if (/[\s/]/.test(host)) c.add(path, `"${host}" must be a host name, without a scheme, path or spaces`);
    else upstreams.push(host);
  });

  const processes: FlightProcess[] = [];
  const processNames = new Set<string>();
  const promiseIds = new Set<string>();
  const procs = c.array(input.processes, 'processes', false) ?? [];
  procs.forEach((p, i) => {
    const path = join('processes', i);
    const proc = checkProcess(p, path, c, promiseIds);
    if (!proc) return;
    if (processNames.has(proc.name)) c.add(join(path, 'name'), `duplicate process name "${proc.name}"`);
    processNames.add(proc.name);
    processes.push(proc);
  });

  const probes: FlightProbe[] = [];
  const probeIds = new Set<string>();
  const prbs = c.array(input.probes, 'probes', false) ?? [];
  prbs.forEach((p, i) => {
    const path = join('probes', i);
    const obj = c.object(p, path, true);
    if (!obj) return;
    c.known(obj, path, PROBE_FIELDS, 'a probe');
    const id = c.name(obj.id, join(path, 'id'), 'id');
    const every = c.duration(obj.every, join(path, 'every'));
    const why = c.text(obj.why, join(path, 'why'), { required: false });
    if (id !== undefined) {
      if (probeIds.has(id)) c.add(join(path, 'id'), `duplicate probe id "${id}"`);
      probeIds.add(id);
    }
    if (id !== undefined && every) probes.push({ id, every: every.text, everyMs: every.ms, ...(why !== undefined && { why }) });
  });

  const basics: Partial<Record<BasicName, number>> = {};
  const b = c.object(input.basics, 'basics', false);
  if (b) {
    for (const k of Object.keys(b)) {
      const path = join('basics', k);
      if (!Object.prototype.hasOwnProperty.call(BASIC_LIMITS, k)) {
        c.add(path, `unknown field "${k}" in basics: the known limits are ${BASIC_NAMES.join(', ')}`);
        continue;
      }
      const { min, max } = BASIC_LIMITS[k as BasicName];
      const v = b[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) c.add(path, `must be a number, not ${typeName(v)}`);
      else if (v < min || v > max) c.add(path, `must be between ${min} and ${max}, not ${v}`);
      else basics[k as BasicName] = v;
    }
  }

  if (c.problems.length || service === undefined) return undefined;
  return { schema: MANIFEST_SCHEMA, service, upstreams, processes, probes, basics };
}

function checkProcess(p: unknown, path: string, c: Checker, promiseIds: Set<string>): FlightProcess | undefined {
  const obj = c.object(p, path, true);
  if (!obj) return undefined;
  c.known(obj, path, PROCESS_FIELDS, 'a process');
  const name = c.name(obj.name, join(path, 'name'));
  const label = name ?? (typeof obj.name === 'string' ? obj.name.slice(0, MAX_NAME) : path);
  const key = c.text(obj.key, join(path, 'key'));

  const steps: string[] = [];
  const declared = new Set<string>();
  const rawSteps = c.array(obj.steps, join(path, 'steps'), true);
  if (rawSteps && rawSteps.length === 0) c.add(join(path, 'steps'), 'must list at least one step');
  rawSteps?.forEach((s, i) => {
    const step = c.name(s, join(join(path, 'steps'), i), 'step');
    if (step === undefined) return;
    if (declared.has(step)) c.add(join(join(path, 'steps'), i), `duplicate step "${step}"`);
    declared.add(step);
    steps.push(step);
  });
  // When the steps list itself is missing or empty, do not also report every reference to a step.
  const known = rawSteps && rawSteps.length > 0 ? declared : null;

  const ends: string[] = [];
  (c.array(obj.ends, join(path, 'ends'), false) ?? []).forEach((s, i) => {
    const step = c.step(s, join(join(path, 'ends'), i), known, label);
    if (step !== undefined && !ends.includes(step)) ends.push(step);
  });

  const retries: Record<string, number> = {};
  const r = c.object(obj.retries, join(path, 'retries'), false);
  if (r) {
    for (const k of Object.keys(r)) {
      const kp = join(join(path, 'retries'), k);
      const step = c.step(k, kp, known, label);
      const n = r[k];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_RETRIES) c.add(kp, `must be a whole number from 0 to ${MAX_RETRIES}, not ${typeof n === 'number' ? n : typeName(n)}`);
      else if (step !== undefined) retries[step] = n;
    }
  }

  const promises: FlightPromise[] = [];
  (c.array(obj.promises, join(path, 'promises'), false) ?? []).forEach((q, i) => {
    const promise = checkPromise(q, join(join(path, 'promises'), i), c, known, label, ends.length > 0, promiseIds);
    if (promise) promises.push(promise);
  });

  if (name === undefined || key === undefined) return undefined;
  return { name, key, steps, ends, retries, promises };
}

function checkPromise(q: unknown, path: string, c: Checker, declared: Set<string> | null,proc: string, hasEnds: boolean, ids: Set<string>): FlightPromise | undefined {
  const obj = c.object(q, path, true);
  if (!obj) return undefined;
  const id = c.name(obj.id, join(path, 'id'), 'id');
  if (id !== undefined) {
    if (ids.has(id)) c.add(join(path, 'id'), `duplicate promise id "${id}"`);
    ids.add(id);
  }
  const why = c.text(obj.why, join(path, 'why'), { required: false });
  const window = c.duration(obj.window, join(path, 'window'), false);

  const kind = obj.kind;
  if (kind === undefined) {
    c.add(join(path, 'kind'), `is required: one of ${PROMISE_KINDS.join(', ')}`);
    c.known(obj, path, ANY_PROMISE_FIELDS, 'a promise');
    return undefined;
  }
  if (typeof kind !== 'string' || !(PROMISE_KINDS as readonly string[]).includes(kind)) {
    c.add(join(path, 'kind'), `${typeof kind === 'string' ? `"${kind.slice(0, 40)}"` : typeName(kind)} is not a promise kind: use one of ${PROMISE_KINDS.join(', ')}`);
    // Still name fields that belong to no kind of promise at all.
    c.known(obj, path, ANY_PROMISE_FIELDS, 'a promise');
    return undefined;
  }
  const k = kind as PromiseKind;
  c.known(obj, path, [...PROMISE_COMMON, ...KIND_FIELDS[k]], `${/^[aeiou]/.test(k) ? 'an' : 'a'} "${k}" promise`);
  const step = (field: string) => c.step(obj[field], join(path, field), declared, proc);

  let fields: Record<string, unknown> | undefined;
  if (k === 'within') {
    const after = step('after');
    const expect: string[] = [];
    let expectOk = true;
    const raw = c.array(obj.expect, join(path, 'expect'), true);
    if (!raw) expectOk = false;
    else if (raw.length === 0) {
      c.add(join(path, 'expect'), 'must list at least one step');
      expectOk = false;
    } else
      raw.forEach((s, i) => {
        const e = c.step(s, join(join(path, 'expect'), i), declared, proc);
        if (e === undefined) expectOk = false;
        else if (!expect.includes(e)) expect.push(e);
      });
    const within = c.duration(obj.within, join(path, 'within'));
    if (after !== undefined && expectOk && within) fields = { after, expect, within: within.text, withinMs: within.ms };
  } else if (k === 'once') {
    const s = step('step');
    if (s !== undefined) fields = { step: s };
  } else if (k === 'order') {
    const first = step('first');
    const then = step('then');
    if (first !== undefined && then !== undefined && first === then) c.add(join(path, 'then'), `must differ from first ("${first}")`);
    else if (first !== undefined && then !== undefined) fields = { first, then };
  } else {
    const within = c.duration(obj.within, join(path, 'within'));
    if (!hasEnds) c.add(path, `an "ends" promise needs the process "${proc}" to list its ends`);
    else if (within) fields = { within: within.text, withinMs: within.ms };
  }

  if (id === undefined || !fields) return undefined;
  return {
    id,
    kind: k,
    ...fields,
    ...(why !== undefined && { why }),
    ...(window && { window: window.text }),
    windowMs: window ? window.ms : DEFAULT_WINDOW_MS,
  } as FlightPromise;
}

/** Parses manifest text and validates it. Malformed JSON is a problem, not an exception. */
export function parseManifest(text: string): ManifestResult {
  let data: unknown;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, problems: [{ path: ROOT, message: `is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  return validateManifest(data);
}

/** Reads and validates a manifest file. A missing or unreadable file is a problem, not an exception. */
export function readManifest(file: string): ManifestResult {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e: any) {
    const why = e && e.code === 'ENOENT' ? 'no such file' : e && e.code ? e.code : 'could not be read';
    return { ok: false, problems: [{ path: ROOT, message: `${file}: ${why}` }] };
  }
  return parseManifest(text);
}
