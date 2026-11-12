import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactDeep } from '@mindmakr/reins';
import { reinsDir } from './token.js';

export interface AuditEntry {
  source: 'agent' | 'page' | 'bridge';
  event: string;
  name?: string;
  args?: unknown;
  ok?: boolean;
  error?: string;
  ms?: number;
  [key: string]: unknown;
}

export type Audit = (entry: AuditEntry) => void;

/** Appends one JSON line per event to `.reins/audit.log` and echoes it to stderr. Arguments are redacted. */
export function fileAudit(projectDir: string, echo: (line: string) => void = (l) => process.stderr.write(l + '\n')): Audit {
  const file = join(reinsDir(projectDir), 'audit.log');
  return (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry, args: entry.args === undefined ? undefined : redactDeep(entry.args) });
    appendFileSync(file, line + '\n');
    echo(`[reins] ${entry.source} ${entry.event}${entry.name ? ' ' + entry.name : ''}${entry.ok === false ? ' failed: ' + entry.error : ''}`);
  };
}
