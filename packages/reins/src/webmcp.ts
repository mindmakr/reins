import type { Action } from './types.js';

export const findModelContext = (g: any): any => {
  const m = g.document?.modelContext || g.navigator?.modelContext;
  return m?.registerTool && m;
};

export function registerTool(mc: any, a: Action, run: (n: string, i: unknown, c: boolean) => Promise<unknown>): () => void {
  const s: any = a.input || { type: 'object', properties: {} },
    c = !!a.consequential,
    reg = mc.registerTool({
      ...a,
      inputSchema: c ? { ...s, properties: { ...s.properties, confirm: { type: 'boolean' } }, required: [...(s.required || []), 'confirm'] } : s,
      annotations: { readOnlyHint: !!a.readOnly && !c, destructiveHint: c },
      execute: async ({ confirm, ...rest }: any = {}) => ({
        content: [{ type: 'text', text: JSON.stringify((await run(a.name, c ? rest : { confirm, ...rest }, confirm === true)) ?? null) }],
      }),
    });
  return () => {
    try {
      reg?.unregister ? reg.unregister() : mc.unregisterTool?.(a.name);
    } catch {}
  };
}
