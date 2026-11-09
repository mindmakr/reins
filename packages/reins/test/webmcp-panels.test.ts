// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createReins } from '../src/index.js';
import { connectOpts, FakeSocket, fakeGlobal } from './helpers.js';

function fakeModelContext() {
  const tools = new Map<string, any>();
  return {
    tools,
    registerTool: vi.fn((t: any) => {
      tools.set(t.name, t);
      return { unregister: () => tools.delete(t.name) };
    }),
  };
}

describe('WebMCP', () => {
  it('registers every action as a tool after pairing, with hints and confirm', async () => {
    const mc = fakeModelContext();
    const g = fakeGlobal({ navigator: { modelContext: mc } });
    const r = createReins(g);
    const wipe = vi.fn(() => 'wiped');
    r.action({ name: 'get-user', description: 'Reads the user', readOnly: true, run: () => ({ id: 1 }) });
    r.action({ name: 'wipe', description: 'Wipes data', consequential: true, input: { type: 'object', properties: { scope: { type: 'string' } } }, run: wipe });
    expect(mc.registerTool).not.toHaveBeenCalled();

    await r.connect(connectOpts);
    expect([...mc.tools.keys()]).toEqual(['get-user', 'wipe']);
    expect(mc.tools.get('get-user').annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    const wipeTool = mc.tools.get('wipe');
    expect(wipeTool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(wipeTool.inputSchema.properties.confirm.type).toBe('boolean');
    expect(wipeTool.inputSchema.required).toContain('confirm');

    expect(await mc.tools.get('get-user').execute({})).toEqual({ content: [{ type: 'text', text: '{"id":1}' }] });
    await expect(wipeTool.execute({ scope: 'all' })).rejects.toThrow(/confirm: true/);
    expect(wipe).not.toHaveBeenCalled();
    await wipeTool.execute({ scope: 'all', confirm: true });
    expect(wipe).toHaveBeenCalledWith({ scope: 'all' });

    r.action({ name: 'late', description: 'Added after pairing', run: () => 1 });
    expect(mc.tools.has('late')).toBe(true);

    r.disconnect();
    expect(mc.tools.size).toBe(0);
  });

  it('uses document.modelContext too, and can be turned off', async () => {
    const mc = fakeModelContext();
    const g = fakeGlobal({ document: { modelContext: mc } });
    const r = createReins(g);
    r.action({ name: 'a', description: 'a', run: () => 1 });
    await r.connect({ ...connectOpts, webmcp: false });
    expect(mc.registerTool).not.toHaveBeenCalled();
    r.disconnect();
    await r.connect(connectOpts);
    expect(mc.tools.has('a')).toBe(true);
    r.disconnect();
  });
});

describe('panels', () => {
  it('measures data-reins elements in CSS pixels with the device pixel ratio', async () => {
    document.body.innerHTML = '<div data-reins="cart">cart</div><div data-reins="nav"></div>';
    const el = document.querySelector('[data-reins="cart"]')!;
    el.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 120 }) as DOMRect;
    const g = Object.assign(fakeGlobal(), { document, devicePixelRatio: 2, innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 40 });
    const r = createReins(g);
    r.registerPanel('native', () => ({ id: 'native', x: 1, y: 2, width: 3, height: 4, scrollX: 0, scrollY: 0, devicePixelRatio: 3 }));
    await r.connect(connectOpts);
    const res = await FakeSocket.last!.call('panel', { id: 'cart' });
    expect(res.result).toEqual({ id: 'cart', x: 10, y: 20, width: 300, height: 120, scrollX: 0, scrollY: 40, devicePixelRatio: 2, viewportWidth: 1280, viewportHeight: 800 });
    expect((await FakeSocket.last!.call('panel', { id: 'missing' })).result).toBeNull();
    expect((await FakeSocket.last!.call('panel', { id: 'native' })).result.devicePixelRatio).toBe(3);
    expect((await FakeSocket.last!.call('list')).result.panels.sort()).toEqual(['cart', 'native', 'nav']);
    r.disconnect();
  });

  it('waits for load before connecting when lazy', async () => {
    const r = createReins(window);
    const before = FakeSocket.created;
    const p = r.connect({ ...connectOpts, lazy: true });
    expect(FakeSocket.created).toBe(before);
    expect(await p).toBe(true);
    expect((window as any).__reins__).toBeDefined();
    r.disconnect();
    expect((window as any).__reins__).toBeUndefined();
  });
});
