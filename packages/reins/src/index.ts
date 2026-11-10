import { devEnabled } from './env.js';
import { msg, patchNetwork, R, ring, watchErrors } from './network.js';
import { isSensitive, REDACTED, redactDeep, redactPairs, redactUrl } from './redact.js';
import type {
  Action,
  ActionInfo,
  Box,
  ComponentPerf,
  ConnectOptions,
  DomNode,
  DomOptions,
  ErrEntry,
  Measure,
  NetEntry,
  PerfReport,
  SocketLike,
} from './types.js';
import { findModelContext, registerTool } from './webmcp.js';

export * from './types.js';
export { devEnabled, redactDeep };

export const DEV_MARKER = '__REINS_DEV_ONLY__';
export const VERSION = '0.1.0';

const NAME = /^[\w][\w.-]{0,63}$/;
const fail = (s: string): never => {
  throw new Error('reins: ' + s);
};
const STYLE_KEYS = 'display,position,flexDirection,justifyContent,alignItems,gap,overflowX,overflowY,direction,color,backgroundColor,fontSize,fontWeight,opacity,visibility,zIndex'.split(',');

export interface ReinsHandle {
  version: string;
  actions(): ActionInfo[];
  run(name: string, input?: unknown, opts?: { confirm?: boolean }): Promise<unknown>;
  state(name?: string): Record<string, unknown>;
  network(limit?: number): NetEntry[];
  errors(limit?: number): ErrEntry[];
  panel(id: string): Promise<Box | null>;
  perf(): PerfReport;
  dom(opts?: DomOptions): DomNode | null;
}

export type Reins = ReturnType<typeof createReins>;

export function createReins(g: any = globalThis) {
  const M = () => new Map<string, any>(),
    actions = M() as Map<string, Action>,
    states = M() as Map<string, () => unknown>,
    measures = M() as Map<string, Measure>,
    comps = M() as Map<string, ComponentPerf>;
  let opts: ConnectOptions = {},
    net = ring<NetEntry>(100),
    errs = ring<ErrEntry>(100),
    sock: SocketLike | null = null,
    paired = false,
    rec = false,
    undo: Array<() => void> = [],
    mc: any = null,
    connecting: Promise<boolean> | null = null,
    retry: any = null,
    delay = 2000;

  const nowMs = () => R(g.performance?.now?.()),
    findPanel = (id: string) => g.document?.querySelector?.(`[data-reins="${id.replace(/["\\]/g, '\\$&')}"]`),
    boxOf = (r: any) => ({ x: R(r.left), y: R(r.top), width: R(r.width), height: R(r.height) }),
    locUrl = () => g.location?.href && redactUrl('' + g.location.href, opts.allow?.queryKeys),
    send = (m: any) => sock?.send(JSON.stringify(m)),
    keep = (map: Map<string, any>, k: string, v: any): (() => void) => (map.set(k, v), () => void (map.get(k) === v && (v._u?.(), map.delete(k)))),
    addTool = (a: any) => {
      a._u?.();
      try {
        undo.push((a._u = registerTool(mc, a, (n, i, c) => runAction(n, i, c, 'webmcp'))));
      } catch {}
    };

  function action<I = any, O = any>(def: Action<I, O>): () => void {
    if (!NAME.test(def?.name)) fail('bad action name');
    if (typeof def.run != 'function') fail('no run function');
    if (paired && mc) addTool(def);
    return keep(actions, def.name, def);
  }

  const state = (name: string, get: () => unknown) => keep(states, name, get);
  const registerPanel = (id: string, measure: Measure) => keep(measures, id, measure);

  function markComponent(id: string, phase?: 'mount' | 'render') {
    if (!id) return;
    const t = nowMs(),
      c = comps.get(id);
    if (!c || phase == 'mount') comps.set(id, { id, mountedAtMs: t, lastRenderMs: t, renders: (c?.renders || 0) + 1 });
    else (c.lastRenderMs = t), c.renders++;
  }

  const list = (): ActionInfo[] =>
    [...actions.values()].map(({ name, description, input = { type: 'object', properties: {} }, consequential, readOnly }) => ({
      name,
      description,
      input,
      consequential: !!consequential,
      readOnly: !!readOnly,
    }));

  const mustBePaired = () => !undo[0] && fail('not paired');

  async function runAction(name: string, input: unknown, confirm: boolean, via: string): Promise<unknown> {
    mustBePaired();
    const a = actions.get(name),
      p = g.performance,
      mark = 'reins:' + name;
    let error: string | undefined;
    try {
      if (!a) fail('unknown action');
      if (a!.consequential && !confirm) fail('confirm: true required');
      p?.mark?.(mark);
      return await a!.run(input ?? {});
    } catch (e) {
      error = msg(e);
      throw e;
    } finally {
      if (via != 'bridge') send({ type: 'audit', entry: { method: 'run', name, via, ok: !error, error, at: Date.now() } });
      try {
        p?.measure?.('[reins] ' + name, mark);
      } catch {}
    }
  }

  function snapshot(name?: string): Record<string, unknown> {
    mustBePaired();
    const out: Record<string, unknown> = {};
    for (const k of name ? [name] : states.keys()) {
      const get = states.get(k) || fail('unknown state');
      try {
        out[k] = redactDeep(get(), opts.allow?.stateKeys);
      } catch (e) {
        out[k] = { error: msg(e) };
      }
    }
    return out;
  }

  function panels(): string[] {
    const ids = new Set(measures.keys());
    g.document?.querySelectorAll?.('[data-reins]').forEach((el: any) => ids.add(el.getAttribute('data-reins')));
    return [...ids];
  }

  async function panel(id: string, o: { scroll?: boolean } = {}): Promise<Box | null> {
    const m = measures.get(id);
    if (m) return m();
    const el = findPanel(id);
    if (!el) return null;
    if (o.scroll) el.scrollIntoView?.({ block: 'center' });
    return {
      id,
      ...boxOf(el.getBoundingClientRect()),
      scrollX: g.scrollX || 0,
      scrollY: g.scrollY || 0,
      devicePixelRatio: g.devicePixelRatio || 1,
      viewportWidth: g.innerWidth,
      viewportHeight: g.innerHeight,
    };
  }

  function perf(): PerfReport {
    const p = g.performance,
      ent = (t: string): any[] => p?.getEntriesByType?.(t) || [],
      nav = ent('navigation')[0],
      paints = ent('paint'),
      num = (v: any) => (v >= 0 && v !== null ? R(v) : null),
      pt = (n: string) => num(paints.find((e) => e.name == 'first-' + n)?.startTime),
      lifecycle = {
        ttfbMs: num(nav?.responseStart),
        domInteractiveMs: num(nav?.domInteractive),
        domContentLoadedMs: num(nav?.domContentLoadedEventEnd),
        loadMs: num(nav?.loadEventEnd),
        firstPaintMs: pt('paint'),
        firstContentfulPaintMs: pt('contentful-paint'),
        domNodes: g.document?.getElementsByTagName?.('*')?.length || 0,
        nowMs: nowMs(),
      },
      components = [...comps.values()].sort((a, b) => a.mountedAtMs - b.mountedAtMs),
      // Full (redacted) entries; the bridge trims them to the timing fields.
      calls = net.list(),
      act = ent('measure').flatMap((m) => (m.name?.startsWith?.('[reins] ') ? [{ name: m.name, startMs: R(m.startTime), durationMs: R(m.duration) }] : []));
    let sum = 0,
      failedCalls = 0,
      slowest: any = null;
    for (const c of calls) {
      sum += c.ms;
      if (!c.status || c.status >= 400) failedCalls++;
      if (!slowest || c.ms > slowest.ms) slowest = c;
    }
    // The timeline is built from these parts by `withTimeline` in `reins/report`, in the bridge and in record mode.
    return {
      lifecycle,
      components,
      api: { totalCalls: calls.length, failedCalls, avgMs: R(calls.length && sum / calls.length), maxMs: slowest?.ms || 0, slowest, calls },
      actions: act,
    };
  }

  function dom(o: DomOptions = {}): DomNode | null {
    const d = g.document;
    let root = d && (o.panel ? findPanel(o.panel) : o.selector ? d : d.body);
    if (root && o.selector) root = root.querySelector?.(o.selector);
    if (!root) return null;
    let count = 0;
    const walk = (el: any, depth: number): DomNode => {
      count++;
      const r = el.getBoundingClientRect?.() || {},
        cs = g.getComputedStyle?.(el) || {},
        styles: Record<string, string> = {},
        issues: DomNode['issues'] = [],
        clip = (v: any) => /^hidden|clip$/.test(v),
        attr = (k: string) => el.getAttribute?.(k) || undefined,
        cls = el.className?.trim?.(),
        children: DomNode[] = [];
      let raw = '';
      for (const n of el.childNodes || []) if (n.nodeType == 3) raw += n.textContent;
      raw = raw.trim().slice(0, 80);
      for (const k of STYLE_KEYS) if (cs[k]) styles[k] = '' + cs[k];
      if (el.scrollWidth > el.clientWidth + 1 && (clip(cs.overflowX) || cs.textOverflow == 'ellipsis')) issues.push('horizontal-clip');
      if (el.scrollHeight > el.clientHeight + 1 && clip(cs.overflowY)) issues.push('vertical-clip');
      if ((!r.width || !r.height) && !/^(none|contents)$/.test(cs.display)) issues.push('zero-size');
      if (depth < (o.depth ?? 3)) for (const ch of el.children || []) if (count < (o.maxNodes ?? 40)) children.push(walk(ch, depth + 1));
      return {
        tag: (el.tagName || 'div').toLowerCase(),
        id: el.id || undefined,
        classes: cls ? cls.split(/\s+/) : undefined,
        panel: attr('data-reins'),
        role: attr('role'),
        text: raw ? (isSensitive([el.id, attr('name'), attr('type')].join(' ')) ? REDACTED : raw) : undefined,
        box: boxOf(r),
        styles,
        issues,
        children,
      };
    };
    return walk(root, 0);
  }

  const network = (limit?: number) => net.list(limit),
    errors = (limit?: number) => errs.list(limit),
    runner = (via: string) => (n: string, i?: unknown, o?: { confirm?: boolean }) => runAction(n, i, !!o?.confirm, via),
    methods: Record<string, (p: any) => unknown> = {
      list: () => ({ actions: list(), states: [...states.keys()], panels: panels() }),
      run: (p) => runAction(p.name, p.input, p.confirm === true, 'bridge'),
      state: (p) => snapshot(p.name),
      network: (p) => network(p.limit).filter((e) => !p.url || e.url.includes(p.url)),
      errors: (p) => errors(p.limit),
      panel: (p) => panel(p.id, p),
      perf,
      dom,
    },
    base = { actions: list, network, errors, perf, dom, panel },
    handleForHumans: ReinsHandle = Object.freeze({ version: VERSION, ...base, run: runner('devtools'), state: snapshot });

  // `undo` starts with the network and error patches, so it is non-empty exactly while reins is live (paired or recording).
  function start() {
    if (undo[0]) return;
    const allow = opts.allow || {},
      sz = opts.bufferSize || 100;
    net = ring(sz);
    errs = ring(sz);
    undo = [patchNetwork(g, net.push, allow, () => paired), watchErrors(g, errs.push)];
    if (g.location?.href) states.set('location', locUrl);
    for (const k of ['localStorage', 'sessionStorage']) if (g[k]) states.set(k, () => redactPairs(Object.entries(g[k]), allow.storageKeys));
    if (g.document?.cookie != null)
      states.set('cookies', () => redactPairs(g.document.cookie.split(/; */).filter(Boolean).map((c: string) => c.split('=')), allow.cookies));
  }

  function pair(s: SocketLike) {
    sock = s;
    paired = true;
    delay = 2000;
    start();
    undo.push(() => delete g.__reins__);
    mc = opts.webmcp !== false && findModelContext(g);
    if (mc) actions.forEach(addTool);
    try {
      g.__reins__ = handleForHumans;
    } catch {}
  }

  // Undoes everything after the first `n` entries: 2 keeps the patches running for record mode.
  const off = (n: number) => undo.splice(n).forEach((f) => f());

  function unpair() {
    paired = false;
    sock = mc = null;
    off(rec ? 2 : 0);
  }

  /** Record mode (`reins/record`): starts the buffers without a bridge, in dev builds only. `false` stops it. */
  const record = (o?: ConnectOptions | false): boolean =>
    ((rec = o !== false && devEnabled()), paired || (rec ? ((opts = o || opts), start()) : off(0)), rec);

  async function open(): Promise<boolean> {
    if (g.document && opts.lazy !== false)
      await new Promise((r) => (g.document.readyState == 'complete' ? setTimeout(r) : g.addEventListener('load', r, { once: true })));
    let token = opts.token;
    if (!token && g.fetch) {
      const res = await g.fetch(opts.tokenUrl || '/__reins/token', { cache: 'no-store' });
      token = res.ok && (await res.text()).trim();
    }
    if (!token) fail('no token');
    return new Promise((res, rej) => {
      const s: SocketLike = new (opts.WebSocket || g.WebSocket)(opts.url || 'ws://127.0.0.1:7357');
      let done = false;
      s.onopen = () => s.send(JSON.stringify({ type: 'hello', token, marker: DEV_MARKER, version: VERSION, url: locUrl(), title: g.document?.title, meta: opts.meta }));
      s.onmessage = async (ev) => {
        try {
          const m = JSON.parse('' + ev.data);
          if (!done) {
            done = true;
            return m.type == 'welcome' ? (pair(s), res(true)) : (s.close(), rej());
          }
          if (m.type == 'call')
            try {
              send({ type: 'result', id: m.id, ok: true, result: (await (methods[m.method] || fail('bad method'))(m.params || {})) ?? null });
            } catch (e) {
              send({ type: 'result', id: m.id, ok: false, error: msg(e) });
            }
        } catch {}
      };
      s.onclose = () => (!done ? rej() : sock == s && (unpair(), schedule()));
    });
  }

  function schedule() {
    connecting = null;
    if (opts.reconnect !== false && !retry) retry = setTimeout(() => ((retry = null), connect(opts)), delay < 30000 ? (delay *= 2) / 2 : delay);
  }

  function connect(o: ConnectOptions = {}): Promise<boolean> {
    if (!devEnabled()) return Promise.resolve(false);
    if (!connecting) {
      opts = o;
      connecting = open().catch(() => (schedule(), false));
    }
    return connecting;
  }

  function disconnect() {
    opts = { reconnect: false };
    clearTimeout(retry);
    retry = connecting = null;
    const s = sock;
    unpair();
    s?.close();
  }

  return {
    marker: DEV_MARKER,
    action,
    state,
    registerPanel,
    markComponent,
    panels,
    connect,
    disconnect,
    isPaired: () => paired,
    record,
    snapshot,
    ...base,
    run: runner('api'),
  };
}

export const reins = createReins();
export default reins;
