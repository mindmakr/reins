#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs, portInUse, USAGE } from './bridge/args.js';
import { fileAudit } from './bridge/audit.js';
import { DEFAULT_PORT, Hub } from './bridge/hub.js';
import { startMcp } from './bridge/mcp.js';
import { reportMain } from './bridge/report-cli.js';
import { flightMain } from './flight/check-cli.js';
import { tokenPath } from './bridge/token.js';
import { main as verifyMain } from './verify.js';

const err = (m: string) => process.stderr.write(m + '\n');

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'verify') {
    process.exitCode = verifyMain(argv.slice(1));
    return;
  }
  if (argv[0] === 'report') {
    process.exitCode = reportMain(argv.slice(1));
    return;
  }
  if (argv[0] === 'flight') {
    const code = await flightMain(argv.slice(1));
    process.exitCode = code;
    // A report loads the app's config module, whose store (a database pool) may keep the process alive: exit
    // once what was printed has been written.
    if (argv[1] === 'report') process.stdout.write('', () => process.exit(code));
    return;
  }
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
  const dir = resolve(args.dir);
  const audit = fileAudit(dir);
  let hub: Hub;
  try {
    hub = await Hub.start({ dir, port: args.port, origins: args.origins, rotate: args.rotate, allowNoOrigin: args.allowNoOrigin, audit });
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
  if (args.mcp) await startMcp({ hub, dir, cdp: args.cdp, audit });
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
