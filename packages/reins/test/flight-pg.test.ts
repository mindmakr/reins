// Design B11: the Postgres store's statements against a real Postgres. Runs only when REINS_FLIGHT_PG_URL is
// set (a throwaway database: the test drops and recreates the flight tables). `pg` is a dev dependency of the
// repository only; the package itself gains no driver.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/flight/checker.js';
import { validateManifest } from '../src/flight/manifest.js';
import { PG_TABLES, pgStore, type QueryFn } from '../src/flight/pg-store.js';
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
});
