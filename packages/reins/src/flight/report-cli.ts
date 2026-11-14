// `reins flight report` (design section 6): the report from the app's config module (the options it passes to
// flight.start(), so the store is defined once) or from a saved report file, and the compare of two saved reports.
// It reads the store and writes nothing. It is part of the CLI, never of the flight entry.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { errorCode } from '../recorder.js';
import { loadManifest, MANIFEST_FILE, serviceOf } from './manifest.js';
import { compareFlightReports, parseFlightReport, renderFlightMarkdown } from './render.js';
import { collectReport, type FlightReport } from './report.js';
import { type FlightStore, isStore } from './store.js';

export const FLIGHT_REPORT_USAGE = `usage:
  reins flight report --config <module> [--json]
  reins flight report <report.json> [--json]
  reins flight report --compare <before.json> <after.json> [--json]

Prints the flight report as Markdown (--json: the report data, with process keys such as payout
ids, which are server-side data: do not paste it where others can read it). With --config, loads the app's
flight config module (its default export, or a function returning it: the options the server
passes to flight.start(), with its store) and reads the store; the manifest is the config's
\`manifest\`, else ${MANIFEST_FILE} in the current folder. With a saved report file (the JSON of
flight.report() or of --json), renders it. --compare lists the findings resolved, new and still
open between two saved reports, by key. A store that cannot be read, or does not answer within
30 s, gives a report that says so. Exits 0 when done, 2 on bad usage or a module or file that
cannot be read.`;

type Print = (s: string) => void;

export interface FlightReportArgs {
  config?: string;
  file?: string;
  compare?: [string, string];
  json: boolean;
  help: boolean;
}

/** Parses `reins flight report` arguments. Throws a plain message on bad usage. */
export function parseFlightReportArgs(argv: string[]): FlightReportArgs {
  const out: FlightReportArgs = { json: false, help: false };
  const args = [...argv];
  const value = (flag: string) => {
    const v = args.shift();
    if (!v || v.startsWith('-')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const files: string[] = [];
  while (args.length) {
    const a = args.shift()!;
    if (a === '--config') out.config = value(a);
    else if (a === '--json') out.json = true;
    else if (a === '--compare') out.compare = [value(a), value(a)];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else files.push(a);
  }
  if (out.help) return out;
  if (files.length > 1) throw new Error(`give one report file, not ${files.length}`);
  if (files.length) out.file = files[0];
  const sources = [out.config, out.file, out.compare].filter((x) => x !== undefined).length;
  if (sources !== 1) throw new Error(sources ? 'give one of --config, a report file or --compare' : 'give --config <module>, a report file or --compare <before.json> <after.json>');
  return out;
}

/**
 * A message of the flight commands' own, printed as it is. Any other error (from the app's config module or its
 * store, which may hold a secret) is printed by its code or name only (`shownError`).
 */
export class FlightCliError extends Error {}

/** What a flight command prints for `e`: its own message, else `what` and the error's code or name. */
export function shownError(e: unknown, what: string): string {
  return e instanceof FlightCliError ? e.message : `${what} (${errorCode(e)})`;
}

/** A saved report file, or a plain message. */
function readReport(file: string): FlightReport {
  if (!existsSync(file) || !statSync(file).isFile()) throw new FlightCliError(`${file} not found`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new FlightCliError(`${file} could not be read (${errorCode(e)})`);
  }
  try {
    return parseFlightReport(text);
  } catch (e: any) {
    throw new FlightCliError(`${file} ${e.message}`);
  }
}

/** What each command does with the store, for the message when the config has none. */
const NO_STORE = {
  report: 'A report reads the store the servers write to (fileStore or pgStore); the memory store lives only in one server, so read it there with flight.report().',
  watch: "A watcher checks the store the servers write to (fileStore or pgStore); the memory store lives only in one server's memory, where a watcher cannot reach it.",
} as const;

/**
 * Loads the app's flight config module (design C14): its default export, a function returning it, or a named
 * `config`, which must hold a store the servers share. `reins flight report` and `reins flight watch` both read
 * it here; `command` words the message when there is no store. Returns the store as read once. Throws a
 * FlightCliError: what the module's own code threw is named by its code only.
 */
export async function loadFlightConfig(module: string, cwd: string, command: keyof typeof NO_STORE = 'report'): Promise<{ file: string; opts: any; store: FlightStore }> {
  const file = resolve(cwd, module);
  if (!existsSync(file) || !statSync(file).isFile()) throw new FlightCliError(`${file} not found`);
  let mod: any;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    throw new FlightCliError(`${file} could not be loaded (${errorCode(e)}${e instanceof SyntaxError ? ': a syntax error, or a module Node cannot run as it is' : ''})`);
  }
  // The default export, or the named `config` (a CommonJS module has a default that is its whole exports object).
  const options = async (v: any) => (typeof v === 'function' ? await v() : v);
  let opts: any;
  try {
    opts = await options(mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod?.config);
    if (!isStore(opts?.store) && mod && typeof mod === 'object' && 'default' in mod && mod.config !== undefined) opts = await options(mod.config);
  } catch (e) {
    throw new FlightCliError(`${file}: its config function threw (${errorCode(e)})`);
  }
  if (!opts || typeof opts !== 'object') throw new FlightCliError(`${file} exports no flight options: export default the object the server passes to flight.start(), or a function that returns it`);
  let store: unknown;
  try {
    store = opts.store;
  } catch (e) {
    throw new FlightCliError(`${file}: its store could not be read (${errorCode(e)})`);
  }
  if (!isStore(store)) throw new FlightCliError(`${file}: its options have no store. ${NO_STORE[command]}`);
  return { file, opts, store };
}

/** Loads the app's config module and makes the report from its store. Throws a FlightCliError. */
async function fromConfig(module: string, cwd: string): Promise<FlightReport> {
  const { file, opts, store } = await loadFlightConfig(module, cwd);
  let manifest;
  try {
    manifest = loadManifest(opts.manifest, cwd);
  } catch {
    manifest = { ok: false as const, problems: [{ path: '(root)', message: 'could not be read' }] };
  }
  let service: string;
  try {
    service = serviceOf(opts.service, manifest);
  } catch (e) {
    throw new FlightCliError(`${file}: its service could not be read (${errorCode(e)})`);
  }
  // A store that cannot be read, or does not answer in time, gives a report that says so.
  return collectReport({ store, manifest, service });
}

/** Runs `reins flight report`. Resolves to the exit code: 0 done, 2 bad usage or input that cannot be read. */
export async function flightReportMain(argv: string[], cwd = process.cwd(), print: Print = (s) => process.stdout.write(s + '\n'), err: Print = (s) => process.stderr.write(s + '\n')): Promise<number> {
  let args: FlightReportArgs;
  try {
    args = parseFlightReportArgs(argv);
  } catch (e: any) {
    err(`reins flight report: ${e.message}\n\n${FLIGHT_REPORT_USAGE}`);
    return 2;
  }
  if (args.help) {
    err(FLIGHT_REPORT_USAGE);
    return 0;
  }
  try {
    if (args.compare) {
      const [a, b] = args.compare.map((f) => readReport(resolve(cwd, f)));
      const c = compareFlightReports(a, b);
      print(args.json ? JSON.stringify({ resolved: c.resolved, new: c.newFindings, still: c.still }, null, 2) : c.markdown);
      return 0;
    }
    const report = args.file ? readReport(resolve(cwd, args.file)) : await fromConfig(args.config!, cwd);
    print(args.json ? JSON.stringify(report, null, 2) : renderFlightMarkdown(report));
    return 0;
  } catch (e: any) {
    err(`reins flight report: ${shownError(e, 'failed')}`);
    return 2;
  }
}
