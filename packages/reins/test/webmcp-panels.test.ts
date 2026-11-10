// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createReins } from '../src/index.js';
import { withTimeline } from '../src/report.js';
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

describe('perf and dom', () => {
  it('collects lifecycle, component mounts/renders, API call stats, actions, and unified timeline', async () => {
    let clock = 50;
    const measures: any[] = [];
    const g = Object.assign(fakeGlobal(), {
      document,
      performance: {
        now: () => clock,
        mark: () => {},
        measure: (name: string) => measures.push({ name, startTime: clock - 4, duration: 4 }),
        getEntriesByType: (type: string) => {
          if (type === 'navigation') return [{ responseStart: 12, domInteractive: 35, domContentLoadedEventEnd: 42, loadEventEnd: 60 }];
          if (type === 'paint') return [{ name: 'first-paint', startTime: 25 }, { name: 'first-contentful-paint', startTime: 30 }];
          if (type === 'measure') return measures;
          return [];
        },
      },
      fetch: async (url: string) => {
        clock += String(url).includes('slow') ? 40 : 10;
        return { status: String(url).includes('fail') ? 500 : 200, headers: new Map() };
      },
    });
    const r = createReins(g);
    r.action({ name: 'filter-invoices', description: 'Filters invoices', run: () => ({ ok: true }) });
    await r.connect(connectOpts);

    clock = 45;
    r.markComponent('header');
    clock = 48;
    r.markComponent('summary-cards');
    clock = 55;
    r.markComponent('summary-cards');

    clock = 70;
    await g.fetch('/api/invoices');
    clock = 90;
    await g.fetch('/api/slow-report');
    clock = 140;
    await g.fetch('/api/fail');

    clock = 160;
    await r.run('filter-invoices', {});

    const res = await FakeSocket.last!.call('perf');
    expect(res.result.timeline).toBeUndefined();
    const report = withTimeline(res.result) as any;
    expect(report.lifecycle).toMatchObject({
      ttfbMs: 12,
      firstPaintMs: 25,
      firstContentfulPaintMs: 30,
      domInteractiveMs: 35,
      domContentLoadedMs: 42,
      loadMs: 60,
    });
    expect(report.components).toEqual([
      { id: 'header', mountedAtMs: 45, lastRenderMs: 45, renders: 1 },
      { id: 'summary-cards', mountedAtMs: 48, lastRenderMs: 55, renders: 2 },
    ]);
    expect(report.api).toMatchObject({
      totalCalls: 3,
      failedCalls: 1,
      avgMs: 20,
      maxMs: 40,
      slowest: { method: 'GET', url: '/api/slow-report', status: 200, startMs: 90, ms: 40 },
    });
    expect(report.actions).toEqual([{ name: '[reins] filter-invoices', startMs: 156, durationMs: 4 }]);
    expect(report.timeline.map((t: any) => t.kind)).toContain('lifecycle');
    expect(report.timeline.map((t: any) => t.kind)).toContain('component-mount');
    expect(report.timeline.map((t: any) => t.kind)).toContain('api');
    expect(report.timeline.map((t: any) => t.kind)).toContain('action');
    for (let i = 1; i < report.timeline.length; i++) {
      expect(report.timeline[i].atMs).toBeGreaterThanOrEqual(report.timeline[i - 1].atMs);
    }
    r.disconnect();
  });

  it('inspects DOM subtrees, computed styles, redacts sensitive text, and flags layout issues', async () => {
    document.body.innerHTML = `
      <section data-reins="summary-cards" id="summary" class="cards grid" role="region" style="display: flex; direction: rtl; gap: 12px;">
        <div id="rev-total" class="stat" style="overflow-x: hidden;">Total Revenue $12,400</div>
        <div id="api-secret" class="secret">sk_live_12345</div>
        <span id="empty-badge" style="display: block;"></span>
      </section>
    `;
    const root = document.getElementById('summary')!;
    const card = document.getElementById('rev-total')!;
    const secret = document.getElementById('api-secret')!;
    const badge = document.getElementById('empty-badge')!;

    root.getBoundingClientRect = () => ({ left: 16, top: 80, width: 600, height: 120 }) as DOMRect;
    card.getBoundingClientRect = () => ({ left: 16, top: 80, width: 180, height: 100 }) as DOMRect;
    Object.defineProperty(card, 'clientWidth', { value: 180 });
    Object.defineProperty(card, 'scrollWidth', { value: 260 });
    secret.getBoundingClientRect = () => ({ left: 210, top: 80, width: 180, height: 100 }) as DOMRect;
    badge.getBoundingClientRect = () => ({ left: 400, top: 80, width: 0, height: 20 }) as DOMRect;

    const r = createReins(window);
    await r.connect(connectOpts);

    const res = await FakeSocket.last!.call('dom', { panel: 'summary-cards', depth: 2 });
    const tree = res.result;
    expect(tree).toMatchObject({
      tag: 'section',
      id: 'summary',
      classes: ['cards', 'grid'],
      panel: 'summary-cards',
      role: 'region',
      box: { x: 16, y: 80, width: 600, height: 120 },
      styles: expect.objectContaining({ display: 'flex', direction: 'rtl' }),
      issues: [],
    });
    expect(tree.children[0]).toMatchObject({
      id: 'rev-total',
      text: 'Total Revenue $12,400',
      issues: ['horizontal-clip'],
    });
    expect(tree.children[1]).toMatchObject({
      id: 'api-secret',
      text: '[redacted]',
    });
    expect(tree.children[2]).toMatchObject({
      id: 'empty-badge',
      issues: ['zero-size'],
    });
    expect(r.dom({ panel: 'nonexistent' })).toBeNull();
    r.disconnect();
  });
});
