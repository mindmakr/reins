// `reins flight <command>`. This version has `check` and `report`; `watch` comes later.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { MANIFEST_FILE, readManifest } from './manifest.js';
import { flightReportMain } from './report-cli.js';

export const FLIGHT_USAGE = `usage:
  reins flight check [file]
  reins flight report --config <module> | <report.json> | --compare <before.json> <after.json> [--json]

Checks a flight manifest (default: ${MANIFEST_FILE} in the current folder) and lists every
problem with its path in the file. Needs no running server. Exits 0 when the manifest is valid,
1 when it has problems, 2 on bad usage or a missing file.

Prints the flight report from the app's config module or a saved report, or compares two saved
reports (reins flight report --help).`;

type Print = (s: string) => void;
const stdout: Print = (s) => process.stdout.write(s + '\n');
const stderr: Print = (s) => process.stderr.write(s + '\n');

/** Runs `reins flight check [file]`. Returns the exit code: 0 valid, 1 problems, 2 bad usage or no file. */
export function flightCheckMain(argv: string[], cwd = process.cwd(), print: Print = stdout, err: Print = stderr): number {
  const files: string[] = [];
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      err(FLIGHT_USAGE);
      return 0;
    }
    if (a.startsWith('-')) {
      err(`reins flight check: unknown option ${a}\n\n${FLIGHT_USAGE}`);
      return 2;
    }
    files.push(a);
  }
  if (files.length > 1) {
    err(`reins flight check: give one file, not ${files.length}\n\n${FLIGHT_USAGE}`);
    return 2;
  }
  const file = resolve(cwd, files[0] ?? MANIFEST_FILE);
  if (!existsSync(file) || !statSync(file).isFile()) {
    err(`reins flight check: ${file} not found${files.length ? '' : ` (pass a path, or add ${MANIFEST_FILE} to the project root)`}`);
    return 2;
  }
  const result = readManifest(file);
  if (!result.ok) {
    const n = result.problems.length;
    print(`reins flight check: ${file} has ${n} problem${n === 1 ? '' : 's'}:`);
    for (const p of result.problems) print(`  ${p.path}: ${p.message}`);
    return 1;
  }
  const m = result.manifest;
  const promises = m.processes.reduce((sum, p) => sum + p.promises.length, 0);
  print(`reins flight check: ${file} is valid (${m.processes.length} process${m.processes.length === 1 ? '' : 'es'}, ${promises} promise${promises === 1 ? '' : 's'}, ${m.probes.length} probe${m.probes.length === 1 ? '' : 's'})`);
  return 0;
}

/** Runs `reins flight <command>`. Returns the exit code; `report` resolves to it. */
export function flightMain(argv: string[], cwd = process.cwd(), print: Print = stdout, err: Print = stderr): number | Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'check') return flightCheckMain(rest, cwd, print, err);
  if (cmd === 'report') return flightReportMain(rest, cwd, print, err);
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    err(FLIGHT_USAGE);
    return cmd === undefined ? 2 : 0;
  }
  err(`reins flight: unknown command ${cmd}\n\n${FLIGHT_USAGE}`);
  return 2;
}
