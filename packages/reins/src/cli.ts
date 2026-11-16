#!/usr/bin/env node
import { resolve } from 'node:path';
import type { Hub } from './bridge/hub.js';

// Each command loads only its own modules: a one-shot command (verify, report, exec, …) does not pay for the MCP SDK
// and the bridge, which took most of a call's start-up time (about 260 ms against 60 ms for node alone).

const err = (m: string) => process.stderr.write(m + '\n');

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'verify') {
    const { main: verifyMain } = await import('./verify.js');
    process.exitCode = verifyMain(argv.slice(1));
    return;
  }
  if (argv[0] === 'report') {
    const { reportMain } = await import('./bridge/report-cli.js');
    process.exitCode = reportMain(argv.slice(1));
    return;
  }
  if (argv[0] === 'exec') {
    const { execMain } = await import('./bridge/oneshot-cli.js');
    process.exitCode = await execMain(argv.slice(1));
    return;
  }
  if (argv[0] === 'scenario') {
    const { scenarioMain } = await import('./bridge/oneshot-cli.js');
    process.exitCode = await scenarioMain(argv.slice(1));
    return;
  }
  if (argv[0] === 'packet') {
    const { packetMain } = await import('./bridge/oneshot-cli.js');
    process.exitCode = await packetMain(argv.slice(1));
    return;
  }
  if (argv[0] === 'fuzz') {
    const { fuzzMain } = await import('./bridge/fuzz-cli.js');
    process.exitCode = await fuzzMain(argv.slice(1));
    return;
  }
  if (argv[0] === 'map') {
    const { mapMain } = await import('./bridge/map-cli.js');
    process.exitCode = await mapMain(argv.slice(1));
    return;
  }
  if (argv[0] === 'flight') {
    const { flightMain } = await import('./flight/check-cli.js');
    const code = await flightMain(argv.slice(1));
    process.exitCode = code;
    // A report or a watcher loads the app's config module, whose store (a database pool) may keep the process
    // alive: exit once what was printed has been written.
    if (argv[1] === 'report' || argv[1] === 'watch') process.stdout.write('', () => process.exit(code));
    return;
  }
  const { parseArgs, portInUse, USAGE } = await import('./bridge/args.js');
  let args;
  try {
    args = parseArgs(argv, process.cwd());
  } catch (e: any) {
    err(`reins: ${e.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.command === 'help') {
    err(USAGE);
    return;
  }
  // Every module the bridge needs, the MCP SDK included, loads before the port opens: a failed import then exits at
  // once, instead of leaving a bound port and no MCP server behind.
  const [{ fileAudit }, { DEFAULT_PORT, Hub }, { tokenPath }, mcp] = await Promise.all([import('./bridge/audit.js'), import('./bridge/hub.js'), import('./bridge/token.js'), args.mcp ? import('./bridge/mcp.js') : null]);
  const dir = resolve(args.dir);
  const audit = fileAudit(dir);
  let hub: Hub;
  try {
    hub = await Hub.start({ dir, port: args.port, cdp: args.cdp, origins: args.origins, rotate: args.rotate, allowNoOrigin: args.allowNoOrigin, audit });
  } catch (e: any) {
    if (e && e.code === 'EADDRINUSE') {
      err(portInUse(args.port ?? DEFAULT_PORT));
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  err(`[reins] bridge on ws://127.0.0.1:${hub.port}`);
  // The token itself is not printed: stderr ends up in the agent host's MCP logs. It is in the file.
  err(`[reins] pairing token written to ${tokenPath(dir)}${args.rotate ? ' (renewed after each pairing)' : ''}`);
  audit({ source: 'bridge', event: 'start', ok: true, port: hub.port });
  if (mcp) await mcp.startMcp({ hub, dir, cdp: args.cdp, audit });
  const stop = async () => {
    audit({ source: 'bridge', event: 'stop', ok: true });
    await hub.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (args.mcp) process.stdin.on('end', stop);
}

main().catch((e) => {
  err(`reins: ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
