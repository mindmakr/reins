import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { flightCheckMain, flightMain } from '../src/flight/check-cli.js';
import { BASIC_NAMES, DEFAULT_WINDOW_MS, parseDuration, parseManifest, readManifest, validateManifest, type ManifestProblem } from '../src/flight/manifest.js';

/** The example manifest from docs/design/flight.md section 4. */
const example = () => ({
  schema: 1,
  service: 'invoice-api',
  upstreams: ['bank.example.com'],
  processes: [
    {
      name: 'payout',
      key: 'the payout id',
      steps: ['requested', 'bank.sent', 'bank.pending', 'bank.settled', 'bank.failed', 'ledger.debited'],
      ends: ['ledger.debited', 'bank.failed'],
      retries: { 'bank.sent': 3 },
      promises: [
        { id: 'pending-settles', kind: 'within', after: 'bank.pending', expect: ['bank.settled', 'bank.failed'], within: '4h', why: 'Nothing else resolves a pending transfer; a stuck one is money owed to an employee.' },
        { id: 'one-debit', kind: 'once', step: 'ledger.debited', why: 'A second debit makes the pool say we have less money than we do.' },
        { id: 'debit-after-settle', kind: 'order', first: 'bank.settled', then: 'ledger.debited' },
        { id: 'payout-ends', kind: 'ends', within: '24h' },
      ],
    },
  ],
  probes: [{ id: 'pool-matches-ledger', every: '15m', why: 'The pool balance must equal the sum of ledger entries.' }],
  basics: { errorShare: 0.02 },
});
type Doc = ReturnType<typeof example> & Record<string, any>;

/** Validates a changed copy of the example and returns its problems. */
const problems = (change: (m: Doc) => void): ManifestProblem[] => {
  const m = example() as Doc;
  change(m);
  return validateManifest(m).problems;
};
const paths = (ps: ManifestProblem[]) => ps.map((p) => p.path);
const promise = (m: Doc, i: number) => m.processes[0].promises[i] as Record<string, any>;

describe('parseDuration', () => {
  it('accepts 30s, 15m, 4h and 7d', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('4h')).toBe(4 * 3_600_000);
    expect(parseDuration('7d')).toBe(7 * 86_400_000);
  });
  it('refuses other forms', () => {
    for (const v of ['', '0s', '4', 'h', '4 h', ' 4h', '4h ', '4H', '1.5h', '-1h', '04h', '4hr', '4w', '1h30m', '1e3s', '9999999999s', 4, null, undefined, {}, ['4h']])
      expect(parseDuration(v), String(v)).toBeUndefined();
  });
  it('caps a duration at 365 days in total', () => {
    expect(parseDuration('365d')).toBe(365 * 86_400_000);
    expect(parseDuration('8760h')).toBe(365 * 86_400_000);
    for (const v of ['366d', '9000h', '999999999d', '525601m', '31536001s']) expect(parseDuration(v), v).toBeUndefined();
  });
});

describe('validateManifest', () => {
  it('B1: accepts the design example and returns a typed manifest', () => {
    const r = validateManifest(example());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.manifest;
    expect(m.service).toBe('invoice-api');
    expect(m.upstreams).toEqual(['bank.example.com']);
    expect(m.processes[0].retries).toEqual({ 'bank.sent': 3 });
    expect(m.processes[0].ends).toEqual(['ledger.debited', 'bank.failed']);
    const [within, once, order, ends] = m.processes[0].promises;
    expect(within).toMatchObject({ id: 'pending-settles', kind: 'within', after: 'bank.pending', expect: ['bank.settled', 'bank.failed'], within: '4h', withinMs: 4 * 3_600_000, windowMs: DEFAULT_WINDOW_MS });
    expect(once).toMatchObject({ kind: 'once', step: 'ledger.debited' });
    expect(order).toMatchObject({ kind: 'order', first: 'bank.settled', then: 'ledger.debited' });
    expect(ends).toMatchObject({ kind: 'ends', withinMs: 86_400_000 });
    expect(order.why).toBeUndefined();
    expect(m.probes).toEqual([{ id: 'pool-matches-ledger', every: '15m', everyMs: 900_000, why: 'The pool balance must equal the sum of ledger entries.' }]);
    expect(m.basics).toEqual({ errorShare: 0.02 });
  });

  it('reads the look-back window from a promise', () => {
    const r = validateManifest((() => {
      const m = example() as Doc;
      promise(m, 1).window = '7d';
      return m;
    })());
    expect(r.ok && r.manifest.processes[0].promises[1]).toMatchObject({ window: '7d', windowMs: 7 * 86_400_000 });
    expect(problems((m) => (promise(m, 1).window = '7 days'))).toEqual([{ path: 'processes[0].promises[1].window', message: expect.stringMatching(/not a duration/) }]);
  });

  it('accepts a minimal manifest, filling in defaults', () => {
    const r = validateManifest({ schema: 1, service: 'api' });
    expect(r).toEqual({ ok: true, problems: [], manifest: { schema: 1, service: 'api', upstreams: [], processes: [], probes: [], basics: {} } });
  });

  it('B2: refuses a newer schema with "update reins", and a missing or wrong one', () => {
    const newer = problems((m) => (m.schema = 2));
    expect(newer).toHaveLength(1);
    expect(newer[0].path).toBe('schema');
    expect(newer[0].message).toMatch(/update reins/);
    // A newer file is refused whole, not field by field.
    expect(problems((m) => Object.assign(m, { schema: 3, alerts: [] }))).toHaveLength(1);
    expect(paths(problems((m) => delete (m as any).schema))).toEqual(['schema']);
    expect(paths(problems((m) => ((m as any).schema = '1')))).toEqual(['schema']);
    expect(paths(problems((m) => (m.schema = 0)))).toEqual(['schema']);
    expect(paths(problems((m) => (m.schema = 1.5)))).toEqual(['schema']);
  });

  it('B2: refuses and names an unknown field at the root, in a process, a promise, a probe and basics', () => {
    const ps = problems((m) => {
      m.alerts = true;
      (m.processes[0] as any).owner = 'team';
      promise(m, 0).level = 'error';
      promise(m, 1).within = '4h'; // a field of another kind
      (m.probes[0] as any).timeout = '5s';
      (m.basics as any).p95Ms = 300;
    });
    expect(paths(ps)).toEqual(['alerts', 'processes[0].owner', 'processes[0].promises[0].level', 'processes[0].promises[1].within', 'probes[0].timeout', 'basics.p95Ms']);
    for (const p of ps) expect(p.message).toMatch(/unknown field "(alerts|owner|level|within|timeout|p95Ms)"/);
  });

  it('accepts only the basics named in BASIC_NAMES, as numbers in range', () => {
    expect(BASIC_NAMES).toContain('errorShare');
    expect(paths(problems((m) => ((m.basics as any).errorShare = '2%')))).toEqual(['basics.errorShare']);
    expect(paths(problems((m) => (m.basics.errorShare = 2)))).toEqual(['basics.errorShare']);
    expect(paths(problems((m) => ((m as any).basics = [0.02])))).toEqual(['basics']);
  });

  it('B3: refuses process and step names outside lowercase letters, digits, dots and hyphens', () => {
    for (const bad of ['Payout', 'pay out', 'pay_out', 'payé', '', 'a/b', 'x'.repeat(101)]) {
      expect(paths(problems((m) => (m.processes[0].name = bad))), bad).toEqual(['processes[0].name']);
    }
    const ps = problems((m) => (m.processes[0].steps = [...m.processes[0].steps, 'Bank.Retry', 'bank_retry']));
    expect(paths(ps)).toEqual(['processes[0].steps[6]', 'processes[0].steps[7]']);
    expect(ps[0].message).toMatch(/lowercase letters, digits, dots and hyphens/);
  });

  it('B3: refuses ends, retries keys and promise fields that name an undeclared step', () => {
    const ps = problems((m) => {
      m.processes[0].ends = ['ledger.debited', 'done'];
      m.processes[0].retries = { 'bank.sent': 3, 'bank.resent': 1 } as any;
      Object.assign(promise(m, 0), { after: 'bank.waiting', expect: ['bank.settled', 'bank.ok'] });
      promise(m, 1).step = 'ledger.credited';
      Object.assign(promise(m, 2), { first: 'bank.cleared', then: 'ledger.posted' });
    });
    expect(paths(ps)).toEqual([
      'processes[0].ends[1]',
      'processes[0].retries["bank.resent"]',
      'processes[0].promises[0].after',
      'processes[0].promises[0].expect[1]',
      'processes[0].promises[1].step',
      'processes[0].promises[2].first',
      'processes[0].promises[2].then',
    ]);
    for (const p of ps) expect(p.message).toMatch(/is not declared in the steps of process "payout"/);
  });

  it('B4: refuses each promise kind with a missing or wrong-typed field', () => {
    const cases: [number, string, unknown][] = [
      [0, 'after', undefined],
      [0, 'after', 5],
      [0, 'expect', undefined],
      [0, 'expect', 'bank.settled'],
      [0, 'expect', []],
      [0, 'within', undefined],
      [0, 'within', 4],
      [1, 'step', undefined],
      [1, 'step', ['ledger.debited']],
      [2, 'first', undefined],
      [2, 'then', null],
      [3, 'within', undefined],
      [3, 'within', '1 day'],
    ];
    for (const [i, field, value] of cases) {
      const ps = problems((m) => {
        if (value === undefined) delete promise(m, i)[field];
        else promise(m, i)[field] = value;
      });
      expect(paths(ps), `${i}.${field}=${JSON.stringify(value)}`).toEqual([`processes[0].promises[${i}].${field}`]);
    }
    expect(paths(problems((m) => delete promise(m, 0).kind))).toEqual(['processes[0].promises[0].kind']);
    expect(paths(problems((m) => (promise(m, 0).kind = 'eventually')))).toEqual(['processes[0].promises[0].kind']);
    expect(paths(problems((m) => (promise(m, 0).id = 7)))).toEqual(['processes[0].promises[0].id']);
    expect(paths(problems((m) => (promise(m, 0).why = 42)))).toEqual(['processes[0].promises[0].why']);
    expect(paths(problems((m) => Object.assign(promise(m, 2), { first: 'bank.settled', then: 'bank.settled' })))).toEqual(['processes[0].promises[2].then']);
    expect(paths(problems((m) => delete (m.processes[0] as any).ends))).toEqual(['processes[0].promises[3]']);
  });

  it('refuses a duration longer than 365 days with a plain message', () => {
    expect(problems((m) => (promise(m, 3).within = '365d'))).toEqual([]);
    for (const d of ['366d', '9000h']) {
      expect(problems((m) => (promise(m, 3).within = d))).toEqual([{ path: 'processes[0].promises[3].within', message: `"${d}" is too long: a duration may be at most 365 days` }]);
    }
    expect(paths(problems((m) => (m.probes[0].every = '999999999d')))).toEqual(['probes[0].every']);
  });

  it('reports only the steps list, not every step reference, when steps is missing or invalid', () => {
    for (const steps of [undefined, 'requested', []]) {
      const ps = problems((m) => {
        if (steps === undefined) delete (m.processes[0] as any).steps;
        else (m.processes[0] as any).steps = steps;
      });
      expect(paths(ps), JSON.stringify(steps)).toEqual(['processes[0].steps']);
    }
  });

  it('still names fields that belong to no promise kind when the kind is unknown', () => {
    const ps = problems((m) => Object.assign(promise(m, 0), { kind: 'eventually', level: 'error' }));
    expect(ps).toEqual([
      { path: 'processes[0].promises[0].kind', message: expect.stringMatching(/"eventually" is not a promise kind/) },
      { path: 'processes[0].promises[0].level', message: 'unknown field "level" in a promise' },
    ]);
  });

  it('words messages naturally: "an" before a vowel, and undefined without an article', () => {
    expect(problems((m) => (promise(m, 3).after = 'requested'))).toEqual([{ path: 'processes[0].promises[3].after', message: 'unknown field "after" in an "ends" promise' }]);
    expect(problems((m) => (promise(m, 0).step = 'requested'))[0].message).toBe('unknown field "step" in a "within" promise');
    expect(problems((m) => (promise(m, 1).within = '4h'))[0].message).toBe('unknown field "within" in a "once" promise');
    expect(validateManifest(undefined).problems[0].message).toBe('the manifest must be a JSON object, not undefined');
  });

  it('B4: accepts each duration form and refuses others in within, ends, window and every', () => {
    for (const d of ['30s', '15m', '4h', '7d']) expect(problems((m) => (promise(m, 3).within = d))).toEqual([]);
    expect(paths(problems((m) => (promise(m, 0).within = '4hours')))).toEqual(['processes[0].promises[0].within']);
    expect(paths(problems((m) => (m.probes[0].every = '15')))).toEqual(['probes[0].every']);
  });

  it('B4: refuses a duplicate promise id, probe id, process name or step', () => {
    expect(paths(problems((m) => (promise(m, 1).id = 'pending-settles')))).toEqual(['processes[0].promises[1].id']);
    expect(paths(problems((m) => m.probes.push({ ...m.probes[0] })))).toEqual(['probes[1].id']);
    const twice = problems((m) => {
      const copy = example().processes[0];
      copy.promises = [{ ...copy.promises[1], id: 'one-debit-again' }];
      m.processes.push(copy);
    });
    expect(twice).toEqual([{ path: 'processes[1].name', message: 'duplicate process name "payout"' }]);
    // Promise ids are unique across the whole file, not only within a process.
    const sameId = problems((m) => {
      const other = { ...example().processes[0], name: 'refund', promises: [{ id: 'one-debit', kind: 'once', step: 'requested' }] };
      m.processes.push(other as any);
    });
    expect(paths(sameId)).toEqual(['processes[1].promises[0].id']);
    expect(paths(problems((m) => m.processes[0].steps.push('requested')))).toEqual(['processes[0].steps[6]']);
  });

  it('refuses wrong-typed process, probe, retries and root fields', () => {
    expect(paths(problems((m) => ((m as any).service = 5)))).toEqual(['service']);
    expect(paths(problems((m) => ((m as any).upstreams = 'bank.example.com')))).toEqual(['upstreams']);
    expect(paths(problems((m) => (m.upstreams = ['https://bank.example.com/'])))).toEqual(['upstreams[0]']);
    expect(paths(problems((m) => ((m as any).processes = {})))).toEqual(['processes']);
    expect(paths(problems((m) => ((m as any).processes = ['payout'])))).toEqual(['processes[0]']);
    expect(paths(problems((m) => delete (m.processes[0] as any).key))).toEqual(['processes[0].key']);
    expect(paths(problems((m) => (m.processes[0].steps = []))).slice(0, 1)).toEqual(['processes[0].steps']);
    expect(paths(problems((m) => ((m.processes[0].retries as any)['bank.sent'] = -1)))).toEqual(['processes[0].retries["bank.sent"]']);
    expect(paths(problems((m) => ((m.processes[0].retries as any)['bank.sent'] = '3')))).toEqual(['processes[0].retries["bank.sent"]']);
    expect(paths(problems((m) => ((m as any).probes = [{ id: 'p' }])))).toEqual(['probes[0].every']);
  });

  it('B5: lists every problem of a file together, each with its path', () => {
    const ps = problems((m) => {
      m.service = '';
      m.processes[0].name = 'Payout';
      promise(m, 0).within = 'soon';
      promise(m, 1).step = 'ledger.credited';
      (m.probes[0] as any).every = 15;
      m.basics.errorShare = -1;
    });
    expect(paths(ps)).toEqual(['service', 'processes[0].name', 'processes[0].promises[0].within', 'processes[0].promises[1].step', 'probes[0].every', 'basics.errorShare']);
    for (const p of ps) expect(p.message.length).toBeGreaterThan(5);
  });

  it('B7: returns problems and never throws, whatever the input', () => {
    const inputs: unknown[] = [undefined, null, 0, 'x', [], [1], true, () => 1, Object.create(null), { schema: 1, service: 'a', processes: [null, 1, 'x', [], { name: 'p', key: 'k', steps: [{}], ends: {}, retries: [], promises: [null, { kind: {} }] }] }];
    for (const [i, input] of inputs.entries()) {
      const r = validateManifest(input);
      expect(r.ok, `input ${i}`).toBe(false);
      expect(r.problems.length).toBeGreaterThan(0);
    }
    expect(validateManifest([]).problems).toEqual([{ path: '(root)', message: 'the manifest must be a JSON object, not an array' }]);
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('boom'); }, get: () => { throw new Error('boom'); } });
    expect(() => validateManifest(hostile)).not.toThrow();
    expect(validateManifest(hostile).ok).toBe(false);
    const proto = parseManifest('{"schema":1,"service":"a","__proto__":{"x":1},"processes":[{"name":"p","key":"k","steps":["a"],"retries":{"__proto__":1}}]}');
    expect(paths(proto.problems)).toEqual(['__proto__', 'processes[0].retries.__proto__']);
  });

  it('B7: reports malformed JSON and a missing file as problems', () => {
    for (const text of ['', '{', '{"schema":1,}', 'null', '"x"']) {
      const r = parseManifest(text);
      expect(r.ok).toBe(false);
      expect(r.problems[0].path).toBe('(root)');
    }
    expect(parseManifest('﻿' + JSON.stringify(example())).ok).toBe(true);
    expect(readManifest(join(tmpdir(), 'reins-no-such-manifest.json')).problems[0].message).toMatch(/no such file/);
  });

  it('B7: the module imports only Node built-ins', () => {
    for (const f of ['manifest.ts', 'check-cli.ts']) {
      const src = readFileSync(fileURLToPath(new URL(`../src/flight/${f}`, import.meta.url)), 'utf8');
      const specs = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((x) => x[1]);
      for (const s of specs) expect(s, `${f} imports ${s}`).toMatch(/^(node:|\.\/)/);
    }
  });
});

const dirs: string[] = [];
const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'reins-flight-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('reins flight check', () => {
  const capture = () => {
    const out: string[] = [];
    return { out, print: (s: string) => out.push(s) };
  };

  it('B6: exits 0 on a valid manifest, defaulting to reins.flight.json in the folder', () => {
    const dir = project({ 'reins.flight.json': JSON.stringify(example()) });
    const o = capture();
    expect(flightCheckMain([], dir, o.print, o.print)).toBe(0);
    expect(o.out.join('\n')).toMatch(/is valid \(1 process, 4 promises, 1 probe\)/);
    expect(flightMain(['check'], dir, o.print, o.print)).toBe(0);
  });

  it('B6: prints every problem and exits 1 on an invalid manifest', () => {
    const bad = example() as Doc;
    bad.schema = 1;
    bad.extra = 1;
    promise(bad, 0).within = 'soon';
    const dir = project({ 'flight.json': JSON.stringify(bad) });
    const o = capture();
    expect(flightMain(['check', 'flight.json'], dir, o.print, o.print)).toBe(1);
    const text = o.out.join('\n');
    expect(text).toMatch(/2 problems/);
    expect(text).toMatch(/^ {2}extra: unknown field "extra"/m);
    expect(text).toMatch(/^ {2}processes\[0\]\.promises\[0\]\.within: "soon" is not a duration/m);
    expect(flightMain(['check', 'broken.json'], project({ 'broken.json': '{' }), o.print, o.print)).toBe(1);
  });

  it('exits 2 on a missing file, bad usage, or a command that is not there', async () => {
    const o = capture();
    const empty = project({});
    expect(flightCheckMain([], empty, o.print, o.print)).toBe(2);
    expect(o.out.join('\n')).toMatch(/reins\.flight\.json not found/);
    expect(flightCheckMain(['a.json', 'b.json'], empty, o.print, o.print)).toBe(2);
    expect(flightCheckMain(['--strict'], empty, o.print, o.print)).toBe(2);
    expect(flightMain([], empty, o.print, o.print)).toBe(2);
    expect(flightMain(['fly'], empty, o.print, o.print)).toBe(2);
    expect(await flightMain(['watch'], empty, o.print, o.print)).toBe(2);
    expect(await flightMain(['report'], empty, o.print, o.print)).toBe(2);
    expect(flightMain(['--help'], empty, o.print, o.print)).toBe(0);
  });

  const built = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  it.skipIf(!existsSync(built))('runs as `reins flight check` with no server (after npm run build)', () => {
    const run = (dir: string, args: string[] = []) => {
      try {
        execFileSync(process.execPath, [built, 'flight', 'check', ...args], { cwd: dir, stdio: 'pipe' });
        return 0;
      } catch (e: any) {
        return e.status as number;
      }
    };
    expect(run(project({ 'reins.flight.json': JSON.stringify(example()) }))).toBe(0);
    expect(run(project({ 'reins.flight.json': JSON.stringify({ ...example(), schema: 2 }) }))).toBe(1);
    expect(run(project({}))).toBe(2);
  });
});
