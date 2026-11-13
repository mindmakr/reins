// Design B2, B3, B4: the memory and file stores meet one contract; the Postgres store's statements carry every
// value as a parameter (its run against a real Postgres is flight-pg.test.ts).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BROKEN_LOCK_MS, fileStore, safe } from '../src/flight/file-store.js';
import { PG_TABLES, pgStore } from '../src/flight/pg-store.js';
import { isStore, memoryStore } from '../src/flight/store.js';
import { DAY, real, step, storeContract } from './flight-store-contract.js';

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
    expect(real(await store.runSteps('payout', 0)).map((s) => s.key)).toEqual(['k3', 'k4', 'k5']);
  });

  it('removes whole runs only, and counts the open ones it removes, also when the cap on add removes them', async () => {
    // Round 2 (F3): this test used to lock in pruning single steps, which left the run `part` without its first
    // step. Retention now keeps a run whole while its newest step is inside the bounds.
    const store = memoryStore({ maxSteps: 4 });
    const t = Date.now();
    await store.addSteps([step('part', 'requested', t - 3 * DAY), step('part', 'bank.sent', t), step('gone', 'requested', t - 3 * DAY)]);
    await store.prune({ maxAgeMs: DAY }, t, { payout: ['ledger.debited'] });
    expect(real(await store.openRuns('payout', ['ledger.debited'])).map((s) => `${s.key}:${s.step}`)).toEqual(['part:requested', 'part:bank.sent']);
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

  // Round 3 (G6, G7): this test used to lock in pruning the oldest segments whole (which took a long, still
  // active run before older finished ones) and sparing only the pruning object's own open segment. The count
  // cap now removes the runs whose newest step is oldest, as the other stores do, and no segment written in the
  // last hour is rewritten or deleted, by any process.
  it('prunes by count the runs whose newest step is oldest, whatever segments they span, and leaves segments written in the last hour', async () => {
    const dir = join(tmp(), 'flight');
    const t = Date.now();
    const segs = () => readdirSync(join(dir, 'steps')).filter((f) => f.endsWith('.jsonl'));
    const age = () => {
      const old = (Date.now() - 2 * 3_600_000) / 1000;
      for (const f of segs()) utimesSync(join(dir, 'steps', f), old, old);
    };
    // A long run starts in the oldest segment and goes on in the newest; two short runs finish in between.
    await fileStore({ dir }).addSteps([step('long', 'requested', t + 1)]);
    await new Promise((r) => setTimeout(r, 5));
    await fileStore({ dir }).addSteps([step('f1', 'requested', t + 2), step('f2', 'requested', t + 3)]);
    await new Promise((r) => setTimeout(r, 5));
    await fileStore({ dir }).addSteps([step('long', 'bank.sent', t + 10)]);
    age();
    await fileStore({ dir }).prune({ maxSteps: 2 });
    expect(real(await fileStore({ dir }).runSteps('payout', 0)).map((s) => s.key)).toEqual(['long', 'long']);
    // A segment written in the last hour is left as it is, even over the cap; the old ones are pruned.
    age();
    const w = fileStore({ dir });
    await w.addSteps([step('y1', 'requested', t + 20)]);
    const fresh = segs().filter((f) => statSync(join(dir, 'steps', f)).mtimeMs > Date.now() - 3_600_000);
    expect(fresh).toHaveLength(1);
    const before = readFileSync(join(dir, 'steps', fresh[0]), 'utf8');
    await fileStore({ dir }).prune({ maxSteps: 1 });
    expect(readFileSync(join(dir, 'steps', fresh[0]), 'utf8')).toBe(before);
    expect(real(await w.runSteps('payout', 0)).map((s) => s.key)).toEqual(['y1']);
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
      const holder = topLock(dir).owner;
      for (const h of handles) if (h.owner !== holder) await h.store.unlock(h.owner);
      expect(topLock(dir).owner).toBe(holder);
      // The holder removes the generations below its own: the folder never piles up.
      expect(readdirSync(join(dir, 'lock')).length).toBeLessThanOrEqual(3);
    };
    await Promise.all(Array.from({ length: 8 }, lane));
    expect(multi).toBe(0);
    expect(won).toBeGreaterThan(900);
  }, 60_000);

  it('gives instances a.b and a_b their own files', async () => {
    const dir = join(tmp(), 'flight');
    const store = fileStore({ dir });
    const t = Date.now();
    await store.putMinute({ instance: 'a.b', minute: t - (t % 60_000), basics: null, stepsDropped: { payout: 1 }, stepsInvalid: 0, storeErrors: 0, probes: [] });
    await store.putMinute({ instance: 'a_b', minute: t - (t % 60_000), basics: null, stepsDropped: { payout: 2 }, stepsInvalid: 0, storeErrors: 0, probes: [] });
    expect((await store.minutes(0)).map((m) => m.instance).sort()).toEqual(['a.b', 'a_b']);
    expect(new Set(readdirSync(join(dir, 'minutes'))).size).toBe(2);
    expect(safe('a.b')).not.toBe(safe('a_b'));
    expect(safe('x'.repeat(500))).not.toBe(safe('x'.repeat(499)));
  });

  it('keeps a finding keyed __proto__, and skips records of the wrong shape', async () => {
    const dir = join(tmp(), 'flight');
    const store = fileStore({ dir });
    await store.putFindings([{ key: '__proto__', state: 'open', updatedAt: 1, data: { n: 1 } }, { key: 'ok', state: 'open', updatedAt: 1, data: {} }]);
    expect((await store.findings()).map((f) => f.key).sort()).toEqual(['__proto__', 'ok']);
    const file = join(dir, 'findings.json');
    const all = JSON.parse(readFileSync(file, 'utf8'));
    all.bad = { key: 'bad', state: 'maybe', updatedAt: 1, data: {} };
    all.other = { key: 'not-other', state: 'open', updatedAt: 1, data: {} };
    all.nodata = 'text';
    writeFileSync(file, JSON.stringify(all));
    expect((await store.findings()).map((f) => f.key).sort()).toEqual(['__proto__', 'ok']);
  });

  it('skips a folder named like a segment', async () => {
    const dir = join(tmp(), 'flight');
    const store = fileStore({ dir });
    await store.addSteps([step('p1', 'requested', Date.now())]);
    mkdirSync(join(dir, 'steps', '1-x-y.jsonl'));
    mkdirSync(join(dir, 'minutes', 'x-1.json'));
    expect((await store.runSteps('payout', 0)).map((s) => s.key)).toEqual(['p1']);
    expect(await store.minutes(0)).toEqual([]);
    await store.prune({ maxSteps: 1 }, Date.now());
  });

  it.skipIf(process.platform === 'win32')('writes its files 0o600 and its folders 0o700', async () => {
    const dir = join(tmp(), '.reins', 'flight');
    const store = fileStore({ dir });
    await store.addSteps([step('p1', 'requested', Date.now())]);
    await store.putProbe({ id: 'pool', instance: 'i', at: 1, ok: true, ms: 1 });
    await store.lock('a', 1000);
    const steps = join(dir, 'steps');
    expect(statSync(steps).mode & 0o777).toBe(0o700);
    expect(statSync(join(steps, readdirSync(steps)[0])).mode & 0o777).toBe(0o600);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
  });

  // Round 3 (G1): the lock is numbered generation files made by exclusive create; the claim-file tests went with
  // the claim files. Each case below is a crash at one step, or a planted file, and none blocks for good.
  describe('file lock: crashes and planted files', () => {
    const lockDir = (dir: string) => join(dir, 'lock');
    const gen = (dir: string, n: number | string, text: string, ageMs = 0) => {
      const f = join(lockDir(dir), `${n}.json`);
      writeFileSync(f, text);
      if (ageMs) utimesSync(f, (Date.now() - ageMs) / 1000, (Date.now() - ageMs) / 1000);
    };
    const fresh = async () => {
      const dir = join(tmp(), 'flight');
      await fileStore({ dir }).lock('first', 1000, Date.now());
      return dir;
    };

    it('a generation its maker left empty (died between create and write) holds for BROKEN_LOCK_MS, then is taken over', async () => {
      const dir = await fresh();
      const t = Date.now();
      gen(dir, 2, ''); // created, never written
      expect(await fileStore({ dir }).lock('b', 1000, t + 5000)).toBe(false);
      gen(dir, 2, '', BROKEN_LOCK_MS + 1000);
      expect(await fileStore({ dir }).lock('b', 1000, t + 5000)).toBe(true);
      expect(topLock(dir)).toMatchObject({ owner: 'b' });
    });

    it('a generation cut short, unreadable, planted with a future time, or a folder named like one never blocks past the bound', async () => {
      for (const plant of [
        (dir: string) => gen(dir, 2, '{"owner":"a","unt', BROKEN_LOCK_MS + 1000),
        (dir: string) => gen(dir, 2, 'null', BROKEN_LOCK_MS + 1000),
        (dir: string) => {
          gen(dir, 2, '');
          const f = join(lockDir(dir), '2.json');
          const ahead = (Date.now() + 365 * DAY) / 1000;
          utimesSync(f, ahead, ahead); // a modification time far ahead does not make it held for longer
        },
        (dir: string) => {
          mkdirSync(join(lockDir(dir), '2.json'));
          const old = (Date.now() - BROKEN_LOCK_MS - 1000) / 1000;
          utimesSync(join(lockDir(dir), '2.json'), old, old);
        },
      ]) {
        const dir = await fresh();
        plant(dir);
        expect(await fileStore({ dir }).lock('b', 1000, Date.now() + 5000)).toBe(true);
      }
    });

    it('a valid lock left by a checker that died after writing it is taken over at its time, at most MAX_LOCK_MS ahead', async () => {
      const dir = await fresh();
      const t = Date.now();
      gen(dir, 5, JSON.stringify({ owner: 'dead', until: t + 60_000 }));
      expect(await fileStore({ dir }).lock('b', 1000, t + 59_000)).toBe(false);
      expect(await fileStore({ dir }).lock('b', 1000, t + 60_000)).toBe(true);
      gen(dir, 9, JSON.stringify({ owner: 'planted', until: t + 10 * 365 * DAY }));
      expect(await fileStore({ dir }).lock('c', 1000, t + 61_000)).toBe(true);
    });

    it('lower generations left behind (the holder died before removing them) and other names do not count', async () => {
      const dir = await fresh();
      const t = Date.now();
      gen(dir, 0, JSON.stringify({ owner: 'x', until: t + 60_000 }));
      gen(dir, '01', JSON.stringify({ owner: 'x', until: t + 60_000 }));
      gen(dir, 'lock', JSON.stringify({ owner: 'x', until: t + 60_000 }));
      expect(await fileStore({ dir }).lock('b', 1000, t + 5000)).toBe(true);
    });

    it('a planted generation at the end of the number range is removed once free, then the lock works again', async () => {
      const dir = await fresh();
      const t = Date.now();
      gen(dir, 999_999_999_999_998, JSON.stringify({ owner: 'planted', until: 1 }));
      const s = fileStore({ dir });
      expect(await s.lock('b', 1000, t + 5000)).toBe(false);
      expect(await s.lock('b', 1000, t + 5000)).toBe(true);
    });

    it('200 renewals leave one generation file, and unlock makes the lock free for the next checker', async () => {
      const dir = await fresh();
      const s = fileStore({ dir });
      const t = Date.now() + 2000; // past the first checker's lock
      for (let i = 0; i < 200; i++) expect(await s.lock('a', 60_000, t + i)).toBe(true);
      expect(readdirSync(lockDir(dir))).toHaveLength(1);
      expect(await fileStore({ dir }).lock('b', 60_000, t + 300)).toBe(false);
      await s.unlock('a');
      expect(readdirSync(lockDir(dir))).toHaveLength(1);
      expect(await fileStore({ dir }).lock('b', 60_000, t + 301)).toBe(true);
    }, 30_000);
  });
});

/** The lock as the file store holds it: the generation with the highest number. */
function topLock(dir: string): { owner: string; until: number } {
  const ns = readdirSync(join(dir, 'lock')).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5)));
  return JSON.parse(readFileSync(join(dir, 'lock', `${Math.max(...ns)}.json`), 'utf8'));
}

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
