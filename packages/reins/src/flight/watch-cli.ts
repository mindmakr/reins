// `reins flight watch` (design C5, C14, sections 6 and 8): the same checker as in a server, run beside it from the
// app's config module (the options the server passes to flight.start()), on the same store and to the same sinks.
// It polls the server's health address from that module, opens no port, registers no route and starts no
// process. It is part of the CLI; the checker itself is `flight.watch()` in the flight entry.
import { createFlight } from '../flight.js';
import { errorCode } from '../recorder.js';
import { loadFlightConfig, shownError } from './report-cli.js';

/** How long the watcher waits, once stopped, for its pass on its way, the store lock and its sinks, before it exits. */
export const STOP_WAIT_MS = 10_000;

export const FLIGHT_WATCH_USAGE = `usage:
  reins flight watch --config <module>

Runs flight's checker beside the server, from the app's flight config module (its default export, or a
function returning it: the options the server passes to flight.start(), with its store, sinks and
healthUrl). It checks the store each period (the config's checkEveryMs, default 60 s), tells the sinks,
and polls healthUrl, keeping a basic finding open while the server does not answer it with a 2xx status.
It checks while it holds the store's checker lock, and the servers' own checkers stand down meanwhile;
while a server holds the lock, the watcher waits and takes over once that server stops renewing it.
When it stops (Ctrl+C or SIGTERM) it gives the lock back and a server checker takes over; it waits at
most ${STOP_WAIT_MS / 1000} s for that, and a second Ctrl+C or SIGTERM exits at once. The manifest is the config's
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

/** The next SIGINT or SIGTERM, with `off` to stop listening for it. */
function signalled(): { next: Promise<string>; off: () => void } {
  let off = () => {};
  const next = new Promise<string>((resolve) => {
    const on = (s: string) => () => {
      off();
      resolve(s);
    };
    const int = on('SIGINT');
    const term = on('SIGTERM');
    off = () => {
      process.off('SIGINT', int);
      process.off('SIGTERM', term);
    };
    process.once('SIGINT', int);
    process.once('SIGTERM', term);
  });
  return { next, off };
}

/** The health address as printed: its origin (scheme, host and port), never a path, user info or a query. */
function shown(url: unknown): string {
  try {
    return new URL(String(url)).origin;
  } catch {
    return '(not a URL)';
  }
}

/** The start line, from options that may hold getters; never throws. */
function startLine(file: string, opts: any): string {
  try {
    const every = typeof opts.checkEveryMs === 'number' && opts.checkEveryMs >= 0 ? opts.checkEveryMs : 60_000;
    const health = opts.healthUrl;
    return (
      `reins flight watch: watching from ${file}, a pass ${every > 0 ? `every ${Math.round(every / 100) / 10} s` : 'once (checkEveryMs is 0)'}; ` +
      (typeof health === 'string' ? `health address ${shown(health)}.` : 'no health address (give healthUrl in the config to check that the server answers).')
    );
  } catch (e) {
    return `reins flight watch: watching from ${file}; its options could not all be read (${errorCode(e)}).`;
  }
}

/** The lock's lease for the config's period, in minutes, for the stop line: three periods, at least three minutes. */
function leaseMinutes(opts: any): number {
  try {
    const every = typeof opts.checkEveryMs === 'number' && opts.checkEveryMs >= 0 ? opts.checkEveryMs : 60_000;
    return Math.ceil((3 * Math.max(every, 60_000)) / 60_000);
  } catch {
    return 3;
  }
}

/**
 * Runs `reins flight watch`. Resolves to the exit code when the watcher stops (on SIGINT or SIGTERM, or when `until`
 * settles): 0 stopped, 2 bad usage, or a module that cannot be loaded or cannot start a watcher. Once stopped it
 * waits at most `stopWaitMs` for the store to take the lock back, or until a second SIGINT or SIGTERM.
 */
export async function flightWatchMain(
  argv: string[],
  cwd = process.cwd(),
  print: Print = (s) => process.stdout.write(s + '\n'),
  err: Print = (s) => process.stderr.write(s + '\n'),
  until?: Promise<unknown>,
  stopWaitMs = STOP_WAIT_MS,
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
    ({ file, opts } = await loadFlightConfig(config, cwd, 'watch'));
  } catch (e) {
    err(`reins flight watch: ${shownError(e, 'the config module could not be loaded')}`);
    return 2;
  }
  const f = createFlight();
  let started: boolean;
  try {
    started = f.watch(opts, cwd);
  } catch (e: any) {
    // Only `strict: true` with an invalid manifest throws, with a message of flight's own about the manifest.
    const own = e instanceof Error && e.message.startsWith('reins flight: the manifest is invalid');
    err(`reins flight watch: ${own ? e.message : `the watcher could not start (${errorCode(e)})`}`);
    return 2;
  }
  if (!started) {
    err(
      `reins flight watch: ${file}: its options cannot start a watcher: check store, healthUrl (an http or https URL with no user or password, on a port fetch may use) and instance (letters, digits, ".", "_" and "-").`,
    );
    return 2;
  }
  print(startLine(file, opts));
  // The checker's timer does not hold the process open (a server's must not): this does, until the watcher stops.
  const keep = setInterval(() => {}, 1 << 30);
  const first = signalled();
  await (until ?? first.next).catch(() => {});
  first.off();
  clearInterval(keep);
  f.stop();
  // The pass on its way, the lock given back and the sinks: bounded, and a second signal ends the wait at once.
  const second = signalled();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const given = await Promise.race([
    f.closed(),
    new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), stopWaitMs))),
    second.next.then(() => false as const),
  ]);
  clearTimeout(timer);
  second.off();
  print(
    given
      ? 'reins flight watch: stopped; the store lock is given back.'
      : `reins flight watch: stopped; the store did not confirm the lock was given back, so a server checker takes over when its lease runs out (within ${leaseMinutes(opts)} min).`,
  );
  return 0;
}
