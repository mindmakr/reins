// Design B2, B3, B4: the memory and file stores meet one contract; the Postgres store's statements carry every
// value as a parameter (its run against a real Postgres is flight-pg.test.ts).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileStore } from '../src/flight/file-store.js';
import { PG_TABLES, pgStore } from '../src/flight/pg-store.js';
import { isStore, memoryStore } from '../src/flight/store.js';
import { DAY, step, storeContract } from './flight-store-contract.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'reins-flight-store-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('memory store', () => {
  storeContract(async () => {
    const store = memoryStore();
    return { store, second: () => store };
  });

  it('never holds more than maxSteps, even if nothing prunes it', async () => {
    const store = memoryStore({ maxSteps: 3 });
    await store.addSteps([1, 2, 3, 4, 5].map((i) => step(`k${i}`, 'requested', i)));
    expect((await store.runSteps('payout', 0)).map((s) => s.key)).toEqual(['k3', 'k4', 'k5']);
  });

  it('counts an open run only when retention removes it whole, also when the cap on add removes it', async () => {
    const store = memoryStore({ maxSteps: 4 });
    const t = Date.now();
    await store.addSteps([step('part', 'requested', t - 3 * DAY), step('part', 'bank.sent', t), step('gone', 'requested', t - 3 * DAY)]);
    await store.prune({ maxAgeMs: DAY }, t, { payout: ['ledger.debited'] });
    expect((await store.openRuns('payout', ['ledger.debited'])).map((s) => s.key)).toEqual(['part']);
    expect((await store.minutes(0)).find((m) => m.instance === '(prune)')!.runsPruned).toEqual({ payout: 1 });
    await store.addSteps([1, 2, 3, 4].map((i) => step(`n${i}`, 'requested', t + i)));
    const counts = (await store.minutes(0)).filter((m) => m.instance === '(prune)').reduce((n, m) => n + (m.runsPruned?.payout || 0), 0);
    expect(counts).toBe(2);
  });
});

describe('file store', () => {
  storeContract(async () => {
    const dir = join(tmp(), '.reins', 'flight');
    return { store: fileStore({ dir }), second: () => fileStore({ dir }) };
  });

  it('lives under .reins/flight by default and keeps .reins out of git', async () => {
    const root = tmp();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await fileStore().addSteps([step('p1', 'requested', 1)]);
    } finally {
      process.chdir(cwd);
    }
    expect(readdirSync(join(root, '.reins', 'flight', 'steps'))).toHaveLength(1);
    expect(readFileSync(join(root, '.reins', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('skips a step line cut short by a crash', async () => {
    const dir = join(tmp(), 'flight');
    const store = fileStore({ dir });
    await store.addSteps([step('p1', 'requested', 1)]);
    const seg = join(dir, 'steps', readdirSync(join(dir, 'steps'))[0]);
    writeFileSync(seg, readFileSync(seg, 'utf8') + '{"process":"payout","ke');
    expect(await store.runSteps('payout', 0)).toEqual([step('p1', 'requested', 1)]);
  });

  it('prunes by count a whole segment at a time, oldest first, never one still being written', async () => {
    const dir = join(tmp(), 'flight');
    const a = fileStore({ dir });
    await a.addSteps([step('a1', 'requested', 1), step('a2', 'requested', 2)]);
    await new Promise((r) => setTimeout(r, 5));
    const b = fileStore({ dir });
    await b.addSteps([step('b1', 'requested', 3, 'payout', 'i2')]);
    await b.prune({ maxSteps: 2 });
    expect((await b.runSteps('payout', 0)).map((s) => s.key)).toEqual(['b1']);
    // b's own open segment is never removed, even when it alone is over the bound.
    await b.prune({ maxSteps: 0.5 });
    expect((await b.runSteps('payout', 0)).map((s) => s.key)).toEqual(['b1']);
  });

  it('never has two holders: 1000 rounds of three checkers racing for an expired lock, its owner among them', async () => {
    let multi = 0;
    let won = 0;
    // Eight folders race side by side, 125 rounds each: 1000 rounds in all.
    const lane = async () => {
      const dir = join(tmp(), 'flight');
      const handles = ['A', 'B', 'C'].map((owner) => ({ owner, store: fileStore({ dir }) }));
      let t = 0;
      for (let i = 0; i < 125; i++) {
        // Each round starts after the last holder's lock (100 ms) has passed its time: the holder renews it
        // while the other two take it over, at the same moment.
        t += 1000;
        const got = await Promise.all(handles.map((h) => h.store.lock(h.owner, 100, t)));
        const n = got.filter(Boolean).length;
        if (n > 1) multi++;
        if (n === 1) won++;
      }
      // Unlock by a checker that no longer holds the lock leaves the holder's lock alone.
      const holder = JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8')).owner;
      for (const h of handles) if (h.owner !== holder) await h.store.unlock(h.owner);
      expect(JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8')).owner).toBe(holder);
    };
    await Promise.all(Array.from({ length: 8 }, lane));
    expect(multi).toBe(0);
    expect(won).toBeGreaterThan(900);
  }, 60_000);

  it('takes over a lock file cut short', async () => {
    const dir = join(tmp(), 'flight');
    const store = fileStore({ dir });
    await store.addSteps([]);
    await store.lock('a', 1000, 0);
    writeFileSync(join(dir, 'lock.json'), '{"owner":"a","unt');
    expect(await fileStore({ dir }).lock('b', 1000, 10)).toBe(true);
    expect(existsSync(join(dir, 'lock.json'))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith('.stale'))).toEqual([]);
  });
});

describe('postgres store statements', () => {
  /** A query function that records statements and answers like an empty database. */
  function recording() {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const store = pgStore({ query: async (text, params) => (calls.push({ text, params }), { rows: [{ owner: 'x' }] }) });
    return { calls, store };
  }

  it('never builds a name, key, instance or probe id into SQL text', async () => {
    const { calls, store } = recording();
    const odd = "k'1; drop table x; --";
    await store.addSteps([step(odd, 'bank.sent', 5, 'payout', 'inst-9')]);
    await store.runSteps('payout', 0);
    await store.putMinute({ instance: 'inst-9', minute: 0, basics: null, stepsDropped: { payout: 2 }, stepsInvalid: 0, storeErrors: 0, probes: ['pool-x'] });
    await store.minutes(0);
    await store.putProbe({ id: 'pool-x', instance: 'inst-9', at: 1, ok: false, reason: 'timeout', ms: 3 });
    await store.putFindings([{ key: 'promise:payout:one-debit', state: 'open', updatedAt: 1, data: { keys: [odd] } }]);
    await store.lock('owner-7', 1000, 0);
    await store.unlock('owner-7');
    await store.prune({}, 0);
    await store.openRuns('payout', ['bank.sent']);
    await store.prune({}, 0, { payout: ['bank.sent'] });
    expect(calls.length).toBeGreaterThan(8);
    for (const { text } of calls) {
      for (const v of [odd, 'payout', 'bank.sent', 'inst-9', 'pool-x', 'owner-7', 'one-debit']) expect(text).not.toContain(v);
    }
    expect(calls[0].params).toEqual([['payout'], [odd], ['bank.sent'], [5], ['inst-9']]);
  });

  it('accepts a query function that returns rows directly', async () => {
    const store = pgStore({ query: async () => [{ process: 'payout', key: 'k', step: 'requested', at: '12', instance: 'i' }] });
    expect(await store.runSteps('payout', 0)).toEqual([{ process: 'payout', key: 'k', step: 'requested', at: 12, instance: 'i' }]);
  });

  it('ships the table definition and creates nothing itself', async () => {
    const { calls, store } = recording();
    await store.addSteps([step('k', 'requested', 1)]);
    await store.prune();
    expect(calls.some((c) => /\bcreate\b/i.test(c.text))).toBe(false);
    for (const t of ['reins_flight_steps', 'reins_flight_minutes', 'reins_flight_probes', 'reins_flight_findings', 'reins_flight_lock']) expect(PG_TABLES).toContain(`create table ${t}`);
  });

  it('refuses to be made without a query function', () => {
    expect(() => pgStore({} as any)).toThrow(/query function/);
    expect(isStore(pgStore({ query: async () => [] }))).toBe(true);
    expect(isStore({ addSteps() {} })).toBe(false);
  });
});

export { DAY };
