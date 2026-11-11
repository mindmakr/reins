import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { VERSION } from 'reins';
import { buildSession, mergeServers, renderMarkdown, sessionBase, type AuditLine, type SessionData } from 'reins/report';
import type { ServerReport } from 'reins';
import type { Hub } from './hub.js';
import type { ToolContext } from './tools.js';
import { reinsDir } from './token.js';

/** Asks every paired `reins/node` server for its report. Servers that do not answer are skipped. */
export async function serverReports(hub: Hub): Promise<ServerReport[]> {
  const all = await Promise.all(hub.nodeClients().map((c) => hub.request('server', {}, c).catch(() => null)));
  return all.filter(Boolean) as ServerReport[];
}

/** How much of the end of the audit log a report reads. The log is never trimmed, so it can be far larger. */
export const AUDIT_TAIL_BYTES = 1024 * 1024;

/** The last `maxBytes` of a file as text. A first line cut in half fails to parse and is skipped by the caller. */
function readTail(file: string, maxBytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Audit log lines written since `since` (ms), oldest first. Missing log: none. Reads only the end of the file. */
export function readAudit(projectDir: string, since: number, max = 500, tailBytes = AUDIT_TAIL_BYTES): AuditLine[] {
  const file = join(projectDir, '.reins', 'audit.log');
  if (!existsSync(file)) return [];
  const out: AuditLine[] = [];
  for (const line of readTail(file, tailBytes).split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (Date.parse(e.at) >= since - 1000) out.push({ at: e.at, source: e.source, event: e.event, name: e.name, via: e.via, ok: e.ok, error: e.error, ms: e.ms });
    } catch {
      // skip a torn line
    }
  }
  return out.slice(-max);
}

const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** Gathers a session from the paired app and servers: everything `reins_report` puts in the files. */
export async function gatherSession(ctx: ToolContext, title?: string): Promise<SessionData> {
  const hub = ctx.hub;
  const c = hub.current();
  const server = mergeServers(await serverReports(hub));
  if (!c && !server) throw new Error('No app is paired. Open the app in dev mode (it must call reins.connect()) and make sure the dev server serves .reins/token.');
  let list: any = null;
  let state: any = null;
  let network: any = null;
  let errors: any = null;
  let perf: any = null;
  const dom: Record<string, any> = {};
  if (c) {
    [list, state, network, errors, perf] = await Promise.all([
      safe(hub.request('list')),
      safe(hub.request('state')),
      safe(hub.request('network', { limit: 100 })),
      safe(hub.request('errors', { limit: 100 })),
      safe(hub.request('perf')),
    ]);
    for (const id of Array.isArray(list?.panels) ? list.panels : []) dom[id] = await safe(hub.request('dom', { panel: id, depth: 8, maxNodes: 400 }));
  }
  return buildSession({
    title: title || (c?.title ? `${c.title}` : 'session'),
    source: 'bridge',
    reinsVersion: VERSION,
    app: c ? { url: c.url, title: c.title, platform: c.meta?.platform || 'web', meta: c.meta } : { platform: 'node' },
    actions: [...(list?.actions || []), ...(server?.actions || [])],
    state,
    network: network || [],
    errors: errors || [],
    perf,
    dom,
    server,
    snaps: ctx.snaps || [],
    audit: readAudit(ctx.dir, hub.startedAt),
  });
}

/** Snap links relative to where the Markdown file lives. */
export const linkFrom = (projectDir: string, mdFile: string) => (p: string) => relative(dirname(mdFile), resolve(projectDir, p)).split('\\').join('/');

/** Writes `.reins/sessions/<time>-<slug>.json` and `.md`. Returns the paths and the Markdown. */
export function writeSession(projectDir: string, session: SessionData): { md: string; json: string; markdown: string } {
  const folder = join(reinsDir(projectDir), 'sessions');
  mkdirSync(folder, { recursive: true });
  const base = join(folder, sessionBase(session.createdAt, session.title));
  const md = base + '.md';
  const json = base + '.json';
  const markdown = renderMarkdown(session, { link: linkFrom(projectDir, md) });
  writeFileSync(json, JSON.stringify(session, null, 2) + '\n');
  writeFileSync(md, markdown);
  return { md, json, markdown };
}

/** Reads a session JSON and checks its schema version. */
export function readSession(file: string): SessionData {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  if (!s || s.schemaVersion !== 1) throw new Error(`${file} is not a reins session (schemaVersion 1)`);
  return s;
}

/** The newest session JSON under `<projectDir>/.reins/sessions`, if any. */
export function latestSession(projectDir: string): string | undefined {
  const folder = join(projectDir, '.reins', 'sessions');
  if (!existsSync(folder)) return undefined;
  const files = readdirSync(folder).filter((f) => f.endsWith('.json')).sort();
  return files.length ? join(folder, files[files.length - 1]) : undefined;
}
