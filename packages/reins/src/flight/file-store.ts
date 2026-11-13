// The file store (design C3, section 8): one instance, or a server and a watcher beside it on one machine,
// for example in local Docker with a shared volume. It lives under `.reins/flight/` unless the app names
// another folder. Each instance writes only its own files, so writers never race on one file:
//   steps/<start>-<instance>-<n>.jsonl     one step per line, appended; a segment holds at most an hour or
//                                          SEGMENT_LINES steps, so retention deletes whole files and never
//                                          rewrites a file a writer may be appending to
//   minutes/<instance>-<hour>.json         that instance's minutes of one hour
//   probes-<instance>.json                 the latest result of each probe that instance ran
//   findings.json                          written only by the lock holder
//   lock.json                              the checker lock
// Imports: Node built-ins and reins' shared modules only (the flight safety test walks this file).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, link, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  byTime,
  countOpenRemoved,
  type FindingRecord,
  type FlightStore,
  type InstanceMinute,
  laterProbe,
  lockHeld,
  lockUntil,
  type ProbeResult,
  recordPruned,
  type Retention,
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

/** Instance names go into file names: anything but letters, digits, `_` and `-` becomes `_`. */
const safe = (s: string) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || '_';

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
  await writeFile(tmp, text);
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

const list = async (dir: string) => {
  try {
    return await readdir(dir);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
};

export function fileStore(o: FileStoreOptions = {}): FlightStore {
  const dir = o.dir || join(process.cwd(), '.reins', 'flight');
  const keep = retention(o);
  const stepsDir = join(dir, 'steps');
  const minutesDir = join(dir, 'minutes');
  const lockFile = join(dir, 'lock.json');
  /** This store object's open segment per instance. */
  const segments = new Map<string, { file: string; lines: number; hour: number }>();
  let made = false;
  let swept = 0;
  /** Removes old claim files, at most once a minute. */
  const sweep = async () => {
    if (Date.now() - swept < 60_000) return;
    swept = Date.now();
    await sweepClaims(dir);
  };
  let serial: Promise<unknown> = Promise.resolve();
  /** Runs read-modify-write work of this store object one at a time. */
  const queued = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = serial.then(fn, fn);
    serial = p.catch(() => {});
    return p;
  };

  function ensure() {
    if (made) return;
    mkdirSync(stepsDir, { recursive: true });
    mkdirSync(minutesDir, { recursive: true });
    // Same rule as the bridge: the .reins folder holds its own .gitignore so nothing in it is committed.
    const top = join(dir, '..');
    if (top.endsWith('.reins') && !existsSync(join(top, '.gitignore'))) writeFileSync(join(top, '.gitignore'), '*\n');
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
    for (const f of await list(minutesDir)) {
      const hour = Number(f.slice(f.lastIndexOf('-') + 1, -5));
      if (!f.endsWith('.json') || !(hour + HOUR > since)) continue;
      const all = await readJson<Record<string, InstanceMinute>>(join(minutesDir, f));
      for (const m of Object.values(all || {})) if (m && typeof m.minute === 'number' && m.minute >= since) out.push(m);
    }
    return out.sort((a, b) => a.minute - b.minute);
  }

  type Stored = StepRecord & { seq: number; file: string };
  const strip = ({ seq: _s, file: _f, ...s }: Stored): StepRecord => s;

  async function readSteps(): Promise<Stored[]> {
    const files = (await list(stepsDir)).filter((f) => f.endsWith('.jsonl')).sort(byStart);
    const out: Stored[] = [];
    let seq = 0;
    for (const f of files) {
      let text = '';
      try {
        text = await readFile(join(stepsDir, f), 'utf8');
      } catch (e: any) {
        if (e?.code === 'ENOENT') continue; // pruned while listing
        throw e;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const s = JSON.parse(line);
          if (typeof s.process === 'string' && typeof s.key === 'string' && typeof s.step === 'string' && typeof s.at === 'number') {
            out.push({ process: s.process, key: s.key, step: s.step, at: s.at, instance: String(s.instance), seq: seq++, file: join(stepsDir, f) });
          }
        } catch {
          // A line cut short by a crash mid-append: skip it.
        }
      }
    }
    return out;
  }

  return {
    kind: 'file',
    addSteps: (steps) =>
      queued(async () => {
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
            await appendFile(seg.file, take.map((s) => JSON.stringify({ process: s.process, key: s.key, step: s.step, at: s.at, instance: s.instance }) + '\n').join(''));
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
      for (const f of await list(dir)) {
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
        const all = (await readJson<Record<string, FindingRecord>>(file)) || {};
        for (const f of list2) all[f.key] = f;
        await writeAtomic(file, JSON.stringify(all));
      }),
    async findings() {
      return Object.values((await readJson<Record<string, FindingRecord>>(join(dir, 'findings.json'))) || {});
    },
    lock: (owner, ttlMs, now = Date.now()) => queued(() => takeLock(dir, lockFile, owner, ttlMs, now, ensure, sweep)),
    unlock: (owner) => queued(() => dropLock(dir, lockFile, owner)),
    prune: (r2 = {}, now = Date.now(), ends = {}) =>
      queued(async () => {
        const k = retention({ ...keep, ...r2 });
        const cut = now - k.maxAgeMs;
        // Steps: whole segments only. By age when the segment was last written before the cut (nothing was
        // appended since, so its writer has moved on to a new hour's segment); by count from the oldest
        // segment, never a segment this store object is still appending to.
        const open = new Set([...segments.values()].map((s) => s.file));
        const all = await readSteps();
        const lines = new Map<string, number>();
        for (const s of all) lines.set(s.file, (lines.get(s.file) || 0) + 1);
        const gone = new Set<string>();
        const segs: Array<{ file: string; lines: number }> = [];
        for (const f of (await list(stepsDir)).filter((x) => x.endsWith('.jsonl')).sort(byStart)) {
          const file = join(stepsDir, f);
          const st = await stat(file).catch(() => null);
          if (!st) continue;
          if (st.mtimeMs < cut) gone.add(file);
          else segs.push({ file, lines: lines.get(file) || 0 });
        }
        let total = segs.reduce((n, s) => n + s.lines, 0);
        for (const s of segs) {
          if (total <= k.maxSteps) break;
          if (open.has(s.file)) continue;
          gone.add(s.file);
          total -= s.lines;
        }
        const counts = countOpenRemoved(
          all.filter((s) => gone.has(s.file)),
          all.filter((s) => !gone.has(s.file)),
          ends,
        );
        for (const file of gone) {
          await unlink(file).catch(() => {});
          for (const [i, s] of segments) if (s.file === file) segments.delete(i);
        }
        for (const f of await list(minutesDir)) {
          const hour = Number(f.slice(f.lastIndexOf('-') + 1, -5));
          if (f.endsWith('.json') && hour + HOUR < cut) await unlink(join(minutesDir, f)).catch(() => {});
        }
        for (const f of await list(dir)) {
          if (!f.startsWith('probes-') || !f.endsWith('.json')) continue;
          const st = await stat(join(dir, f)).catch(() => null);
          if (st && st.mtimeMs < cut) await unlink(join(dir, f)).catch(() => {});
        }
        const fFile = join(dir, 'findings.json');
        const found = await readJson<Record<string, FindingRecord>>(fFile);
        if (found) {
          let changed = false;
          for (const [key, f] of Object.entries(found)) {
            if (f.state === 'resolved' && f.updatedAt < cut) {
              delete found[key];
              changed = true;
            }
          }
          if (changed) await writeAtomic(fFile, JSON.stringify(found));
        }
        // Inside the queue already: write through the unqueued writer.
        await recordPruned({ minutes: readMinutes, putMinute: writeMinute }, counts, now);
      }),
  };
}

/** Segment files sort by their start time, the number before the first `-`. */
const byStart = (a: string, b: string) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || (a < b ? -1 : a > b ? 1 : 0);

/** Claim files older than this are removed. A checker never waits this long between reading the lock and claiming it. */
const CLAIM_KEEP_MS = 3_600_000;

/** Reads the lock file: its text, null when there is none, or undefined when it cannot be read now. */
async function readLock(file: string): Promise<string | null | undefined> {
  for (let i = 0; ; i++) {
    try {
      return await readFile(file, 'utf8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      // Windows refuses a read for a moment while the file is being replaced.
      if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e?.code)) return undefined;
      await new Promise((r) => setTimeout(r, 5 * (i + 1)));
    }
  }
}

/**
 * Claims the right to change the lock file away from the content `text`. The claim is a file named by a hash
 * of that content, made with an exclusive create, so of the checkers that read the same content only one gets
 * it. Every lock written holds a random nonce, so a content never comes back and a claim is never reused.
 */
async function claim(dir: string, text: string): Promise<string | null> {
  const file = join(dir, `lock.${createHash('sha256').update(text).digest('hex').slice(0, 32)}.claim`);
  try {
    await (await open(file, 'wx', 0o600)).close();
    return file;
  } catch {
    return null;
  }
}

/**
 * The file lock (B4: at most one holder at a time). `lock.json` holds `{ owner, until, nonce }`.
 * - Free (no file): a complete candidate file is hard-linked into place, which fails when the file exists, so
 *   of two checkers only one makes it, and no reader ever sees half a lock.
 * - Held by another and not past its time: refused.
 * - Anything else (renewing one's own lock, or taking over a lock past its time, impossibly far ahead, or cut
 *   short) is a compare-and-swap: claim the content read (only one checker can), read again to confirm it is
 *   still that content, write the new lock by an atomic rename, and read it back. An expired lock is never
 *   renewed in place: its owner takes it over like anyone else.
 */
async function takeLock(dir: string, file: string, owner: string, ttlMs: number, now: number, ensure: () => void, sweep: () => Promise<void>): Promise<boolean> {
  ensure();
  const mine = JSON.stringify({ owner, until: lockUntil(now, ttlMs), nonce: randomBytes(8).toString('hex') });
  const put = async () => {
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, mine, { mode: 0o600 });
    try {
      await link(tmp, file);
      return true;
    } catch (e: any) {
      if (e?.code === 'EEXIST') return false;
      throw e;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  };
  const text = await readLock(file);
  if (text === undefined) return false;
  if (text === null) return put();
  let cur: { owner?: unknown; until?: unknown } = {};
  try {
    cur = JSON.parse(text) || {};
  } catch {
    // A lock file cut short: treat it as stale.
  }
  if (cur.owner !== owner && lockHeld(cur.until, now)) return false;
  const claimed = await claim(dir, text);
  if (!claimed) return false;
  if ((await readLock(file)) !== text) return false; // changed since it was read: another checker moved first
  try {
    await writeAtomic(file, mine);
  } catch {
    // Nothing was changed: give the claim back so the lock can still be taken over.
    await unlink(claimed).catch(() => {});
    return false;
  }
  if ((await readLock(file)) !== mine) return false;
  await sweep();
  return true;
}

/** Gives the lock up if `owner` holds it, by the same compare-and-swap, so it never removes another's lock. */
async function dropLock(dir: string, file: string, owner: string): Promise<void> {
  const text = await readLock(file);
  if (!text) return;
  let cur: { owner?: unknown } = {};
  try {
    cur = JSON.parse(text) || {};
  } catch {
    return;
  }
  if (cur.owner !== owner || !(await claim(dir, text))) return;
  if ((await readLock(file)) === text) await unlink(file).catch(() => {});
}

async function sweepClaims(dir: string): Promise<void> {
  const old = Date.now() - CLAIM_KEEP_MS;
  for (const f of await list(dir).catch(() => [] as string[])) {
    if (!f.endsWith('.claim') && !(f.startsWith('lock.json.') && f.endsWith('.tmp'))) continue;
    const st = await stat(join(dir, f)).catch(() => null);
    if (st && st.isFile() && st.mtimeMs < old) await unlink(join(dir, f)).catch(() => {});
  }
}
