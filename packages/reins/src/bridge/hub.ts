import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Audit } from './audit.js';
import { isOriginAllowed } from './origin.js';
import { newToken, removeToken, tokensMatch, writeToken } from './token.js';

export const DEFAULT_PORT = 7357;
/** The bridge listens on loopback only. There is no option to change this. */
export const HOST = '127.0.0.1';

export interface HubOptions {
  /** Project folder; the token goes to `<dir>/.reins/token`. */
  dir: string;
  /** Default 7357. Use 0 for a free port (tests). */
  port?: number;
  /** Extra allowed origins, matched exactly. Localhost origins are always allowed. */
  origins?: string[];
  /** Allow clients that send no Origin (React Native). Default true; the token is still required. */
  allowNoOrigin?: boolean;
  /** Issue a new token after each successful pairing. Default true. */
  rotate?: boolean;
  audit?: Audit;
  log?: (msg: string) => void;
  handshakeMs?: number;
  callMs?: number;
}

export interface Client {
  id: number;
  url?: string;
  title?: string;
  meta?: Record<string, string>;
  socket: WebSocket;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  /** Only this client may answer. */
  client: Client;
}

/** The WebSocket side of the bridge: pairs pages that present the token, then forwards calls to them. */
export class Hub {
  token = '';
  readonly clients: Client[] = [];
  /** When the bridge started; a session report covers the audit log from here on. */
  readonly startedAt = Date.now();
  private server!: WebSocketServer;
  private pending = new Map<number, Pending>();
  private nextCall = 1;
  private nextClient = 1;

  private constructor(private opts: HubOptions) {}

  static start(opts: HubOptions): Promise<Hub> {
    const hub = new Hub(opts);
    hub.issueToken();
    return new Promise((resolve, reject) => {
      hub.server = new WebSocketServer({
        host: HOST,
        port: opts.port ?? DEFAULT_PORT,
        maxPayload: 4 * 1024 * 1024,
        verifyClient: (info: { origin: string; req: IncomingMessage }, cb: (ok: boolean, code?: number, msg?: string) => void) => {
          const origin = info.origin || (info.req.headers.origin as string | undefined);
          if (isOriginAllowed(origin, opts.origins, opts.allowNoOrigin ?? true)) return cb(true);
          hub.audit({ source: 'bridge', event: 'refused', ok: false, error: `origin not allowed: ${origin}` });
          cb(false, 403, 'origin not allowed');
        },
      });
      hub.server.once('listening', () => resolve(hub));
      hub.server.once('error', reject);
      hub.server.on('connection', (socket) => hub.accept(socket));
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  private log(msg: string) {
    (this.opts.log ?? ((m: string) => process.stderr.write(m + '\n')))(msg);
  }

  private audit(entry: Parameters<Audit>[0]) {
    if (this.opts.audit) this.opts.audit(entry);
  }

  private issueToken() {
    this.token = newToken();
    writeToken(this.opts.dir, this.token);
  }

  private accept(socket: WebSocket) {
    let client: Client | null = null;
    const timer = setTimeout(() => socket.close(4401, 'no handshake'), this.opts.handshakeMs ?? 5000);
    socket.on('message', (data) => {
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!client) {
        clearTimeout(timer);
        if (m && m.type === 'hello' && tokensMatch(m.token, this.token)) {
          client = { id: this.nextClient++, url: m.url, title: m.title, meta: m.meta, socket };
          this.clients.push(client);
          socket.send(JSON.stringify({ type: 'welcome', client: client.id }));
          this.audit({ source: 'bridge', event: 'paired', name: client.url, ok: true });
          this.log(`[reins] paired with ${client.url ?? 'an app'} (client ${client.id})`);
          if (this.opts.rotate !== false) this.issueToken();
        } else {
          this.audit({ source: 'bridge', event: 'refused', ok: false, error: 'bad or missing token' });
          socket.send(JSON.stringify({ type: 'refused', reason: 'bad or missing token' }));
          socket.close(4401, 'bad token');
        }
        return;
      }
      if (m.type === 'result') {
        const p = this.pending.get(m.id);
        if (!p || p.client !== client) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(String(m.error)));
      } else if (m.type === 'audit' && m.entry) {
        const e = m.entry;
        this.audit({ source: 'page', event: String(e.method), name: e.name, via: e.via, ok: e.ok, error: e.error });
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      const i = client ? this.clients.indexOf(client) : -1;
      if (i >= 0) {
        this.clients.splice(i, 1);
        this.log(`[reins] client ${client!.id} disconnected`);
        for (const [id, p] of this.pending)
          if (p.client === client) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.reject(new Error('the app disconnected'));
          }
      }
    });
    socket.on('error', () => {});
  }

  /** Whether a client is a `reins/node` server rather than a page or an app. */
  static isNode(c: Client): boolean {
    return !!c.meta && c.meta.platform === 'node';
  }

  /** The most recently paired page or app (not a Node server). Browser methods go here. */
  current(): Client | undefined {
    return this.clients.filter((c) => !Hub.isNode(c)).pop();
  }

  /** Paired `reins/node` servers, oldest first. */
  nodeClients(): Client[] {
    return this.clients.filter(Hub.isNode);
  }

  /** Sends a call to a client (default: the newest page or app) and waits for its result. */
  request(method: string, params: Record<string, unknown> = {}, target?: Client): Promise<any> {
    const client = target ?? this.current();
    if (!client) {
      return Promise.reject(new Error('No app is paired. Open the app in dev mode (it must call reins.connect()) and make sure the dev server serves .reins/token.'));
    }
    const id = this.nextCall++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the app did not answer "${method}" in time`));
      }, this.opts.callMs ?? 15000);
      this.pending.set(id, { resolve, reject, timer, client });
      client.socket.send(JSON.stringify({ type: 'call', id, method, params }));
    });
  }

  close(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('bridge closed'));
    }
    this.pending.clear();
    for (const c of this.clients) c.socket.terminate();
    removeToken(this.opts.dir);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
