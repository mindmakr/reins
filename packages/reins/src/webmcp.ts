import type { Action } from './types.js';

/** The WebMCP model context, if this browser has one. */
export function findModelContext(g: any): any {
  const mc = (g.document && g.document.modelContext) || (g.navigator && g.navigator.modelContext);
  return mc && typeof mc.registerTool === 'function' ? mc : null;
}

type Run = (name: string, input: unknown, confirm: boolean) => Promise<unknown>;

/** Registers one action as a WebMCP tool. Consequential actions get a `confirm` input. Returns an unregister function. */
export function registerTool(mc: any, a: Action, run: Run): () => void {
  let inputSchema: Record<string, any> = a.input || { type: 'object', properties: {} };
  if (a.consequential) {
    inputSchema = {
      ...inputSchema,
      type: 'object',
      properties: { ...(inputSchema.properties || {}), confirm: { type: 'boolean', description: 'Must be true' } },
      required: [...(inputSchema.required || []), 'confirm'],
    };
  }
  const reg = mc.registerTool({
    name: a.name,
    description: a.description,
    inputSchema,
    annotations: { readOnlyHint: !!a.readOnly && !a.consequential, destructiveHint: !!a.consequential },
    async execute(args: Record<string, unknown> = {}) {
      let input = args;
      if (a.consequential) {
        const { confirm: _confirm, ...rest } = args;
        input = rest;
      }
      const result = await run(a.name, input, args.confirm === true);
      return { content: [{ type: 'text', text: JSON.stringify(result === undefined ? null : result) }] };
    },
  });
  return () => {
    try {
      if (reg && typeof reg.unregister === 'function') reg.unregister();
      else if (typeof mc.unregisterTool === 'function') mc.unregisterTool(a.name);
    } catch {
      // already gone
    }
  };
}
