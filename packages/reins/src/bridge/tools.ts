import type { Audit } from './audit.js';
import type { Hub } from './hub.js';
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
    description: 'List the actions (with input schemas), state sources and panels the paired app registered. Call this first.',
    inputSchema: obj(),
  },
  {
    name: 'reins_run_action',
    description: 'Run a registered action by name. Actions marked consequential are refused unless confirm is true; ask the person before confirming.',
    inputSchema: obj({ name: { type: 'string' }, input: { type: 'object' }, confirm: { type: 'boolean' } }, ['name']),
  },
  {
    name: 'reins_state',
    description: 'Read a redacted snapshot of the app state: one source by name, or all of them.',
    inputSchema: obj({ name: { type: 'string' } }),
  },
  {
    name: 'reins_network',
    description: 'Recent fetch/XHR calls: method, url, status, ms, redacted headers and bodies.',
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
];

const METHODS: Record<string, string> = {
  reins_list_actions: 'list',
  reins_run_action: 'run',
  reins_state: 'state',
  reins_network: 'network',
  reins_errors: 'errors',
  reins_panel_box: 'panel',
};

export interface ToolContext {
  hub: Hub;
  dir: string;
  cdp?: string;
  audit?: Audit;
}

/** Runs one MCP tool against the paired app. Every call is audited. */
export async function callTool(ctx: ToolContext, name: string, args: Record<string, any> = {}): Promise<unknown> {
  const started = Date.now();
  const entry = { source: 'agent' as const, event: name, name: args.name ?? args.id, args: name === 'reins_run_action' ? args.input : undefined };
  try {
    let result: unknown;
    if (name === 'reins_snap') {
      const box = await ctx.hub.request('panel', { id: args.id, scroll: true });
      if (!box) throw new Error(`no panel "${args.id}"`);
      result = await snap(box, ctx.hub.current(), { dir: ctx.dir, cdp: ctx.cdp, copy: args.copy === true });
    } else if (METHODS[name]) {
      const params = name === 'reins_run_action' ? { name: args.name, input: args.input, confirm: args.confirm === true } : args;
      result = await ctx.hub.request(METHODS[name], params);
      if (name === 'reins_list_actions') {
        const c = ctx.hub.current();
        result = { app: c && { url: c.url, title: c.title, meta: c.meta }, ...(result as object) };
      }
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
