// reins/record: tester record mode. Browser only. Works without a bridge, but only in builds where reins
// is enabled (dev, or a private staging build with REINS_ENABLE=1) and only after the tester opts in
// (`?reins=record` in the URL via `recordFromUrl()`, or a button that calls `startRecording()`).
// Production builds swap this file for `reins/record-stub`; it carries the dev marker so `reins verify` catches it.
import { devEnabled, reins, VERSION, type Allow } from 'reins';
import { inspect } from './dom.js';
import { buildSession, renderMarkdown, type SessionData } from './report.js';

const MARKER = '__REINS_DEV_ONLY__';

export interface RecordOptions {
  /** Keys shown as they are; everything sensitive is redacted, as in the core. */
  allow?: Allow;
  /** Size of the network and error buffers. Default 100. */
  bufferSize?: number;
  /** Show the "● Recording · Export" pill. Default true. */
  pill?: boolean;
}

export interface ExportOptions {
  format?: 'md' | 'json' | 'both';
  title?: string;
}

let on = false;
let pill: any = null;

const doc = (): any => (globalThis as any).document;

function showPill() {
  const d = doc();
  if (!d?.body || pill) return;
  const el = d.createElement('div');
  el.setAttribute('data-reins-record', MARKER);
  el.setAttribute('role', 'status');
  el.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:999px;background:#111;color:#fff;font:12px/1.2 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
  const btn = (label: string, title: string, fn: () => void) => {
    const b = d.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'all:unset;cursor:pointer;padding:2px 6px;border-radius:6px;background:#333';
    b.onclick = fn;
    return b;
  };
  const dot = d.createElement('span');
  dot.textContent = '● Recording';
  dot.style.color = '#ff5c5c';
  el.append(dot, btn('Export', 'Download this session as Markdown and JSON', () => exportSession()), btn('×', 'Stop recording', stopRecording));
  d.body.appendChild(el);
  pill = el;
}

/** Starts record mode. Returns false (and does nothing) when reins is not enabled in this build. */
export function startRecording(o: RecordOptions = {}): boolean {
  if (!devEnabled() || !reins.record({ allow: o.allow, bufferSize: o.bufferSize })) return false;
  on = true;
  if (o.pill !== false) showPill();
  return true;
}

/** Starts record mode only when the page URL has `?reins=record`. */
export function recordFromUrl(o: RecordOptions = {}): boolean {
  const q = '' + ((globalThis as any).location?.search || '');
  return /[?&]reins=record(&|$)/.test(q) && startRecording(o);
}

/** Stops record mode and removes the pill. */
export function stopRecording(): void {
  on = false;
  reins.record(false);
  pill?.remove?.();
  pill = null;
}

export const isRecording = () => on;

/** Builds the session report from what record mode has collected so far. */
export function collectSession(title = 'tester session'): SessionData {
  const dom: Record<string, any> = {};
  for (const id of reins.panels()) dom[id] = inspect(globalThis, { panel: id, depth: 8, maxNodes: 400 });
  let state: Record<string, any> | null = null;
  try {
    state = reins.snapshot();
  } catch {}
  return buildSession({
    title,
    source: 'record',
    reinsVersion: VERSION,
    app: { url: state?.location, title: doc()?.title, platform: 'web' },
    actions: reins.actions(),
    state,
    network: reins.network(),
    errors: reins.errors(),
    perf: reins.perf(),
    dom,
  });
}

function download(name: string, text: string, type: string) {
  const d = doc();
  const U = (globalThis as any).URL;
  const a = d.createElement('a');
  a.href = U.createObjectURL(new Blob([text], { type }));
  a.download = name;
  d.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => U.revokeObjectURL(a.href), 1000);
}

/** Downloads `reins-session-<time>.md` and/or `.json`. Returns the session and the file names. */
export function exportSession(o: ExportOptions = {}): { session: SessionData; files: string[] } {
  const session = collectSession(o.title);
  const base = 'reins-session-' + session.createdAt.replace(/[:.]/g, '-');
  const fmt = o.format || 'both';
  const files: string[] = [];
  if (fmt !== 'json') download(files[files.push(base + '.md') - 1], renderMarkdown(session), 'text/markdown');
  if (fmt !== 'md') download(files[files.push(base + '.json') - 1], JSON.stringify(session, null, 2), 'application/json');
  return { session, files };
}
