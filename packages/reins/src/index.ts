import { devEnabled } from './env.js';
import { patchNetwork, ring, watchErrors } from './network.js';
import { redactDeep, redactPairs, redactUrl } from './redact.js';
import type { Action, ActionInfo, Box, ConnectOptions, ErrEntry, Measure, NetEntry, SocketLike } from './types.js';
import { findModelContext, registerTool } from './webmcp.js';

export * from './types.js';
export { devEnabled } from './env.js';
export { redactBody, redactDeep, redactHeaders, redactUrl, REDACTED } from './redact.js';

/** Found in every build that contains reins. `reins-verify-bundle` fails production builds that include it. */
export const DEV_MARKER = '__REINS_DEV_ONLY__';
export const VERSION = '0.1.0';
export const DEFAULT_URL = 'ws://127.0.0.1:7357';
export const DEFAULT_TOKEN_URL = '/__reins/token';

const NAME = /^[\w][\w.-]{0,63}$/;
const msg = (err: any) => String(err?.message || err);

export interface ReinsHandle {
  version: string;
  actions(): ActionInfo[];
  run(name: string, input?: unknown, opts?: { confirm?: boolean }): Promise<unknown>;
  state(name?: string): Record<string, unknown>;
  network(limit?: number): NetEntry[];
  errors(limit?: number): ErrEntry[];
  panel(id: string): Promise<Box | null>;
}

export type Reins = ReturnType<typeof createReins>;

/** Makes a reins instance bound to a global object. Apps use the `reins` export; tests pass a fake global. */
export function createReins(g: any = globalThis) {
  const actions = new Map<string, Action>();
  const states = new Map<string, () => unknown>();
  const measures = new Map<string, Measure>();
  const tools = new Map<string, () => void>();
  let opts: ConnectOptions = {};
  let net = ring<NetEntry>(100);
  let errs = ring<ErrEntry>(100);
  let sock: SocketLike | null = null;
  let paired = false;
  let undo: Array<() => void> = [];
  let mc: any = null;
  let connecting: Promise<boolean> | null = null;
  let retry: any = null;
  let delay = 2000;
  let warned = false;
  let seq = 0;

  const con = () => g.console || {};
  const log = (...args: unknown[]) => con().info?.('[reins]', ...args);

  function send(m: any) {
    let text: string;
    try {
      text = JSON.stringify(m);
    } catch {
      text = JSON.stringify({ type: 'result', id: m.id, ok: false, error: 'not serializable' });
    }
    sock?.send(text);
  }

  function audit(method: string, name: string, via: string, error?: string) {
    log(via, method, name, error ? 'refused: ' + error : '');
    // The bridge audits its own calls; report the ones it cannot see.
    if (via != 'bridge') send({ type: 'audit', entry: { method, name, via, ok: !error, error, at: Date.now() } });
  }

  /** Adds `value` under `key` in `map`; returns a remover that only removes that same value. */
  function keep<T>(map: Map<string, T>, key: string, value: T, after?: () => void) {
    map.set(key, value);
    return () => {
      if (map.get(key) !== value) return;
      map.delete(key);
      after?.();
    };
  }

  function action<I = any, O = any>(def: Action<I, O>): () => void {
    if (!NAME.test(def?.name)) throw new Error(`reins: bad action name "${def?.name}"`);
    if (typeof def.run != 'function') throw new Error(`reins: action "${def.name}" needs a run function`);
    if (paired && mc) addTool(def);
    return keep(actions, def.name, def as Action, () => {
      tools.get(def.name)?.();
      tools.delete(def.name);
    });
  }

  const state = (name: string, get: () => unknown) => keep(states, name, get);
  /** Registers a measure function for a panel that is not a DOM element (React Native). */
  const registerPanel = (id: string, measure: Measure) => keep(measures, id, measure);

  const list = (): ActionInfo[] =>
    [...actions.values()].map((a) => ({
      name: a.name,
      description: a.description,
      input: a.input || { type: 'object', properties: {} },
      consequential: !!a.consequential,
      readOnly: !!a.readOnly,
    }));

  function mustBePaired() {
    if (!paired) throw new Error('reins: not paired with a bridge');
  }

  async function runAction(name: string, input: unknown, confirm: boolean, via: string): Promise<unknown> {
    mustBePaired();
    const a = actions.get(name);
    const refuse = (why: string, text: string) => {
      audit('run', name, via, why);
      throw new Error(`reins: ${text}`);
    };
    if (!a) refuse('unknown action', `unknown action "${name}"`);
    if (a!.consequential && !confirm) refuse('needs confirm', `"${name}" is consequential; call again with confirm: true`);
    const c = con();
    const p = g.performance;
    const mark = `reins:${name}:${++seq}`;
    c.groupCollapsed?.(`[reins] ${name}`);
    c.log?.('input', input);
    try {
      p?.mark?.(mark);
      const result = await a!.run(input ?? {});
      c.log?.('result', result);
      audit('run', name, via);
      return result;
    } catch (err) {
      c.log?.('failed', err);
      audit('run', name, via, msg(err));
      throw err;
    } finally {
      try {
        p?.measure?.(`[reins] ${name}`, mark);
      } catch {
        // marks are optional
      }
      c.groupEnd?.();
    }
  }

  function snapshot(name?: string): Record<string, unknown> {
    mustBePaired();
    const out: Record<string, unknown> = {};
    for (const key of name ? [name] : states.keys()) {
      const get = states.get(key);
      if (!get) throw new Error(`reins: unknown state "${key}"`);
      try {
        out[key] = redactDeep(get(), opts.allow?.stateKeys);
      } catch (err) {
        out[key] = { error: msg(err) };
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
    const el = g.document?.querySelector?.(`[data-reins="${g.CSS?.escape ? g.CSS.escape(id) : id.replace(/["\\]/g, '\\$&')}"]`);
    if (!el) return null;
    if (o.scroll) el.scrollIntoView?.({ block: 'center' });
    const r = el.getBoundingClientRect();
    return {
      id,
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
      scrollX: g.scrollX || 0,
      scrollY: g.scrollY || 0,
      devicePixelRatio: g.devicePixelRatio || 1,
      viewportWidth: g.innerWidth,
      viewportHeight: g.innerHeight,
    };
  }

  function addTool(a: Action) {
    tools.get(a.name)?.();
    try {
      tools.set(a.name, registerTool(mc, a, (n, input, confirm) => runAction(n, input, confirm, 'webmcp')));
    } catch (err) {
      log('webmcp', a.name, msg(err));
    }
  }

  const network = (limit?: number) => net.list(limit);
  const errors = (limit?: number) => errs.list(limit);
  const methods: Record<string, (p: any) => unknown> = {
    list: () => ({ actions: list(), states: [...states.keys()], panels: panels() }),
    run: (p) => runAction(p.name, p.input, p.confirm === true, 'bridge'),
    state: (p) => snapshot(p.name),
    network: (p) => network(p.limit).filter((e) => !p.url || e.url.includes(p.url)),
    errors: (p) => errors(p.limit),
    panel: (p) => panel(p.id, p),
  };

  async function handle(m: any) {
    if (m?.type != 'call') return;
    try {
      const fn = methods[m.method];
      if (!fn) throw new Error(`reins: unknown method "${m.method}"`);
      send({ type: 'result', id: m.id, ok: true, result: (await fn(m.params || {})) ?? null });
    } catch (err) {
      send({ type: 'result', id: m.id, ok: false, error: msg(err) });
    }
  }

  const handleForHumans: ReinsHandle = Object.freeze({
    version: VERSION,
    actions: list,
    run: (name: string, input?: unknown, o?: { confirm?: boolean }) => runAction(name, input, !!o?.confirm, 'devtools'),
    state: snapshot,
    network,
    errors,
    panel: (id: string) => panel(id),
  });

  function pair(s: SocketLike) {
    sock = s;
    paired = true;
    delay = 2000;
    warned = false;
    const allow = opts.allow || {};
    net = ring(opts.bufferSize || 100);
    errs = ring(opts.bufferSize || 100);
    undo.push(patchNetwork(g, net.push, allow), watchErrors(g, errs.push));
    if (g.location?.href) undo.push(state('location', () => redactUrl(String(g.location.href), allow.queryKeys)));
    for (const key of ['localStorage', 'sessionStorage']) {
      if (g[key])
        undo.push(
          state(key, () => {
            const st = g[key];
            const pairs: Array<[string, string]> = [];
            for (let i = 0; i < st.length; i++) pairs.push([st.key(i), st.getItem(st.key(i))]);
            return redactPairs(pairs, allow.storageKeys);
          }),
        );
    }
    if (typeof g.document?.cookie == 'string') {
      undo.push(
        state('cookies', () =>
          redactPairs(
            g.document.cookie
              .split(';')
              .filter(Boolean)
              .map((c: string) => [c.split('=')[0].trim(), c.slice(c.indexOf('=') + 1)]),
            allow.cookies,
          ),
        ),
      );
    }
    mc = opts.webmcp === false ? null : findModelContext(g);
    if (mc) actions.forEach(addTool);
    try {
      Object.defineProperty(g, '__reins__', { value: handleForHumans, configurable: true });
      undo.push(() => delete g.__reins__);
    } catch {
      // frozen global
    }
    log('paired with the bridge');
  }

  function unpair() {
    paired = false;
    sock = null;
    tools.forEach((off) => off());
    tools.clear();
    mc = null;
    undo.reverse().forEach((f) => f());
    undo = [];
  }

  function whenIdle(): Promise<void> {
    const d = g.document;
    return new Promise((resolve) => {
      if (!d || opts.lazy === false) return resolve();
      const idle = () => (g.requestIdleCallback ? g.requestIdleCallback(resolve, { timeout: 2000 }) : setTimeout(resolve));
      if (d.readyState == 'complete') idle();
      else g.addEventListener('load', idle, { once: true });
    });
  }

  async function open(): Promise<boolean> {
    let token = opts.token;
    if (!token && g.fetch) {
      const res = await g.fetch(opts.tokenUrl || DEFAULT_TOKEN_URL, { cache: 'no-store', credentials: 'same-origin' });
      token = res.ok ? String(await res.text()).trim() : '';
    }
    if (!token) throw new Error('no pairing token; is `reins bridge` running?');
    const WS = opts.WebSocket || g.WebSocket;
    return new Promise<boolean>((resolve, reject) => {
      const s: SocketLike = new WS(opts.url || DEFAULT_URL);
      let done = false;
      s.onopen = () =>
        s.send(
          JSON.stringify({
            type: 'hello',
            token,
            marker: DEV_MARKER,
            version: VERSION,
            url: g.location && redactUrl(String(g.location.href)),
            title: g.document?.title,
            meta: opts.meta,
          }),
        );
      s.onmessage = (ev) => {
        let m: any;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (done) return void handle(m);
        done = true;
        if (m?.type == 'welcome') {
          pair(s);
          resolve(true);
        } else {
          s.close();
          reject(new Error(m?.reason || 'refused by the bridge'));
        }
      };
      s.onclose = () => {
        if (!done) {
          done = true;
          reject(new Error('the bridge closed the connection'));
        } else if (sock == s) {
          unpair();
          log('bridge disconnected');
          schedule();
        }
      };
      s.onerror = () => {};
    });
  }

  function schedule() {
    connecting = null;
    if (opts.reconnect === false || retry) return;
    retry = setTimeout(() => {
      retry = null;
      connect(opts);
    }, delay);
    delay = Math.min(delay * 2, 30000);
  }

  /**
   * Starts pairing with the bridge. Does nothing in production builds.
   * Nothing is patched or registered until the bridge accepts the token.
   */
  function connect(o: ConnectOptions = {}): Promise<boolean> {
    if (!devEnabled()) return Promise.resolve(false);
    if (!connecting) {
      opts = o;
      connecting = whenIdle()
        .then(open)
        .catch((err) => {
          if (!warned) log('not paired:', msg(err));
          warned = true;
          schedule();
          return false;
        });
    }
    return connecting;
  }

  function disconnect() {
    opts = { ...opts, reconnect: false };
    clearTimeout(retry);
    retry = null;
    const s = sock;
    unpair();
    connecting = null;
    s?.close();
  }

  return {
    marker: DEV_MARKER,
    action,
    state,
    registerPanel,
    panel,
    panels,
    connect,
    disconnect,
    isPaired: () => paired,
    actions: list,
    run: (name: string, input?: unknown, o?: { confirm?: boolean }) => runAction(name, input, !!o?.confirm, 'api'),
    snapshot,
    network,
    errors,
  };
}

/** The app's reins instance. */
export const reins = createReins();
export default reins;
