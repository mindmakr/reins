import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { compareSessions, renderMarkdown } from '@mindmakr/reins/report';
import { latestSession, linkFrom, readSession } from './session.js';

export const REPORT_USAGE = `usage:
  reins report [--from <session.json>] [--out <dir|file.md>]
  reins report --compare <before.json> <after.json> [--out <dir|file.md>]

Re-renders a saved session (default: the newest in .reins/sessions) as Markdown, or prints a
before/after table of two sessions. Prints to stdout; --out also writes the file.`;

export interface ReportArgs {
  from?: string;
  compare?: [string, string];
  out?: string;
  help?: boolean;
}

/** Parses `reins report` arguments. Throws on unknown flags. */
export function parseReportArgs(argv: string[]): ReportArgs {
  const out: ReportArgs = {};
  const args = [...argv];
  const value = (flag: string) => {
    const v = args.shift();
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  while (args.length) {
    const a = args.shift()!;
    if (a === '--from') out.from = value(a);
    else if (a === '--out') out.out = value(a);
    else if (a === '--compare') out.compare = [value(a), value(a)];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

/** Where `--out` writes: a `.md` path as is, otherwise `<dir>/<name>`. */
export const outFile = (out: string, cwd: string, name: string) => (out.endsWith('.md') ? resolve(cwd, out) : join(resolve(cwd, out), name));

/** Runs `reins report`. Returns the exit code: 0 done, 2 bad usage or unreadable input. */
export function reportMain(argv: string[], cwd = process.cwd(), print = (s: string) => process.stdout.write(s + '\n'), err = (s: string) => process.stderr.write(s + '\n')): number {
  let args: ReportArgs;
  try {
    args = parseReportArgs(argv);
  } catch (e: any) {
    err(`reins report: ${e.message}\n\n${REPORT_USAGE}`);
    return 2;
  }
  if (args.help) {
    err(REPORT_USAGE);
    return 0;
  }
  try {
    let markdown: string;
    let file: string | undefined;
    if (args.compare) {
      const [a, b] = args.compare.map((f) => readSession(resolve(cwd, f)));
      markdown = compareSessions(a, b).markdown;
      if (args.out) file = outFile(args.out, cwd, 'compare.md');
    } else {
      const from = args.from ? resolve(cwd, args.from) : latestSession(cwd);
      if (!from) throw new Error('no session found: run reins_report first, or pass --from <session.json>');
      const session = readSession(from);
      if (args.out) file = outFile(args.out, cwd, basename(from).replace(/\.json$/, '') + '.md');
      markdown = renderMarkdown(session, file ? { link: linkFrom(cwd, file) } : {});
    }
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, markdown);
      err(`reins report: wrote ${file}`);
    }
    print(markdown);
    return 0;
  } catch (e: any) {
    err(`reins report: ${e.message}`);
    return 2;
  }
}
