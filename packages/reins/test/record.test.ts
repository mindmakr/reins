// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reins } from '@mindmakr/reins';
import { collectSession, exportSession, isRecording, recordFromUrl, startRecording, stopRecording } from '../src/record.js';
import * as stub from '../src/record-stub.js';

const read = (b: Blob) => new Promise<string>((res) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.readAsText(b);
});

afterEach(() => {
  stopRecording();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('@mindmakr/reins/record', () => {
  it('needs the tester to opt in through the URL', () => {
    expect(recordFromUrl()).toBe(false);
    expect(isRecording()).toBe(false);
    history.replaceState(null, '', '/?reins=record');
    expect(recordFromUrl()).toBe(true);
    expect(isRecording()).toBe(true);
    history.replaceState(null, '', '/');
  });

  it('shows the pill, records, and exports Markdown and JSON through a Blob link', async () => {
    document.body.innerHTML = '<div data-reins="invoice-list"><span>Invoices</span></div>';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(startRecording()).toBe(true);
    const pill = document.querySelector('[data-reins-record]')!;
    expect(pill.textContent).toContain('● Recording');
    expect(pill.textContent).toContain('Export');

    reins.markComponent('invoice-list');
    console.error('tester saw an error');
    const blobs: Blob[] = [];
    (URL as any).createObjectURL = vi.fn((b: Blob) => (blobs.push(b), 'blob:x'));
    (URL as any).revokeObjectURL = vi.fn();
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });

    const { session, files } = exportSession({ title: 'tester run' });
    expect(files).toEqual([expect.stringMatching(/^reins-session-.+\.md$/), expect.stringMatching(/^reins-session-.+\.json$/)]);
    expect(clicks).toEqual(files);
    expect(session.source).toBe('record');
    expect(session.panels.map((p) => p.id)).toContain('invoice-list');
    expect(session.errors[0].message).toContain('tester saw an error');
    const md = await read(blobs[0]);
    expect(md).toContain('# reins session: tester run');
    expect(md).toContain('record mode (tester export)');
    expect(JSON.parse(await read(blobs[1])).schemaVersion).toBe(1);
  });

  it('stops and removes the pill', () => {
    startRecording();
    stopRecording();
    expect(document.querySelector('[data-reins-record]')).toBeNull();
    expect(isRecording()).toBe(false);
  });

  it('does nothing in production builds', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(startRecording()).toBe(false);
    expect(document.querySelector('[data-reins-record]')).toBeNull();
  });

  it('collects a session with redacted state', () => {
    startRecording({ pill: false });
    const off = reins.state('auth', () => ({ user: 'tess', refreshToken: 'r1' }));
    expect(collectSession().state).toMatchObject({ auth: { user: 'tess', refreshToken: '[redacted]' } });
    off();
  });

  it('has a stub with the same API that does nothing', () => {
    expect(stub.startRecording()).toBe(false);
    expect(stub.recordFromUrl()).toBe(false);
    expect(stub.exportSession()).toEqual({ session: null, files: [] });
  });
});
