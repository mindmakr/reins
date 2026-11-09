#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs, USAGE } from './bridge/args.js';
import { fileAudit } from './bridge/audit.js';
import { Hub } from './bridge/hub.js';
import { startMcp } from './bridge/mcp.js';
import { tokenPath } from './bridge/token.js';
import { main as verifyMain } from './verify.js';

const err = (m: string) => process.stderr.write(m + '\n');

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'verify') {
    process.exitCode = verifyMain(argv.slice(1));
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
  const hub = await Hub.start({ dir, port: args.port, origins: args.origins, rotate: args.rotate, allowNoOrigin: args.allowNoOrigin, audit });
  err(`[reins] bridge on ws://127.0.0.1:${hub.port}`);
  err(`[reins] pairing token written to ${tokenPath(dir)}${args.rotate ? ' (renewed after each pairing)' : ''}`);
  err(`[reins] token: ${hub.token}`);
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
