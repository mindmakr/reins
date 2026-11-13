// The Postgres store (design C3, C4, section 8). reins adds no database driver: the app passes a query
// function that runs one statement with parameters on its own connection, such as `(text, params) =>
// pool.query(text, params)` with `pg`. Flight never creates a table: it ships PG_TABLES, and the app adds it
// through its own migration flow. Every value (process, key, step name, instance, probe id, finding) is a
// parameter; no value is ever built into SQL text.
// Imports: Node built-ins and reins' shared modules only (the flight safety test walks this file).
import {
  type FindingRecord,
  type FlightStore,
  type InstanceMinute,
  lockUntil,
  MAX_LOCK_MS,
  type ProbeResult,
  recordPruned,
  type Retention,
  retention,
  type StepRecord,
} from './store.js';

/** Runs one statement. May return the rows, or a result with `rows` (as `pg` does). */
export type QueryFn = (text: string, params: unknown[]) => Promise<unknown[] | { rows: unknown[] }>;

/** The tables, for the app's own migration. Times are wall-clock milliseconds. */
export const PG_TABLES = `create table reins_flight_steps (
  id bigserial primary key,
  process text not null,
  key text not null,
  step text not null,
  at bigint not null,
  instance text not null
);
create index reins_flight_steps_process_key on reins_flight_steps (process, key);
create index reins_flight_steps_process_at on reins_flight_steps (process, at);
create index reins_flight_steps_at on reins_flight_steps (at);

create table reins_flight_minutes (
  instance text not null,
  minute bigint not null,
  data jsonb not null,
  primary key (instance, minute)
);
create index reins_flight_minutes_minute on reins_flight_minutes (minute);

create table reins_flight_probes (
  id text primary key,
  instance text not null,
  at bigint not null,
  ok boolean not null,
  reason text,
  ms integer not null
);

create table reins_flight_findings (
  key text primary key,
  state text not null,
  updated_at bigint not null,
  data jsonb not null
);

create table reins_flight_lock (
  name text primary key,
  owner text not null,
  until bigint not null
);
`;

export interface PgStoreOptions extends Retention {
  query: QueryFn;
}

const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
const num = (v: unknown) => Number(v);

export function pgStore(o: PgStoreOptions): FlightStore {
  if (!o || typeof o.query !== 'function') throw new TypeError('pgStore needs a query function');
  const keep = retention(o);
  const q = async (text: string, params: unknown[] = []): Promise<any[]> => {
    const r = await o.query(text, params);
    return Array.isArray(r) ? r : Array.isArray((r as any)?.rows) ? (r as any).rows : [];
  };

  const self: FlightStore = {
    kind: 'postgres',
    async addSteps(steps: StepRecord[]) {
      if (!steps.length) return;
      await q(
        `insert into reins_flight_steps (process, key, step, at, instance)
         select * from unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[])`,
        [steps.map((s) => s.process), steps.map((s) => s.key), steps.map((s) => s.step), steps.map((s) => s.at), steps.map((s) => s.instance)],
      );
    },
    async runSteps(process, since) {
      const rows = await q(
        `select process, key, step, at, instance from reins_flight_steps
         where process = $1 and key in (select key from reins_flight_steps where process = $1 and at >= $2)
         order by at, id`,
        [process, since],
      );
      return rows.map((r) => ({ process: r.process, key: r.key, step: r.step, at: num(r.at), instance: r.instance }));
    },
    async openRuns(process, ends) {
      const rows = await q(
        `select process, key, step, at, instance from reins_flight_steps
         where process = $1 and key in (
           select key from reins_flight_steps where process = $1 group by key having not bool_or(step = any($2::text[])))
         order by at, id`,
        [process, ends],
      );
      return rows.map((r) => ({ process: r.process, key: r.key, step: r.step, at: num(r.at), instance: r.instance }));
    },
    async putMinute(m: InstanceMinute) {
      await q(
        `insert into reins_flight_minutes (instance, minute, data) values ($1, $2, $3::jsonb)
         on conflict (instance, minute) do update set data = excluded.data`,
        [m.instance, m.minute, JSON.stringify(m)],
      );
    },
    async minutes(since) {
      const rows = await q(`select data from reins_flight_minutes where minute >= $1 order by minute, instance`, [since]);
      return rows.map((r) => json(r.data) as InstanceMinute).filter((m) => m && typeof m === 'object' && typeof m.minute === 'number');
    },
    async putProbe(r: ProbeResult) {
      await q(
        `insert into reins_flight_probes (id, instance, at, ok, reason, ms) values ($1, $2, $3, $4, $5, $6)
         on conflict (id) do update set instance = excluded.instance, at = excluded.at, ok = excluded.ok,
           reason = excluded.reason, ms = excluded.ms
         where reins_flight_probes.at <= excluded.at`,
        [r.id, r.instance, r.at, r.ok, r.reason ?? null, Math.round(r.ms)],
      );
    },
    async probes() {
      const rows = await q(`select id, instance, at, ok, reason, ms from reins_flight_probes order by id`);
      return rows.map((r) => ({ id: r.id, instance: r.instance, at: num(r.at), ok: !!r.ok, ...(r.reason ? { reason: r.reason } : {}), ms: num(r.ms) }));
    },
    async putFindings(list: FindingRecord[]) {
      for (const f of list) {
        await q(
          `insert into reins_flight_findings (key, state, updated_at, data) values ($1, $2, $3, $4::jsonb)
           on conflict (key) do update set state = excluded.state, updated_at = excluded.updated_at, data = excluded.data`,
          [f.key, f.state, f.updatedAt, JSON.stringify(f.data ?? {})],
        );
      }
    },
    async findings() {
      const rows = await q(`select key, state, updated_at, data from reins_flight_findings order by key`);
      return rows.map((r) => ({ key: r.key, state: r.state, updatedAt: num(r.updated_at), data: json(r.data) }));
    },
    // One statement, so two checkers cannot both win: the row is made when there is none, and taken over only
    // by its owner (a renewal), when its time has passed, or when its time is impossibly far ahead (later than
    // now plus MAX_LOCK_MS). A row comes back only when `owner` holds the lock.
    async lock(owner, ttlMs, now = Date.now()) {
      const rows = await q(
        `insert into reins_flight_lock (name, owner, until) values ('checker', $1, $2)
         on conflict (name) do update set owner = excluded.owner, until = excluded.until
         where reins_flight_lock.owner = excluded.owner or reins_flight_lock.until <= $3 or reins_flight_lock.until > $4
         returning owner`,
        [owner, lockUntil(now, ttlMs), now, now + MAX_LOCK_MS],
      );
      return rows.length === 1;
    },
    async unlock(owner) {
      await q(`delete from reins_flight_lock where name = 'checker' and owner = $1`, [owner]);
    },
    async prune(r2 = {}, now = Date.now(), ends = {}) {
      const k = retention({ ...keep, ...r2 });
      const cut = now - k.maxAgeMs;
      // Whole runs only, in one statement (B3, B7): a run goes when its newest step is before the cut; then,
      // while more than maxSteps steps are left, the runs whose newest step is oldest go first. The statement
      // returns, per process named in `ends`, the runs it removed that had reached no end step. End steps go
      // as `process step` pairs, as parameters.
      const processes = Object.keys(ends);
      const pairs = processes.flatMap((p) => (Array.isArray(ends[p]) ? ends[p] : []).map((s) => `${p} ${s}`));
      const rows = await q(
        `with runs as (
           select process, key, max(at) as last, count(*) as n,
                  bool_or((process || ' ' || step) = any($4::text[])) as ended
           from reins_flight_steps group by process, key
         ), ranked as (
           select process, key, ended,
                  sum(n) over (order by last desc, process desc, key desc rows between unbounded preceding and current row) as kept
           from runs where last >= $1::bigint
         ), gone as (
           select process, key, ended from runs where last < $1::bigint
           union all
           select process, key, ended from ranked where kept > $2::bigint
         ), removed as (
           delete from reins_flight_steps s using gone g where s.process = g.process and s.key = g.key
         )
         select process, count(*) as n from gone where not ended and process = any($3::text[]) group by process`,
        [cut, k.maxSteps, processes, pairs],
      );
      const counts: Record<string, number> = {};
      for (const r of rows) if (typeof r?.process === 'string' && Number.isFinite(num(r.n))) counts[r.process] = num(r.n);
      await q(`delete from reins_flight_minutes where minute < $1`, [cut]);
      await q(`delete from reins_flight_probes where at < $1`, [cut]);
      await q(`delete from reins_flight_findings where state = 'resolved' and updated_at < $1`, [cut]);
      await recordPruned(self, counts, now);
    },
  };
  return self;
}
