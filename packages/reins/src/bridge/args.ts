export interface BridgeArgs {
  command: 'bridge' | 'help';
  port?: number;
  dir: string;
  origins: string[];
  cdp?: string;
  rotate: boolean;
  mcp: boolean;
  allowNoOrigin: boolean;
}

export const USAGE = `usage:
  reins bridge [options]
  reins verify <dir> [<dir>...]
  reins report [--from <session.json>] [--compare <before.json> <after.json>] [--out <dir|file.md>]

Starts the reins bridge on 127.0.0.1 and an MCP server on stdio, checks a production bundle for reins dev code, or renders saved session reports.

  --port <n>         WebSocket port (default 7357)
  --dir <path>       project folder for .reins/ (default: current folder)
  --origin <origin>  also allow this exact page origin (repeatable); localhost is always allowed
  --cdp <url>        Chrome DevTools endpoint for reins_snap, e.g. http://127.0.0.1:9222
  --no-rotate        keep the same token after a page pairs
  --no-mcp           do not start the MCP server (WebSocket only)
  --browser-only     refuse clients without an Origin header (no React Native)
`;

/** Parses `reins` arguments. Throws on unknown flags. */
export function parseArgs(argv: string[], cwd: string): BridgeArgs {
  const out: BridgeArgs = { command: 'help', dir: cwd, origins: [], rotate: true, mcp: true, allowNoOrigin: true };
  const args = [...argv];
  const cmd = args.shift();
  if (cmd !== 'bridge') return out;
  out.command = 'bridge';
  const value = (flag: string) => {
    const v = args.shift();
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  while (args.length) {
    const a = args.shift()!;
    if (a === '--port') {
      const n = Number(value(a));
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--port must be 0-65535');
      out.port = n;
    } else if (a === '--dir') out.dir = value(a);
    else if (a === '--origin') out.origins.push(value(a));
    else if (a === '--cdp') out.cdp = value(a);
    else if (a === '--no-rotate') out.rotate = false;
    else if (a === '--no-mcp') out.mcp = false;
    else if (a === '--browser-only') out.allowNoOrigin = false;
    else if (a === '--help' || a === '-h') out.command = 'help';
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}
