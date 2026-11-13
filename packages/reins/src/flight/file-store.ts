// The file store (design C3, section 8): one instance, or a server and a watcher beside it on one machine,
// for example in local Docker with a shared volume. It lives under `.reins/flight/` unless the app names
// another folder. Each instance writes only its own files, so writers never race on one file:
//   steps/<start>-<instance>-<n>.jsonl     one step per line, appended; a segment holds at most an hour or
//                                          SEGMENT_LINES steps, so retention deletes whole files and never
//                                          rewrites a file a writer may be appending to
//   minutes/<instance>-<hour>.json         that instance's minutes of one hour
//   probes-<instance>.json                 the latest result of each probe that instance ran
//   findings.json                          written only by the lock holder
//   lock/<n>.json                          the checker lock: numbered generations, the highest one counts
// Imports: Node built-ins and reins' shared modules only (the flight safety test walks this file).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  byTime,
  countOpen,
  markerOf,
  PRUNE_INSTANCE,
  pruneBounds,
  summarize,
  type FindingRecord,
  type FlightStore,
  goodSteps,
  type InstanceMinute,
  laterProbe,
  lockHeld,
  lockUntil,
  planPrune,
  type ProbeResult,
  recordPruned,
  type Retention,
  runId,
  retention,
  selectOpen,
  selectRuns,
  type StepRecord,
} from './store.js';

export const SEGMENT_LINES = 10_000;
const HOUR = 3_600_000;

export interface FileStoreOptions extends Retention {
  /** The folder. Default `.reins/flight` under the current directory. */
  dir?: string;
}

/**
 * Instance names go into file names. Letters, digits and `-` stay; every other character (`_` too) becomes
 * `_` and its code in hex, so two names never share a file. A long result is replaced by a hash of the name.
 */
export const safe = (s: string) => {
  const out = String(s).replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(4, '0')}`) || '_';
  return out.length <= 96 ? out : `_h${createHash('sha256').update(String(s)).digest('hex').slice(0, 40)}`;
};

/** Findings by key, kept in a Map (a key such as `__proto__` is a key like any other); records of the wrong shape are skipped. */
async function readFindings(file: string): Promise<Map<string, FindingRecord>> {
  const out = new Map<string, FindingRecord>();
  const all = await readJson<unknown>(file);
  if (!all || typeof all !== 'object' || Array.isArray(all)) return out;
  for (const [key, f] of Object.entries(all as Record<string, any>)) {
    if (f && typeof f === 'object' && f.key === key && (f.state === 'open' || f.state === 'resolved') && Number.isFinite(f.updatedAt) && f.data && typeof f.data === 'object' && !Array.isArray(f.data)) {
      out.set(key, { key, state: f.state, updatedAt: f.updatedAt, data: f.data });
    }
  }
  return out;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Writes a whole file through a temporary file and a rename, so a reader never sees half of it. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  // Windows refuses a rename over a file another process has open for a moment; try a few times.
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file);
      return;
    } catch (e: any) {
      if (i >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(e?.code)) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 5 * (i + 1)));
    }
  }
}

/** The regular files in a folder: anything else (a folder named like a segment, say) is skipped. */
const listFiles = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
};

/** How long parsed segments are kept after the last read. */
const CACHE_IDLE_MS = 5000;

export function fileStore(o: FileStoreOptions = {}): FlightStore {
  const dir = o.dir || join(process.cwd(), '.reins', 'flight');
  const keep = retention(o);
  const stepsDir = join(dir, 'steps');
  const minutesDir = join(dir, 'minutes');
  const lockDir = join(dir, 'lock');
  /** This store object's open segment per instance. */
  const segments = new Map<string, { file: string; lines: number; hour: number }>();
  let made = false;
  let serial: Promise<unknown> = Promise.resolve();
  /** Runs read-modify-write work of this store object one at a time. */
  const queued = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = serial.then(fn, fn);
    serial = p.catch(() => {});
    return p;
  };

  function ensure() {
    if (made) return;
    // Owner-only, as the bridge keeps its token: files 0o600, folders 0o700.
    mkdirSync(stepsDir, { recursive: true, mode: 0o700 });
    mkdirSync(minutesDir, { recursive: true, mode: 0o700 });
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    // Same rule as the bridge: the .reins folder holds its own .gitignore so nothing in it is committed.
    const top = join(dir, '..');
    if (top.endsWith('.reins') && !existsSync(join(top, '.gitignore'))) writeFileSync(join(top, '.gitignore'), '*\n', { mode: 0o600 });
    made = true;
  }

  async function writeMinute(m: InstanceMinute): Promise<void> {
    ensure();
    const file = join(minutesDir, `${safe(m.instance)}-${m.minute - (m.minute % HOUR)}.json`);
    const all = (await readJson<Record<string, InstanceMinute>>(file)) || {};
    all[String(m.minute)] = m;
    await writeAtomic(file, JSON.stringify(all));
  }

  async function readMinutes(since: number): Promise<InstanceMinute[]> {
    const out: InstanceMinute[] = [];
    for (const f of await listFiles(minutesDir)) {
      const hour = Number(f.slice(f.lastIndexOf('-') + 1, -5));
      if (!f.endsWith('.json') || !(hour + HOUR > since)) continue;
      const all = await readJson<Record<string, InstanceMinute>>(join(minutesDir, f));
      for (const m of Object.values(all || {})) if (m && typeof m.minute === 'number' && m.minute >= since) out.push(m);
    }
    return out.sort((a, b) => a.minute - b.minute);
  }

  type Stored = StepRecord & { seq: number; file: string; mtimeMs: number };
  const strip = ({ seq: _s, file: _f, mtimeMs: _m, ...s }: Stored): StepRecord => s;

  /**
   * Parsed segments, kept while their size and time are unchanged, so a checker pass (which reads the steps of
   * each process twice) parses each segment once. Dropped CACHE_IDLE_MS after the last read, so the steps are
   * not held in memory between passes.
   */
  const cache = new Map<string, { size: number; mtimeMs: number; steps: StepRecord[] }>();
  let idle: ReturnType<typeof setTimeout> | null = null;

  async function readSegment(file: string): Promise<{ steps: StepRecord[]; mtimeMs: number } | null> {
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) return null; // pruned while listing, or not a file
    const hit = cache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { steps: hit.steps, mtimeMs: st.mtimeMs };
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (e: any) {
      if (e?.code === 'ENOENT' || e?.code === 'EISDIR') return null;
      throw e;
    }
    const steps: StepRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const s = JSON.parse(line);
        if (s && typeof s.process === 'string' && typeof s.key === 'string' && typeof s.step === 'string' && typeof s.at === 'number') {
          steps.push({ process: s.process, key: s.key, step: s.step, at: s.at, instance: String(s.instance) });
        }
      } catch {
        // A line cut short by a crash mid-append: skip it.
      }
    }
    // Only a segment read whole, at the size seen, is kept: one still being appended to is read again.
    if (Buffer.byteLength(text) === st.size) cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, steps });
    return { steps, mtimeMs: st.mtimeMs };
  }

  async function readSteps(): Promise<Stored[]> {
    const files = (await listFiles(stepsDir)).filter((f) => f.endsWith('.jsonl')).sort(byStart);
    const out: Stored[] = [];
    let seq = 0;
    const seen = new Set<string>();
    for (const f of files) {
      const file = join(stepsDir, f);
      seen.add(file);
      const seg = await readSegment(file);
      if (seg) for (const s of seg.steps) out.push({ ...s, seq: seq++, file, mtimeMs: seg.mtimeMs });
    }
    for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => cache.clear(), CACHE_IDLE_MS);
    (idle as any).unref?.();
    return out;
  }

  return {
    kind: 'file',
    addSteps: (list) =>
      queued(async () => {
        const steps = goodSteps(list);
        if (!steps.length) return;
        ensure();
        const groups = new Map<string, StepRecord[]>();
        for (const s of steps) {
          const g = groups.get(s.instance) || [];
          g.push(s);
          groups.set(s.instance, g);
        }
        for (const [instance, group] of groups) {
          let rest = group;
          while (rest.length) {
            const now = Date.now();
            const hour = now - (now % HOUR);
            let seg = segments.get(instance);
            if (!seg || seg.lines >= SEGMENT_LINES || seg.hour !== hour) {
              seg = { file: join(stepsDir, `${now}-${safe(instance)}-${randomBytes(3).toString('hex')}.jsonl`), lines: 0, hour };
              segments.set(instance, seg);
            }
            const take = rest.slice(0, SEGMENT_LINES - seg.lines);
            rest = rest.slice(take.length);
            await appendFile(seg.file, take.map(line).join(''), { mode: 0o600 });
            seg.lines += take.length;
          }
        }
      }),
    async runSteps(process, since) {
      return selectRuns(await readSteps(), process, since).sort(byTime).map(strip);
    },
    async openRuns(process, ends) {
      return selectOpen(await readSteps(), process, ends).sort(byTime).map(strip);
    },
    putMinute: (m) => queued(() => writeMinute(m)),
    minutes: readMinutes,
    putProbe: (r) =>
      queued(async () => {
        ensure();
        const file = join(dir, `probes-${safe(r.instance)}.json`);
        const all = (await readJson<Record<string, ProbeResult>>(file)) || {};
        if (!laterProbe(all[r.id], r)) return;
        all[r.id] = r;
        await writeAtomic(file, JSON.stringify(all));
      }),
    async probes() {
      const latest = new Map<string, ProbeResult>();
      for (const f of await listFiles(dir)) {
        if (!f.startsWith('probes-') || !f.endsWith('.json')) continue;
        for (const r of Object.values((await readJson<Record<string, ProbeResult>>(join(dir, f))) || {})) {
          if (r && typeof r.id === 'string' && typeof r.at === 'number' && laterProbe(latest.get(r.id), r)) latest.set(r.id, r);
        }
      }
      return [...latest.values()];
    },
    putFindings: (list2) =>
      queued(async () => {
        ensure();
        const file = join(dir, 'findings.json');
        const all = await readFindings(file);
        for (const f of list2) all.set(f.key, f);
        await writeAtomic(file, JSON.stringify(Object.fromEntries(all)));
      }),
    async findings() {
      return [...(await readFindings(join(dir, 'findings.json'))).values()];
    },
    lock: (owner, ttlMs, now = Date.now()) =>
      queued(() => {
        ensure();
        return takeLock(lockDir, owner, ttlMs, now);
      }),
    unlock: (owner) => queued(() => dropLock(lockDir, owner)),
    prune: (r2 = {}, now = Date.now(), ends = {}) =>
      queued(async () => {
        const k = retention({ ...keep, ...r2 });
        const cut = now - k.maxAgeMs;
        // Steps: whole runs only (B3, B7), oldest first, each leaving a marker (planPrune). A segment modified
        // within the last hour may still be appended to by a writer (a writer starts a new segment each hour),
        // so it is never rewritten or deleted: a run with a step in one is left for a later prune. Markers are
        // written first, so a crash part way leaves a run partial (and known to be), never silently gone.
        const runs = summarize(await readSteps());
        const young = (r: { steps: Stored[] }) => r.steps.some((s) => s.mtimeMs > now - HOUR);
        const plan = planPrune(runs.values(), pruneBounds(k, now), young);
        if (plan.mark.length) {
          const file = join(stepsDir, `${Date.now()}-${safe(PRUNE_INSTANCE)}-${randomBytes(3).toString('hex')}.jsonl`);
          await appendFile(file, plan.mark.map((r) => line(markerOf(r))).join(''), { mode: 0o600 });
        }
        const goneIds = new Set(plan.gone.map((r) => runId(r.process, r.key)));
        const touched = new Set(plan.gone.flatMap((r) => r.steps.map((s) => s.file)));
        const left = new Map<string, Stored[]>();
        for (const r of runs.values()) {
          if (goneIds.has(runId(r.process, r.key))) continue;
          for (const s of r.steps) {
            if (!touched.has(s.file)) continue;
            const l = left.get(s.file);
            if (l) l.push(s);
            else left.set(s.file, [s]);
          }
        }
        for (const file of touched) {
          const kept = (left.get(file) || []).sort((a, b) => a.seq - b.seq);
          if (!kept.length) {
            await unlink(file).catch(() => {});
            for (const [i, s] of segments) if (s.file === file) segments.delete(i);
          } else {
            await writeAtomic(file, kept.map(line).join(''));
            for (const s of segments.values()) if (s.file === file) s.lines = kept.length;
          }
          cache.delete(file);
        }
        const counts = countOpen(plan.gone, ends);
        for (const f of await listFiles(minutesDir)) {
          const hour = Number(f.slice(f.lastIndexOf('-') + 1, -5));
          if (f.endsWith('.json') && hour + HOUR < cut) await unlink(join(minutesDir, f)).catch(() => {});
        }
        for (const f of await listFiles(dir)) {
          if (!f.startsWith('probes-') || !f.endsWith('.json')) continue;
          const st = await stat(join(dir, f)).catch(() => null);
          if (st && st.mtimeMs < cut) await unlink(join(dir, f)).catch(() => {});
        }
        const fFile = join(dir, 'findings.json');
        const found = await readFindings(fFile);
        let changed = false;
        for (const [key, f] of found) {
          if (f.state === 'resolved' && f.updatedAt < cut) {
            found.delete(key);
            changed = true;
          }
        }
        if (changed) await writeAtomic(fFile, JSON.stringify(Object.fromEntries(found)));
        // Inside the queue already: write through the unqueued writer.
        await recordPruned({ minutes: readMinutes, putMinute: writeMinute }, counts, now);
      }),
  };
}

/** One step as a segment line. */
const line = (s: StepRecord) => JSON.stringify({ process: s.process, key: s.key, step: s.step, at: s.at, instance: s.instance }) + '\n';

/** Segment files sort by their start time, the number before the first `-`. */
const byStart = (a: string, b: string) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || (a < b ? -1 : a > b ? 1 : 0);


// The file lock (B4: at most one holder at a time). The folder `lock/` holds numbered generation files
// `<n>.json`, each `{ owner, until }`; the one with the highest n is the lock. A checker that finds it free (past
// its time, impossibly far ahead, released, or broken past BROKEN_LOCK_MS), or its own, makes generation n + 1
// with an exclusive create: of the checkers that read n, only one can make n + 1. It then lists the folder again
// and holds the lock only if n + 1 is still the highest (a checker that read the folder late can only make a
// number below the top, and loses here). Nothing is ever renamed or written over; the holder removes the
// generations below its own, so the folder holds one or two files.

/** Generation file names: a number without leading zeros, at most 15 digits, so n + 1 is always exact. */
const GEN = /^(0|[1-9]\d{0,14})\.json$/;
/** Generations stop below this. Only a planted name gets near it; such a top file is removed once it is free. */
const MAX_GEN = 999_999_999_999_999;
/**
 * A generation file that cannot be read as a lock (empty because its maker died between creating and writing
 * it, cut short, unreadable, not a file, or planted) counts as held until this long after its modification time,
 * then as free, so nothing in the folder can block takeover for longer than this, or a valid lock's own time
 * (at most MAX_LOCK_MS).
 */
export const BROKEN_LOCK_MS = 10_000;

/** The top generation and whether it holds at `now`; null when there is none. */
async function topGen(lockDir: string, now: number): Promise<{ n: number; owner?: string; held: boolean } | null> {
  let n = -1;
  for (const f of await readdir(lockDir).catch(() => [] as string[])) {
    const m = GEN.exec(f);
    if (m && Number(m[1]) > n) n = Number(m[1]);
  }
  if (n < 0) return null;
  const file = join(lockDir, `${n}.json`);
  try {
    const cur = JSON.parse(await readFile(file, 'utf8'));
    if (cur && typeof cur.owner === 'string' && typeof cur.until === 'number') return { n, owner: cur.owner, held: lockHeld(cur.until, now) };
  } catch {
    // Not a lock: judged by its age below.
  }
  const st = await stat(file).catch(() => null);
  const age = st ? Date.now() - st.mtimeMs : Infinity;
  return { n, held: age > -BROKEN_LOCK_MS && age < BROKEN_LOCK_MS };
}

/** Makes generation `n` holding `lock`; false when it exists already. */
async function makeGen(lockDir: string, n: number, lock: { owner: string; until: number }): Promise<boolean> {
  const file = join(lockDir, `${n}.json`);
  let fh;
  try {
    fh = await open(file, 'wx', 0o600);
  } catch (e: any) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  }
  try {
    await fh.writeFile(JSON.stringify(lock));
  } catch {
    await fh.close().catch(() => {});
    await unlink(file).catch(() => {});
    return false;
  }
  await fh.close().catch(() => {});
  return true;
}

/** Removes the generations below `n`, best effort: only the top one counts, so a leftover is harmless. */
async function dropBelow(lockDir: string, n: number): Promise<void> {
  for (const f of await readdir(lockDir).catch(() => [] as string[])) {
    const m = GEN.exec(f);
    if (m && Number(m[1]) < n) await unlink(join(lockDir, f)).catch(() => {});
  }
}

async function takeLock(lockDir: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
  const top = await topGen(lockDir, now);
  if (top && top.held && top.owner !== owner) return false;
  const n = top ? top.n : 0;
  if (n + 1 >= MAX_GEN) {
    // A planted number at the end of the range: remove it (it is free or ours) and start below it next time.
    await unlink(join(lockDir, `${n}.json`)).catch(() => {});
    return false;
  }
  if (!(await makeGen(lockDir, n + 1, { owner, until: lockUntil(now, ttlMs) }))) return false;
  const after = await topGen(lockDir, now);
  if (after?.n !== n + 1) {
    await unlink(join(lockDir, `${n + 1}.json`)).catch(() => {});
    return false;
  }
  await dropBelow(lockDir, n + 1);
  return true;
}

/** Gives the lock up if `owner` holds the top generation, by making the next one free; never writes over another's. */
async function dropLock(lockDir: string, owner: string): Promise<void> {
  const top = await topGen(lockDir, Date.now());
  if (!top || top.owner !== owner || top.n + 1 >= MAX_GEN) return;
  if (await makeGen(lockDir, top.n + 1, { owner, until: 0 })) await dropBelow(lockDir, top.n + 1);
}
