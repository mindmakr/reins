// Production stand-in for `reins`. Same API, does nothing, holds no dev marker.
// The Vite, Next and Expo plugins swap `reins` for this file in production builds.
export * from './types.js';

const noop = () => {};
const off = () => noop;
const refuse = () => Promise.reject(new Error('reins is not in this build'));

export const VERSION = '0.1.0';
export const devEnabled = () => false;

export function createReins(_g?: unknown) {
  return {
    marker: '',
    action: off as (def: unknown) => () => void,
    state: off as (name: string, get: () => unknown) => () => void,
    registerPanel: off as (id: string, measure: unknown) => () => void,
    markComponent: noop as (id: string, phase?: 'mount' | 'render') => void,
    panel: (_id: string, _o?: unknown) => Promise.resolve(null),
    panels: (): string[] => [],
    perf: () => ({
      lifecycle: { ttfbMs: null, domInteractiveMs: null, domContentLoadedMs: null, loadMs: null, firstPaintMs: null, firstContentfulPaintMs: null, domNodes: 0, nowMs: 0 },
      components: [],
      api: { totalCalls: 0, failedCalls: 0, avgMs: 0, maxMs: 0, slowest: null, calls: [] },
      actions: [],
      timeline: [],
    }),
    dom: (_o?: unknown) => Promise.resolve(null),
    connect: (_o?: unknown) => Promise.resolve(false),
    disconnect: noop,
    isPaired: () => false,
    record: (_o?: unknown) => false,
    actions: (): unknown[] => [],
    run: (_name: string, _input?: unknown, _o?: unknown) => refuse(),
    snapshot: (_name?: string): Record<string, unknown> => ({}),
    network: (_limit?: number): unknown[] => [],
    errors: (_limit?: number): unknown[] => [],
  };
}

export const reins = createReins();
export default reins;
