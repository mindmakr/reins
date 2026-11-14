// `reins flight watch` (design C5, C14, sections 6 and 8): the same checker as in a server, run beside it from the
// app's config module (the options the server passes to flight.start()), on the same store and to the same sinks.
// It polls the server's health address from that module, opens no port, registers no route and starts no
// process. It is part of the CLI; the checker itself is `flight.watch()` in the flight entry.
import { createFlight } from '../flight.js';
import { loadFlightConfig } from './report-cli.js';

export const FLIGHT_WATCH_USAGE = `usage:
  reins flight watch --config <module>

Runs flight's checker beside the server, from the app's flight config module (its default export, or a
function returning it: the options the server passes to flight.start(), with its store, sinks and
healthUrl). It checks the store each period (the config's checkEveryMs, default 60 s), tells the sinks,
and polls healthUrl, keeping a basic finding open while the server does not answer it with a 2xx status.
While it runs it holds the store's checker lock, so the servers' own checkers stand down; when it stops
(Ctrl+C or SIGTERM) it gives the lock back and a server checker takes over. The manifest is the config's
\`manifest\`, else reins.flight.json in the current folder. It opens no port and reports only. Exits 0 when
stopped, 2 on bad usage or a module that cannot be loaded or cannot start a watcher.`;

type Print = (s: string) => void;

/** Parses `reins flight watch` arguments. Throws a plain message on bad usage. */
export function parseFlightWatchArgs(argv: string[]): { config?: string; help: boolean } {
  const out: { config?: string; help: boolean } = { help: false };
  const args = [...argv];
  while (args.length) {
    const a = args.shift()!;
    if (a === '--config') {
      const v = args.shift();
      if (!v || v.startsWith('-')) throw new Error('--config needs a value');
      out.config = v;
    } else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else throw new Error(`unexpected ${a}`);
  }
  if (!out.help && !out.config) throw new Error('give --config <module>');
  return out;
}

/** Until SIGINT or SIGTERM. */
function signalled(): Promise<string> {
  return new Promise((resolve) => {
    const on = (s: string) => () => {
      process.off('SIGINT', int);
      process.off('SIGTERM', term);
      resolve(s);
    };
    const int = on('SIGINT');
    const term = on('SIGTERM');
    process.once('SIGINT', int);
    process.once('SIGTERM', term);
  });
}

/** The health address as printed: scheme, host and path, never user info or a query. */
function shown(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(not a URL)';
  }
}

/**
 * Runs `reins flight watch`. Resolves to the exit code when the watcher stops (on SIGINT or SIGTERM, or when `until`
 * settles): 0 stopped, 2 bad usage, or a module that cannot be loaded or cannot start a watcher.
 */
export async function flightWatchMain(
  argv: string[],
  cwd = process.cwd(),
  print: Print = (s) => process.stdout.write(s + '\n'),
  err: Print = (s) => process.stderr.write(s + '\n'),
  until?: Promise<unknown>,
): Promise<number> {
  let config: string;
  try {
    const args = parseFlightWatchArgs(argv);
    if (args.help) {
      err(FLIGHT_WATCH_USAGE);
      return 0;
    }
    config = args.config!;
  } catch (e: any) {
    err(`reins flight watch: ${e.message}\n\n${FLIGHT_WATCH_USAGE}`);
    return 2;
  }
  let file: string;
  let opts: any;
  try {
    ({ file, opts } = await loadFlightConfig(config, cwd, 'A watcher checks'));
  } catch (e: any) {
    err(`reins flight watch: ${e && e.message ? e.message : 'the config module could not be loaded'}`);
    return 2;
  }
  const f = createFlight();
  let started: boolean;
  try {
    started = f.watch(opts, cwd);
  } catch (e: any) {
    // Only `strict: true` with an invalid manifest throws.
    err(`reins flight watch: ${e && e.message ? e.message : 'the watcher could not start'}`);
    return 2;
  }
  if (!started) {
    err(`reins flight watch: ${file}: its options cannot start a watcher: check healthUrl (an http or https URL) and instance (letters, digits, ".", "_" and "-").`);
    return 2;
  }
  const every = typeof opts.checkEveryMs === 'number' && opts.checkEveryMs >= 0 ? opts.checkEveryMs : 60_000;
  print(
    `reins flight watch: watching from ${file}, a pass ${every > 0 ? `every ${Math.round(every / 100) / 10} s` : 'once (checkEveryMs is 0)'}; ` +
      (typeof opts.healthUrl === 'string' ? `health address ${shown(opts.healthUrl)}.` : 'no health address (give healthUrl in the config to check that the server answers).'),
  );
  // The checker's timer does not hold the process open (a server's must not): this does, until the watcher stops.
  const keep = setInterval(() => {}, 1 << 30);
  await (until ?? signalled()).catch(() => {});
  clearInterval(keep);
  f.stop();
  await f.closed();
  print('reins flight watch: stopped; the store lock is given back.');
  return 0;
}
