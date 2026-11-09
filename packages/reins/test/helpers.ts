import type { SocketLike } from '../src/types.js';

export const GOOD = 'good-token';

/** A stand-in for the bridge: accepts the hello with GOOD, refuses anything else, and lets tests send calls. */
export class FakeSocket implements SocketLike {
  static last: FakeSocket | null = null;
  static created = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  sent: any[] = [];
  closed = false;
  private next = 1;
  private waiting = new Map<number, (m: any) => void>();

  constructor(public url: string) {
    FakeSocket.last = this;
    FakeSocket.created++;
    setTimeout(() => this.onopen && this.onopen(), 0);
  }

  send(data: string) {
    const m = JSON.parse(data);
    this.sent.push(m);
    if (m.type === 'hello') {
      if (m.token === GOOD) this.receive({ type: 'welcome' });
      else {
        this.receive({ type: 'refused', reason: 'bad token' });
      }
    } else if (m.type === 'result') {
      const done = this.waiting.get(m.id);
      if (done) done(m);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.onclose && this.onclose(), 0);
  }

  receive(m: unknown) {
    setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(m) }), 0);
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.receive({ type: 'call', id, method, params });
    });
  }
}

export function quietConsole() {
  const noop = () => {};
  return { info: noop, log: noop, groupCollapsed: noop, groupEnd: noop, error: noop, warn: noop };
}

export function fakeGlobal(extra: Record<string, unknown> = {}): any {
  return { console: quietConsole(), performance: { now: () => Date.now(), mark() {}, measure() {} }, ...extra };
}

export const connectOpts = { token: GOOD, WebSocket: FakeSocket as any, reconnect: false, lazy: false };
