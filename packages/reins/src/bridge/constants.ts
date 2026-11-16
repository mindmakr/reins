// The bridge's address, in a module with no imports: the one-shot commands (exec, scenario, packet, fuzz, map) need
// these two values and must not load the bridge itself (hub.ts, ws's server, the tools) to get them.

export const DEFAULT_PORT = 7357;
/** The bridge listens on loopback only. There is no option to change this. */
export const HOST = '127.0.0.1';
