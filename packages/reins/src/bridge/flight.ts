// The bridge's `reins_flight` tool (design sections 6 and 11): the flight report for an agent in development, from
// a saved report file or the file store under the project (for example one the app writes from local Docker
// through a shared folder). Read only: it never loads app code (not the app's flight config module either), never
// reaches a Postgres store, writes nothing, and refuses any path outside the project folder. Process keys (payout
// ids and the like) are left out of the data unless the call asks for them; the Markdown never holds them.
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileStore } from '../flight/file-store.js';
import { MANIFEST_FILE, parseManifest, serviceOf, type ManifestResult } from '../flight/manifest.js';
import { parseFlightReport, renderFlightMarkdown } from '../flight/render.js';
import { collectReport, type FlightReport } from '../flight/report.js';

/** What the tool reads at most, and how long it waits for a store. Tests pass smaller ones. */
export interface FlightToolLimits {
  /** A saved report file is read only up to this size. */
  reportBytes: number;
  /** The manifest is read only up to this size. */
  manifestBytes: number;
  /** A file store is read only while its files add up to at most this size... */
  storeBytes: number;
  /** ...and number at most this many. */
  storeFiles: number;
  /** How long the store may take to read before the report says it could not be read. */
  timeoutMs: number;
}

export const FLIGHT_TOOL_LIMITS: Readonly<FlightToolLimits> = Object.freeze({
  reportBytes: 8 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
  storeBytes: 64 * 1024 * 1024,
  storeFiles: 5000,
  timeoutMs: 15_000,
});
/** Paths longer than this are refused. */
const MAX_PATH = 1024;
/** The file store's default folder, relative to the project. */
export const DEFAULT_STORE = '.reins/flight';
/** The file store's subfolders (file-store.ts): the only folders it reads below its own. */
const STORE_FOLDERS = ['steps', 'minutes', 'lock'];

/** Windows device names (`CON`, `NUL`, `COM1`, `LPT1`...), also with an extension (`nul.json`): never a file to read. */
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

const refused = (what: string, why: string) => new Error(`reins_flight refused the ${what} path: ${why}. Give a path inside the project folder.`);

/**
 * Resolves `p` (relative to the project, or absolute inside it) to its real path, following links, and refuses it
 * unless that real path is inside the project's real folder. Refused before resolving: a NUL byte, a UNC or device
 * path (`\\server\share`, `\\?\`, `//host`), any `..` segment, a drive-relative path or a stream name (`C:x`,
 * `a.json:s`), a Windows device name in any segment (`NUL`, `com1.json`). Refused after: anything whose real path (links and junctions resolved) is outside the project,
 * including another drive. A path that does not exist is a plain "not found".
 */
export function projectPath(root: string, p: unknown, what: string): string {
  if (typeof p !== 'string' || !p.trim()) throw refused(what, 'it is empty or not a string');
  if (p.length > MAX_PATH) throw refused(what, `it is longer than ${MAX_PATH} characters`);
  if (p.includes('\0')) throw refused(what, 'it holds a NUL byte');
  if (/^[\\/]{2}/.test(p)) throw refused(what, 'UNC and device paths are not read');
  if (p.split(/[\\/]/).includes('..')) throw refused(what, "it goes up with '..'");
  if (p.replace(/^[A-Za-z]:(?=[\\/])/, '').includes(':')) throw refused(what, 'drive-relative paths and stream names are not read');
  if (p.split(/[\\/]/).some((s) => DEVICE.test(s.split('.')[0].trimEnd()))) throw refused(what, 'device names (CON, NUL, COM1, LPT1...) are not read');
  let base: string;
  try {
    base = realpathSync.native(root);
  } catch {
    throw new Error('reins_flight: the project folder cannot be read');
  }
  let real: string;
  try {
    real = realpathSync.native(resolve(root, p));
  } catch (e: any) {
    // Only for a path that is inside before resolving links: a missing path elsewhere is still refused.
    if (outside(base, resolve(base, p)) && outside(resolve(root), resolve(root, p))) throw refused(what, 'it is outside the project');
    throw new Error(`reins_flight: ${what} ${p} ${e?.code === 'ENOENT' ? 'not found' : `could not be read (${e?.code || 'error'})`}`);
  }
  if (outside(base, real)) throw refused(what, 'it is outside the project (after resolving links)');
  return real;
}

function outside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

/**
 * A file with more than one hard link may be the same file as one outside the project, which no path check can
 * tell, so it is not read.
 */
const hardLinked = (what: string) => refused(what, 'it is a file with more than one hard link, which may be a file outside the project');

/** Reads a regular file of at most `max` bytes through one descriptor, so what is checked is what is read. */
function readCapped(file: string, max: number, what: string): string {
  // Checked before opening too: opening a FIFO or a device could block or read without end.
  const pre = statSync(file);
  if (!pre.isFile()) throw new Error(`reins_flight: the ${what} is not a file`);
  if (pre.nlink > 1) throw hardLinked(what);
  const fd = openSync(file, 'r');
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`reins_flight: the ${what} is not a file`);
    if (st.nlink > 1) throw hardLinked(what);
    if (st.size > max) throw new Error(`reins_flight: the ${what} is larger than ${max} bytes, so it is not read`);
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r: number; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0; ) n += r;
    if (n > max) throw new Error(`reins_flight: the ${what} is larger than ${max} bytes, so it is not read`);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Checks a file store folder before it is read: no link (or junction) in it or in its subfolders, since the store
 * would follow one out of the project, and its files add up to at most `maxBytes` and `maxFiles`.
 */
function checkStore(dir: string, maxBytes: number, maxFiles: number): void {
  let bytes = 0;
  let files = 0;
  const visit = (folder: string, depth: number) => {
    for (const name of readdirSync(folder)) {
      const st = lstatSync(join(folder, name));
      if (st.isSymbolicLink()) throw refused('store', `it holds a link (${depth ? `${relative(dir, folder)}/` : ''}${name}), which could lead out of the project`);
      if (st.isDirectory()) {
        if (depth === 0 && STORE_FOLDERS.includes(name)) visit(join(folder, name), 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.nlink > 1) throw hardLinked('store');
      files++;
      bytes += st.size;
      if (files > maxFiles || bytes > maxBytes)
        throw new Error(`reins_flight: the file store holds more than ${maxFiles} files or ${maxBytes} bytes, so it is not read here; run npx reins flight report --config <module> instead`);
    }
  };
  visit(dir, 0);
}

/** The project's manifest, read as data (never as code), or null when there is none. */
function readProjectManifest(root: string, p: unknown, max: number): ManifestResult | null {
  let file: string;
  try {
    file = projectPath(root, p === undefined ? MANIFEST_FILE : p, 'manifest');
  } catch (e: any) {
    if (p === undefined && /not found$/.test(e.message)) return null;
    throw e;
  }
  const result = parseManifest(readCapped(file, max, 'manifest'));
  // JSON.parse's error quotes the text it read (a .env named as the manifest would show its secret), so the tool
  // says only that it is not JSON.
  if (!result.ok) for (const p of result.problems) if (p.message.startsWith('is not valid JSON')) p.message = 'is not valid JSON';
  return result;
}

/**
 * The report without process keys: they are server-side data (design C6), returned only when asked for.
 * Rule: keys only on request. Every report field that can hold a `keys` list must be stripped here; today those
 * are `findings` and `resolved`. A new field that carries keys must be added to this function.
 */
function withoutKeys(r: FlightReport): FlightReport {
  const strip = (l: unknown) => (Array.isArray(l) ? l.map((f) => (f && typeof f === 'object' ? (({ keys: _k, ...rest }) => rest)(f) : f)) : l);
  return { ...r, findings: strip(r.findings) as FlightReport['findings'], resolved: strip(r.resolved) as FlightReport['resolved'] };
}

export interface FlightToolResult {
  source: 'file' | 'store';
  /** The path read, relative to the project. */
  path: string;
  /** Whether the data holds process keys. */
  keys: boolean;
  markdown: string;
  report: FlightReport;
}

/** Runs `reins_flight` for the project folder `root`. Throws a plain message on a refused or unreadable input. */
export async function flightTool(root: string, args: Record<string, any> = {}, limits: FlightToolLimits = FLIGHT_TOOL_LIMITS): Promise<FlightToolResult> {
  if (args.file !== undefined && args.store !== undefined) throw new Error('reins_flight: give file or store, not both');
  const keys = args.keys === true;
  const base = realpathSync.native(root);
  const rel = (real: string) => relative(base, real).split(sep).join('/') || '.';
  let report: FlightReport;
  let source: 'file' | 'store';
  let path: string;
  if (args.file !== undefined) {
    const file = projectPath(root, args.file, 'report file');
    const text = readCapped(file, limits.reportBytes, 'report file');
    try {
      report = parseFlightReport(text);
    } catch (e: any) {
      throw new Error(`reins_flight: ${rel(file)} ${e.message}`);
    }
    source = 'file';
    path = rel(file);
  } else {
    let dir: string;
    try {
      dir = projectPath(root, args.store === undefined ? DEFAULT_STORE : args.store, 'store');
    } catch (e: any) {
      if (args.store === undefined && /not found$/.test(e.message))
        throw new Error(`reins_flight: no file store at ${DEFAULT_STORE} and no file given. Pass file (a saved report, e.g. from npx reins flight report --json) or store (the file store folder inside the project).`);
      throw e;
    }
    if (!lstatSync(dir).isDirectory()) throw new Error('reins_flight: the store is not a folder');
    checkStore(dir, limits.storeBytes, limits.storeFiles);
    const manifest = readProjectManifest(root, args.manifest, limits.manifestBytes);
    report = await collectReport({ store: fileStore({ dir }), manifest, service: serviceOf(undefined, manifest), timeoutMs: limits.timeoutMs });
    source = 'store';
    path = rel(dir);
  }
  return { source, path, keys, markdown: renderFlightMarkdown(report), report: keys ? report : withoutKeys(report) };
}
