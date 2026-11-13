// @mindmakr/reins/flight: the production-safe, report-only part of reins. Node only.
// It records, checks and reports; it has no actions, no pairing, no bridge client, no token handling and no
// DOM or state reading, and it opens no port (design section 7). Importing it does nothing: `flight.start()`
// is the opt-in. It records through the strict recorder shared with @mindmakr/reins/node (design C13, C16).
// Imports: Node built-ins and reins' shared modules only. Never import ./node.js, ./index.js or ./bridge here.
import {
  createStrictRecorder,
  type DevInstruments,
  devInstruments,
  fastify,
  middleware,
  notCheckedFacts,
  span,
  type StrictOptions,
  type StrictRecorder,
  wrapHandler,
} from './recorder.js';

export const VERSION = '0.1.0';

export type FlightOptions = StrictOptions;
export type { DevInstruments, MinuteSummary, StrictCall, StrictRequest, StrictSpan, StrictStats } from './recorder.js';

/** Creates an instance. Apps use the `flight` singleton; this is for tests. */
export function createFlight(env: Record<string, string | undefined> = process.env) {
  let rec: StrictRecorder | null = null;

  return {
    /**
     * Starts the strict recorder. Never throws: on a bad option it records nothing and returns false.
     * Calling it again while started does nothing and returns true.
     */
    start(o: FlightOptions = {}): boolean {
      if (rec) return true;
      try {
        const r = createStrictRecorder(o || {});
        r.start();
        rec = r;
        return true;
      } catch {
        return false;
      }
    },
    stop(): void {
      try {
        rec?.stop();
      } catch {}
      rec = null;
    },
    isStarted: () => !!rec,
    /** Express/Connect middleware. The same hook as `reinsNode.middleware()`; install one of them, once. */
    middleware: () => middleware(),
    /** Wraps a plain `(req, res)` handler. */
    wrapHandler: <H extends (req: any, res: any, ...rest: any[]) => any>(handler: H): H => wrapHandler(handler),
    /** Fastify hooks. */
    fastify,
    /** Times `fn` as a span of the current request. Returns what `fn` returns; flight never changes it. */
    span,
    /** Whether development reins is loaded or recording in this process, and whether it is production (design C12). */
    devInstruments: (): DevInstruments => devInstruments(env),
    /** Facts this Node version cannot check, for reports to carry as "not checked". */
    notChecked: (): string[] => notCheckedFacts(),
    /** Internal, for the checker, store and report: the started recorder, or null. */
    recorder: (): StrictRecorder | null => rec,
  };
}

export type Flight = ReturnType<typeof createFlight>;

export const flight = createFlight();
export default flight;
