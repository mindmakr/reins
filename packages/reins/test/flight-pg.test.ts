// Design B11: the Postgres store's statements against a real Postgres. Runs only when REINS_FLIGHT_PG_URL is
// set (a throwaway database: the test drops and recreates the flight tables). `pg` is a dev dependency of the
// repository only; the package itself gains no driver.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/flight/checker.js';
import { validateManifest } from '../src/flight/manifest.js';
import { PG_TABLES, pgStore, type QueryFn } from '../src/flight/pg-store.js';
import { createFlight } from '../src/flight.js';
import { fig, im } from './flight-fixtures.js';
import { step, storeContract } from './flight-store-contract.js';

const url = process.env.REINS_FLIGHT_PG_URL;
const TABLES = ['reins_flight_steps', 'reins_flight_minutes', 'reins_flight_probes', 'reins_flight_findings', 'reins_flight_lock'];

describe.skipIf(!url)('postgres store against a real Postgres (B11)', () => {
  let pool: pg.Pool;
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const query: QueryFn = (text, params) => {
    statements.push({ text, params });
    return pool.query(text, params as any[]);
  };
  const reset = async () => {
    await pool.query(`drop table if exists ${TABLES.join(', ')}`);
    // The app's own migration would run this; the test plays the app.
    await pool.query(PG_TABLES);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await reset();
  });
  afterAll(async () => {
    await pool?.query(`drop table if exists ${TABLES.join(', ')}`).catch(() => {});
    await pool?.end();
  });

  storeContract(async () => {
    await reset();
    return { store: pgStore({ query }), second: () => pgStore({ query }) };
  });

  it('a hostile key and step-like text are stored as data, and no value reaches SQL text', async () => {
    await reset();
    statements.length = 0;
    const store = pgStore({ query });
    const evil = `p1'); drop table reins_flight_lock; --`;
    await store.addSteps([step(evil, 'ledger.debited', Date.now() - 2000), step(evil, 'ledger.debited', Date.now() - 1000)]);
    const m = validateManifest({
      schema: 1,
      service: 'invoice-api',
      processes: [{ name: 'payout', key: 'id', steps: ['ledger.debited'], ends: ['ledger.debited'], promises: [{ id: 'one-debit', kind: 'once', step: 'ledger.debited' }] }],
    });
    const r = await check(store, m);
    expect(r.promises[0]).toMatchObject({ state: 'broken', count: 1, keys: [evil] });
    expect(await store.lock('a', 1000)).toBe(true); // the lock table is still there
    for (const { text } of statements) for (const v of [evil, 'payout', 'ledger.debited', 'one-debit']) expect(text).not.toContain(v);
  });

  it('a step inserted for a run while the prune removes it stays beside the marker: the run is known to be partial', async () => {
    await reset();
    const store = pgStore({ query });
    const t = Date.now();
    await store.addSteps([step('p1', 'ledger.debited', t)]);
    // A writer's transaction adds the second debit of p1 and commits only after the prune has run.
    const writer = await pool.connect();
    try {
      await writer.query('begin');
      await writer.query(`insert into reins_flight_steps (process, key, step, at, instance) values ('payout', 'p1', 'ledger.debited', $1, 'i2')`, [t + 9 * 86_400_000]);
      await store.prune({ maxAgeMs: 7 * 86_400_000 }, t + 8 * 86_400_000);
      await writer.query('commit');
    } finally {
      writer.release();
    }
    expect((await store.runSteps('payout', 0)).map((s) => s.step)).toEqual(['(pruned)', 'ledger.debited']);
  });

  it('a bad row passed straight to addSteps never reaches Postgres (a NUL key would fail the batch)', async () => {
    await reset();
    statements.length = 0;
    const store = pgStore({ query });
    await store.addSteps([step('a\u0000b', 'requested', 1)]);
    expect(statements).toEqual([]);
  });

  it('a flight with the Postgres store keeps its findings and their memory, and tells a sink once (u4)', async () => {
    await reset();
    const store = pgStore({ query });
    const got: string[] = [];
    const f = createFlight({});
    f.start({ store, sinks: [(n: { type: string; finding?: { key: string } }) => void got.push(`${n.type} ${n.finding?.key}`)], checkEveryMs: 0, flushMs: 10_000, instance: 'srv', notify: { daily: false } });
    try {
      await store.putMinute(im('a', Date.now(), { requests: [['GET', '/x', fig(40, 4)]], codes: { ECONNRESET: 2 } }));
      await f.checkNow();
      await f.checkNow();
      await f.sinksIdle();
      expect(got.sort()).toEqual(['opened basic:error-share', 'opened unusual:code:ECONNRESET']);
      const rows = await store.findings();
      expect(rows.map((r) => r.key).sort()).toEqual(['(flight-state)', 'basic:error-share', 'unusual:code:ECONNRESET']);
      expect(rows.find((r) => r.key === 'basic:error-share')!.data).toMatchObject({ kind: 'basic', count: 4 });
    } finally {
      f.stop();
    }
  });
});
