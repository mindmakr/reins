// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { reins } from 'reins';
import { ReinsPanel, useReinsAction, useReinsState } from 'reins/react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ unmount(): void }> = [];
function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(el));
  return { host, root };
}

afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  document.body.innerHTML = '';
});

const panelPerf = (id: string) => reins.perf().components.find((c) => c.id === id);

describe('reins/react', () => {
  it('renders a data-reins div and passes other props through', () => {
    const { host } = mount(createElement(ReinsPanel, { id: 'checkout', className: 'box' }, 'hi'));
    const div = host.querySelector('[data-reins="checkout"]')!;
    expect(div.className).toBe('box');
    expect(div.textContent).toBe('hi');
    expect(reins.panels()).toContain('checkout');
  });

  it('counts one render per commit, not per render call', () => {
    let bump = () => {};
    function Screen() {
      const [n, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      return createElement(ReinsPanel, { id: 'render-count' }, String(n));
    }
    mount(createElement(Screen));
    const first = panelPerf('render-count')!;
    expect(first.renders).toBe(1);
    expect(typeof first.mountedAtMs).toBe('number');

    act(() => bump());
    act(() => bump());
    expect(panelPerf('render-count')!.renders).toBe(3);
    expect(panelPerf('render-count')!.mountedAtMs).toBe(first.mountedAtMs);
  });

  it('registers actions and state while mounted and removes them on unmount', () => {
    function Screen({ label }: { label: string }) {
      useReinsAction({ name: 'say-label', description: 'Returns the label', readOnly: true, run: () => label });
      useReinsState('screen', () => ({ label }));
      return null;
    }
    const { root } = mount(createElement(Screen, { label: 'one' }));
    expect(reins.actions().map((a) => a.name)).toContain('say-label');

    // The registered action sees the latest props without re-registering.
    act(() => root.render(createElement(Screen, { label: 'two' })));
    expect(reins.actions().filter((a) => a.name === 'say-label')).toHaveLength(1);

    act(() => root.unmount());
    roots.length = 0;
    expect(reins.actions().map((a) => a.name)).not.toContain('say-label');
  });
});
