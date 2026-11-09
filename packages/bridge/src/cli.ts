#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs, USAGE } from './args.js';
import { fileAudit } from './audit.js';
import { Hub } from './hub.js';
import { startMcp } from './mcp.js';
import { tokenPath } from './token.js';

const err = (m: string) => process.stderr.write(m + '\n');

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), process.cwd());
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
