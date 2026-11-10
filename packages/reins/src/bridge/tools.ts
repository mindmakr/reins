import { relative } from 'node:path';
import { findings, mergeServers, renderMarkdown, withTimeline } from 'reins/report';
import type { Audit } from './audit.js';
import type { Client, Hub } from './hub.js';
import { gatherSession, serverReports, writeSession } from './session.js';
import { snap } from './snap.js';

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required });

export const TOOLS: Tool[] = [
  {
    name: 'reins_list_actions',
    description: 'List the actions (with input schemas), state sources and panels the paired app registered, plus the actions of any paired reins/node server. Call this first.',
    inputSchema: obj(),
  },
  {
    name: 'reins_run_action',
    description:
      'Run a registered action by name (app or server). Actions marked consequential are refused unless confirm is true; ask the person before confirming. Use target to pick "app" or "server" when both have the name.',
    inputSchema: obj({ name: { type: 'string' }, input: { type: 'object' }, confirm: { type: 'boolean' }, target: { type: 'string', enum: ['app', 'server'] } }, ['name']),
  },
  {
    name: 'reins_state',
    description: 'Read a redacted snapshot of the app state: one source by name, or all of them.',
    inputSchema: obj({ name: { type: 'string' } }),
  },
  {
    name: 'reins_network',
    description: 'Recent fetch calls: method, url, status, ms, startMs, trace id, redacted headers and bodies.',
    inputSchema: obj({ limit: { type: 'number' }, url: { type: 'string', description: 'Only calls whose URL contains this' } }),
  },
  {
    name: 'reins_errors',
    description: 'Recent console errors, uncaught errors and unhandled promise rejections.',
    inputSchema: obj({ limit: { type: 'number' } }),
  },
  {
    name: 'reins_panel_box',
    description: 'Bounding box of a panel (data-reins attribute or registered RN panel) in CSS pixels, with devicePixelRatio.',
    inputSchema: obj({ id: { type: 'string' }, scroll: { type: 'boolean', description: 'Scroll it into view first' } }, ['id']),
  },
  {
    name: 'reins_snap',
    description: 'Pixel-exact picture of a panel, saved under .reins/snaps. Uses Playwright over CDP (bridge --cdp) or adb for Android; otherwise returns the box.',
    inputSchema: obj({ id: { type: 'string' }, copy: { type: 'boolean', description: 'Also copy the image to the clipboard' } }, ['id']),
  },
  {
    name: 'reins_perf',
    description:
      'Page lifecycle timings (TTFB, FCP, DOM interactive, load), component/panel mount times and render counts, API call latency stats, and a unified millisecond timeline. With a paired reins/node server it adds a server section and the server half of each API call (kind "server", with db time and spans), joined by trace id.',
    inputSchema: obj(),
  },
  {
    name: 'reins_dom',
    description: "Inspect a panel or CSS selector's DOM subtree, bounding boxes, computed CSS styles, and automatic layout issue flags (horizontal-clip, vertical-clip, zero-size).",
    inputSchema: obj({
      panel: { type: 'string', description: 'Panel id (data-reins attribute) to inspect' },
      selector: { type: 'string', description: 'CSS selector inside the panel (or document if no panel)' },
      depth: { type: 'number', description: 'Max child tree depth (default 3)' },
      maxNodes: { type: 'number', description: 'Max elements to return (default 40)' },
    }),
  },
  {
    name: 'reins_server',
    description:
      'The server side (needs reins/node in the dev server): recent requests with their spans (db.* time) and outbound fetches, trace ids that match reins_network, the slowest routes, and runtime stats (event-loop delay p50/p99/max, memory). Call it when an API call is slow or fails.',
    inputSchema: obj({
      limit: { type: 'number', description: 'Requests to return, newest last (default 50)' },
      route: { type: 'string', description: 'Only requests whose route or URL contains this' },
    }),
  },
  {
    name: 'reins_report',
    description:
      'Gather everything into one session report: actions, redacted state, network, errors, perf with the server joined, layout issues per panel, snaps and actions run this session, with plain-language findings (slow or failed calls, duplicate calls, N+1-looking server spans, re-renders, layout issues). Saves .reins/sessions/<time>-<slug>.md and .json unless save is false. Returns the Markdown, the file paths and the findings.',
    inputSchema: obj({
      title: { type: 'string', description: 'Short name, e.g. "checkout before fix"' },
      save: { type: 'boolean', description: 'Write the files (default true)' },
    }),
  },
];

const METHODS: Record<string, string> = {
  reins_state: 'state',
  reins_network: 'network',
  reins_errors: 'errors',
  reins_panel_box: 'panel',
  reins_dom: 'dom',
};

export interface ToolContext {
  hub: Hub;
  dir: string;
  cdp?: string;
  audit?: Audit;
  /** Project-relative paths of the snaps taken this session (filled in by reins_snap). */
  snaps?: string[];
}

const hasAction = (l: any, name: string) => Array.isArray(l?.actions) && l.actions.some((a: any) => a && a.name === name);

/** Which client runs an action: the page or app, unless only a paired server has it (or `target` says so). */
async function actionTarget(hub: Hub, name: string, target?: string): Promise<Client | undefined> {
  const nodes = hub.nodeClients();
  if (!nodes.length || target === 'app') return undefined;
  if (target !== 'server' && hub.current() && hasAction(await hub.request('list').catch(() => null), name)) return undefined;
  for (const c of nodes) if (hasAction(await hub.request('list', {}, c).catch(() => null), name)) return c;
  if (target === 'server') throw new Error(`no paired server has an action "${name}"`);
  return undefined;
}

async function listAll(hub: Hub): Promise<unknown> {
  const c = hub.current();
  const nodes = hub.nodeClients();
  const app = c || !nodes.length ? await hub.request('list') : { actions: [], states: [], panels: [] };
  const out: any = { app: c && { url: c.url, title: c.title, meta: c.meta }, ...app };
  if (nodes.length)
    out.servers = await Promise.all(
      nodes.map(async (n) => ({ client: n.id, title: n.title, meta: n.meta, actions: ((await hub.request('list', {}, n).catch(() => null)) as any)?.actions || [] })),
    );
  return out;
}

async function perfJoined(hub: Hub): Promise<unknown> {
  const perf = await hub.request('perf');
  const server = mergeServers(await serverReports(hub));
  const out: any = withTimeline(perf, server?.requests);
  if (server) out.server = { requests: server.requests.length, slowest: server.slowest.slice(0, 5), runtime: server.runtime };
  return out;
}

async function serverTool(hub: Hub, args: Record<string, any>): Promise<unknown> {
  if (!hub.nodeClients().length) throw new Error('No server is paired. In the dev server, call reinsNode.connect() from reins/node (dev only) and add reinsNode.middleware().');
  const server = mergeServers(await serverReports(hub));
  if (!server) throw new Error('the paired server did not answer');
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50;
  const route = typeof args.route === 'string' ? args.route : '';
  return { ...server, requests: server.requests.filter((r) => !route || r.route.includes(route) || r.url.includes(route)).slice(-limit) };
}

/** Runs one MCP tool against the paired app (and server). Every call is audited. */
export async function callTool(ctx: ToolContext, name: string, args: Record<string, any> = {}): Promise<unknown> {
  const started = Date.now();
  const entry = {
    source: 'agent' as const,
    event: name,
    name: args.name ?? args.id ?? args.panel ?? args.selector ?? args.title ?? args.route,
    args: name === 'reins_run_action' ? args.input : undefined,
  };
  try {
    let result: unknown;
    if (name === 'reins_snap') {
      const box = await ctx.hub.request('panel', { id: args.id, scroll: true });
      if (!box) throw new Error(`no panel "${args.id}"`);
      const shot = await snap(box, ctx.hub.current(), { dir: ctx.dir, cdp: ctx.cdp, copy: args.copy === true });
      if (shot.file) (ctx.snaps ??= []).push(relative(ctx.dir, shot.file).split('\\').join('/'));
      result = shot;
    } else if (name === 'reins_list_actions') {
      result = await listAll(ctx.hub);
    } else if (name === 'reins_run_action') {
      const target = await actionTarget(ctx.hub, args.name, args.target);
      result = await ctx.hub.request('run', { name: args.name, input: args.input, confirm: args.confirm === true }, target);
    } else if (name === 'reins_perf') {
      result = await perfJoined(ctx.hub);
    } else if (name === 'reins_server') {
      result = await serverTool(ctx.hub, args);
    } else if (name === 'reins_report') {
      const session = await gatherSession(ctx, typeof args.title === 'string' ? args.title : undefined);
      const files = args.save === false ? null : writeSession(ctx.dir, session);
      result = { markdown: files ? files.markdown : renderMarkdown(session), files: files && { md: files.md, json: files.json }, findings: findings(session) };
    } else if (METHODS[name]) {
      result = await ctx.hub.request(METHODS[name], args);
    } else {
      throw new Error(`unknown tool "${name}"`);
    }
    ctx.audit?.({ ...entry, ok: true, ms: Date.now() - started });
    return result;
  } catch (err: any) {
    ctx.audit?.({ ...entry, ok: false, error: err.message, ms: Date.now() - started });
    throw err;
  }
}
