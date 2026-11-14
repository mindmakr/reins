// The flight report's renderers (design section 6): Markdown and a script-free HTML page, both pure functions of
// the report data (no clock, no I/O), and the compare of two saved reports by finding key. A report leads with at
// most five findings; the rest are under "Everything else", and resolved ones under "Resolved in this period".
// Every string from the app or a saved file is escaped. Process keys are never rendered: they stay in the report
// object a server returns (design C6).
// Imports: reins' shared modules only (the flight safety test walks this file).
import { duration, type FlightFinding } from './findings.js';
import { type FlightReport, type PromiseReport, reasonText, REPORT_FORMAT, REPORT_LEAD, REPORT_VERSION } from './report.js';

// ---- shared ----------------------------------------------------------------------------------------------------

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A string from the report on one line: control characters and line breaks become spaces. */
const line = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');
const when = (t: unknown) => {
  const n = num(t);
  return n === null ? 'unknown' : new Date(n).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
};
const ms = (v: unknown) => {
  const n = num(v);
  return n === null ? '' : duration(n);
};
const count = (n: unknown, one: string, many = `${one}s`) => {
  const x = num(n) ?? 0;
  return `${x} ${x === 1 ? one : many}`;
};

/** The findings a report leads with, the rest, and those resolved in its period. */
function parts(r: FlightReport) {
  const open = arr<FlightFinding>(r.findings);
  return { lead: open.slice(0, REPORT_LEAD), rest: open.slice(REPORT_LEAD), resolved: arr<FlightFinding>(r.resolved) };
}

const PROMISE_STATE: Record<string, string> = { held: 'held', broken: 'broken', 'not-checked': 'not checked' };
const stateOf = (s: unknown) => (typeof s === 'string' && Object.prototype.hasOwnProperty.call(PROMISE_STATE, s) ? PROMISE_STATE[s] : 'unknown');

/** A promise's state in a few words. */
function promiseState(p: PromiseReport): string {
  if (p.state === 'broken') return `broken by ${count(p.count, 'run')}`;
  if (p.state === 'held') return num(p.lateCount) ? `held (${count(p.lateCount, 'run')} late)` : 'held';
  if (p.state === 'not-checked') return `not checked: ${reasonText(p.reason)}`;
  return stateOf(p.state);
}

function probeState(p: { state: unknown; reason?: unknown }): string {
  if (p.state === 'broken') return `broken: ${p.reason === 'threw' ? 'it threw' : p.reason === 'timeout' ? 'it ran past its time limit' : 'it did not return { ok: true }'}`;
  if (p.state === 'not-checked') return `not checked: ${reasonText(typeof p.reason === 'string' ? p.reason : undefined)}`;
  return stateOf(p.state);
}

/** The figures under a finding's text: how many, when, and what it is about. */
function findingFacts(f: FlightFinding): string {
  const out = [`Count ${num(f.count) ?? 0}`, `first ${when(f.firstAt)}`, `last ${when(f.lastAt)}`];
  if (f.state === 'resolved') out.push(`resolved ${when(f.resolvedAt)}`);
  if (f.process) out.push(`process ${line(f.process)}`);
  const tags = arr<unknown>(f.tags).map(line);
  if (tags.length) out.push(`tags: ${tags.join(', ')}`);
  return out.join(' · ') + '.';
}

// ---- Markdown --------------------------------------------------------------------------------------------------

/** App text in Markdown: on one line, with the characters that make links, images, HTML or table cells escaped. */
const md = (v: unknown) => line(v).replace(/[\\[\]<>|*_]/g, '\\$&');
/** A code span that holds any text: a fence longer than any run of backticks in it. */
function code(v: unknown): string {
  const s = line(v);
  const run = Math.max(0, ...(s.match(/`+/g) || []).map((x) => x.length));
  const fence = '`'.repeat(run + 1);
  return `${fence}${/^`|`$/.test(s) ? ` ${s} ` : s}${fence}`;
}
const table = (head: string[], rows: string[][]) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n') : '_None._');
const bullets = (l: string[]) => (l.length ? l.map((x) => `- ${md(x)}`).join('\n') : '- None.');

/**
 * One finding as Markdown, with its stable key, so it can be attached as evidence (design G5). Process keys are
 * not in it.
 */
export function findingMarkdown(f: FlightFinding): string {
  const out = [`- **${md(f.level)} · ${md(f.kind)}** ${code(f.key)}: ${md(f.text)}`, `  ${md(findingFacts(f))}`];
  if (f.why) out.push(`  Why: ${md(f.why)}`);
  if (f.source) out.push(`  Source: ${md(f.source)}`);
  return out.join('\n');
}

const findingList = (l: FlightFinding[], none: string) => (l.length ? l.map(findingMarkdown).join('\n') : none);

/** The report as Markdown (pure). */
export function renderFlightMarkdown(r: FlightReport): string {
  const { lead, rest, resolved } = parts(r);
  const w = r.window || ({} as FlightReport['window']);
  const out: string[] = [`# reins flight report: ${md(r.service)}`, ''];
  out.push(
    `From ${when(w.from)} to ${when(w.to)}${num(w.from) !== null && num(w.to) !== null ? ` (${duration(w.to - w.from)})` : ''}. Findings as of the last checker pass${r.findingsAt ? ` at ${when(r.findingsAt)}` : ': none yet'}; promises, probes, basics and processes as of ${when(r.at)}.`,
    '',
  );
  out.push(`## Findings`, '', findingList(lead, 'No open findings.'), '');
  if (rest.length) out.push(`## Everything else`, '', findingList(rest, ''), '');
  out.push(`## Resolved in this period`, '', findingList(resolved, '- None.'), '');

  out.push(`## Processes`, '');
  const procs = arr<FlightReport['processes'][number]>(r.processes);
  if (!procs.length) out.push('_None._', '');
  for (const p of procs) {
    const ends = Object.entries(p.byEnd && typeof p.byEnd === 'object' ? p.byEnd : {}).map(([k, v]) => `${md(k)} ${num(v) ?? 0}`);
    out.push(`### ${md(p.name)}${p.declared ? '' : ' (not in the manifest)'}`, '');
    out.push(
      `Started ${num(p.started) ?? 0} · in progress ${p.inProgress === null ? 'not counted' : (num(p.inProgress) ?? 0)} · ended ${num(p.ended) ?? 0}${ends.length ? ` (${ends.join(', ')})` : ''}${num(p.partial) ? ` · ${count(p.partial, 'run')} partly removed by retention` : ''}.`,
      '',
    );
    out.push(table(['Step', 'Recorded', 'From start, p50', 'p95'], arr<FlightReport['processes'][number]['steps'][number]>(p.steps).map((s) => [`${md(s.step)}${s.end ? ' (end)' : ''}${s.declared ? '' : ' (not declared)'}`, String(num(s.count) ?? 0), ms(s.p50Ms), ms(s.p95Ms)])));
    if (num(p.moreSteps)) out.push('', `_${count(p.moreSteps, 'more step')} not shown._`);
    out.push('');
  }

  out.push(`## Promises`, '');
  out.push(table(['Promise', 'State', 'Runs', 'Window'], arr<PromiseReport>(r.promises).map((p) => [`${md(p.process)} / ${md(p.id)}`, md(promiseState(p)), String(num(p.runs) ?? 0), ms(p.windowMs)])), '');
  out.push(`## Probes`, '');
  out.push(table(['Probe', 'State', 'Every', 'Last result'], arr<FlightReport['probes'][number]>(r.probes).map((p) => [md(p.id), md(probeState(p)), ms(p.everyMs), p.lastAt ? when(p.lastAt) : 'none'])), '');

  const b = r.basics || ({} as FlightReport['basics']);
  out.push(`## Basics`, '');
  out.push(
    `In the last ${ms(b.windowMs) || 'window'}: ${count(b.requests, 'request')}, ${num(b.failed) ?? 0} failed, from ${count(b.instances, 'instance')}${num(b.loopP99Ms) !== null ? `; event loop p99 up to ${ms(b.loopP99Ms)}` : ''}${num(b.heapUsedMb) !== null ? `; heap up to ${Math.round(b.heapUsedMb!)} MB` : ''}.`,
    '',
  );
  const fig = (l: unknown) => arr<FlightReport['basics']['routes'][number]>(l).map((x) => [md(x.name), String(num(x.count) ?? 0), String(num(x.errors) ?? 0), ms(x.p95Ms)]);
  if (arr(b.routes).length) out.push(table(['Route', 'Requests', 'Failed', 'p95'], fig(b.routes)), '');
  if (arr(b.upstream).length) out.push(table(['Upstream host', 'Calls', 'Failed', 'p95'], fig(b.upstream)), '');
  out.push(arr<FlightReport['basics']['checks'][number]>(b.checks).map((c) => `- ${c.state === 'finding' ? '**Finding**' : c.state === 'fine' ? 'Fine' : 'Not judged'}: ${md(c.text)}`).join('\n') || '- None.', '');

  out.push(`## Development instruments`, '', md(devLine(r)), '');
  out.push(`## Checked and found fine`, '', bullets(arr<string>(r.checked)), '');
  out.push(`## Not checked`, '', bullets(arr<string>(r.notChecked)), '');
  return out.join('\n');
}

function devLine(r: FlightReport): string {
  const d = r.dev || ({} as FlightReport['dev']);
  if (d.off) return d.thisProcess ? 'Off: @mindmakr/reins/node is not loaded in this process, and no instance in production reported it in the window.' : 'Off: no instance in production reported @mindmakr/reins/node loaded in the window.';
  const where = [d.thisProcess?.devModuleLoaded ? 'in this process' : '', num(d.instances) ? `on ${count(d.instances, 'instance')} in production` : ''].filter(Boolean).join(' and ');
  return `On: @mindmakr/reins/node is loaded ${where || 'somewhere this report can see'}. Only @mindmakr/reins/flight belongs in production (see the security finding).`;
}

// ---- HTML ------------------------------------------------------------------------------------------------------

/** Text for HTML: every character that could start markup or end an attribute is an entity. */
const h = (v: unknown) => line(v).replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
const tbl = (head: string[], rows: string[][]) =>
  rows.length ? `<table><thead><tr>${head.map((x) => `<th scope="col">${h(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="muted">None.</p>';
const list = (l: string[]) => (l.length ? `<ul class="plain">${l.map((x) => `<li>${h(x)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>');
const LEVELS = new Set(['error', 'warn']);

function findingHtml(f: FlightFinding): string {
  const level = LEVELS.has(f.level) ? f.level : 'warn';
  const extra = [f.why ? `<p class="why">Why: ${h(f.why)}</p>` : '', f.source ? `<p class="muted small">Source: ${h(f.source)}</p>` : ''].join('');
  return `<li class="finding ${level}${f.state === 'resolved' ? ' resolved' : ''}"><p class="head"><span class="badge ${level}">${h(f.level)}</span> <span class="kind">${h(f.kind)}</span> <code>${h(f.key)}</code></p><p class="text">${h(f.text)}</p><p class="muted small">${h(findingFacts(f))}</p>${extra}</li>`;
}
const findingsHtml = (l: FlightFinding[], none: string) => (l.length ? `<ul class="findings">${l.map(findingHtml).join('')}</ul>` : `<p class="muted">${h(none)}</p>`);

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5b6170;--line:#dde0e6;--err:#b42318;--err-bg:#fdecea;--warn:#8a5a00;--warn-bg:#fff4dc;--ok:#1d7a46;--code:#eef0f4}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--ink:#e8eaef;--muted:#a0a6b4;--line:#2c313c;--err:#ff8a80;--err-bg:#3a1d1b;--warn:#ffc966;--warn-bg:#352a12;--ok:#6fd49b;--code:#252a33}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}
main{max-width:1040px;margin:0 auto;padding:16px 16px 40px}
h1{font-size:22px;margin:4px 0 6px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:28px 0 10px}
h3{font-size:16px;margin:0 0 6px}
p{margin:0 0 8px}
.muted{color:var(--muted)}
.small{font-size:13px}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere;word-break:break-all}
ul.findings,ul.plain{list-style:none;margin:0;padding:0}
ul.plain li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:0 0 6px}
.finding{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:8px;padding:10px 12px;margin:0 0 8px}
.finding.error{border-left-color:var(--err)}
.finding.resolved{border-left-color:var(--ok)}
.finding .head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 4px}
.finding .text{font-size:15px}
.badge{font-size:12px;font-weight:600;text-transform:uppercase;padding:1px 8px;border-radius:999px}
.badge.error{background:var(--err-bg);color:var(--err)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.kind{font-size:13px;color:var(--muted)}
.why{font-style:italic}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:0 0 10px}
table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{font-size:12px;color:var(--muted);font-weight:600}
th:first-child{width:40%}
td.n,th.n{text-align:right}
.state-fine{color:var(--ok)}
.state-finding{color:var(--err)}
.state-not-judged{color:var(--muted)}
@media (max-width:520px){body{font-size:14px}th,td{padding:5px 4px}table{font-size:13px}}
`;

/**
 * The report as one HTML page (pure): no script, no event attribute, no external resource (styles inline, and a
 * policy that forbids loading anything), readable at phone and desktop widths, in light and dark.
 */
export function renderFlightHtml(r: FlightReport): string {
  const { lead, rest, resolved } = parts(r);
  const w = r.window || ({} as FlightReport['window']);
  const b = r.basics || ({} as FlightReport['basics']);
  const sec: string[] = [];
  sec.push(`<section><h2>Findings</h2>${findingsHtml(lead, 'No open findings.')}</section>`);
  if (rest.length) sec.push(`<section><h2>Everything else</h2>${findingsHtml(rest, '')}</section>`);
  sec.push(`<section><h2>Resolved in this period</h2>${findingsHtml(resolved, 'None.')}</section>`);

  const procs = arr<FlightReport['processes'][number]>(r.processes).map((p) => {
    const ends = Object.entries(p.byEnd && typeof p.byEnd === 'object' ? p.byEnd : {}).map(([k, v]) => `${h(k)} ${num(v) ?? 0}`);
    const rows = arr<FlightReport['processes'][number]['steps'][number]>(p.steps).map((s) => [
      `${h(s.step)}${s.end ? ' <span class="muted small">(end)</span>' : ''}${s.declared ? '' : ' <span class="muted small">(not declared)</span>'}`,
      String(num(s.count) ?? 0),
      h(ms(s.p50Ms)),
      h(ms(s.p95Ms)),
    ]);
    return `<div class="card"><h3>${h(p.name)}${p.declared ? '' : ' <span class="muted small">(not in the manifest)</span>'}</h3><p>Started ${num(p.started) ?? 0} · in progress ${p.inProgress === null ? 'not counted' : (num(p.inProgress) ?? 0)} · ended ${num(p.ended) ?? 0}${ends.length ? ` (${ends.join(', ')})` : ''}${num(p.partial) ? ` · ${h(count(p.partial, 'run'))} partly removed by retention` : ''}</p>${tbl(['Step', 'Recorded', 'From start, p50', 'p95'], rows)}${num(p.moreSteps) ? `<p class="muted small">${h(count(p.moreSteps, 'more step'))} not shown.</p>` : ''}</div>`;
  });
  sec.push(`<section><h2>Processes</h2>${procs.join('') || '<p class="muted">None.</p>'}</section>`);
  sec.push(`<section><h2>Promises</h2>${tbl(['Promise', 'State', 'Runs', 'Window'], arr<PromiseReport>(r.promises).map((p) => [`${h(p.process)} / ${h(p.id)}`, h(promiseState(p)), String(num(p.runs) ?? 0), h(ms(p.windowMs))]))}</section>`);
  sec.push(`<section><h2>Probes</h2>${tbl(['Probe', 'State', 'Every', 'Last result'], arr<FlightReport['probes'][number]>(r.probes).map((p) => [h(p.id), h(probeState(p)), h(ms(p.everyMs)), h(p.lastAt ? when(p.lastAt) : 'none')]))}</section>`);

  const fig = (l: unknown) => arr<FlightReport['basics']['routes'][number]>(l).map((x) => [h(x.name), String(num(x.count) ?? 0), String(num(x.errors) ?? 0), h(ms(x.p95Ms))]);
  const checks = arr<FlightReport['basics']['checks'][number]>(b.checks).map((c) => {
    const st = c.state === 'finding' || c.state === 'fine' ? c.state : 'not-judged';
    return `<li><span class="state-${st}">${st === 'finding' ? 'Finding' : st === 'fine' ? 'Fine' : 'Not judged'}</span>: ${h(c.text)}</li>`;
  });
  sec.push(
    `<section><h2>Basics</h2><p>In the last ${h(ms(b.windowMs) || 'window')}: ${h(count(b.requests, 'request'))}, ${num(b.failed) ?? 0} failed, from ${h(count(b.instances, 'instance'))}${num(b.loopP99Ms) !== null ? `; event loop p99 up to ${h(ms(b.loopP99Ms))}` : ''}${num(b.heapUsedMb) !== null ? `; heap up to ${Math.round(b.heapUsedMb!)} MB` : ''}.</p>${arr(b.routes).length ? tbl(['Route', 'Requests', 'Failed', 'p95'], fig(b.routes)) : ''}${arr(b.upstream).length ? tbl(['Upstream host', 'Calls', 'Failed', 'p95'], fig(b.upstream)) : ''}<ul class="plain">${checks.join('')}</ul></section>`,
  );
  sec.push(`<section><h2>Development instruments</h2><p class="card">${h(devLine(r))}</p></section>`);
  sec.push(`<section><h2>Checked and found fine</h2>${list(arr<string>(r.checked))}</section>`);
  sec.push(`<section><h2>Not checked</h2>${list(arr<string>(r.notChecked))}</section>`);

  const range = `From ${when(w.from)} to ${when(w.to)}${num(w.from) !== null && num(w.to) !== null ? ` (${duration(w.to - w.from)})` : ''}.`;
  const asOf = `Findings as of the last checker pass${r.findingsAt ? ` at ${when(r.findingsAt)}` : ': none yet'}; promises, probes, basics and processes as of ${when(r.at)}.`;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>reins flight: ${h(r.service)}</title>`,
    `<style>${CSS}</style>`,
    '</head><body><main>',
    `<p class="muted small">reins flight report</p><h1>${h(r.service)}</h1><p class="muted small">${h(range)} ${h(asOf)}</p>`,
    ...sec,
    '</main></body></html>',
    '',
  ].join('\n');
}

// ---- saved reports and compare ---------------------------------------------------------------------------------

/** Reads a saved report (the JSON of `flight.report()` or `reins flight report --json`). Throws a plain message. */
export function parseFlightReport(text: string): FlightReport {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('is not JSON');
  }
  if (!v || typeof v !== 'object' || v.format !== REPORT_FORMAT) throw new Error(`is not a flight report (no "format": "${REPORT_FORMAT}")`);
  if (v.version !== REPORT_VERSION) throw new Error(`is a flight report of version ${line(v.version).slice(0, 20)}; this reins reads version ${REPORT_VERSION}`);
  if (!Array.isArray(v.findings)) throw new Error('has no findings list');
  for (const f of [...v.findings, ...arr(v.resolved)]) if (!f || typeof f !== 'object' || typeof f.key !== 'string') throw new Error('has a finding without a key');
  return { ...v, service: line(v.service).slice(0, 200) } as FlightReport;
}

export interface FlightCompare {
  markdown: string;
  /** Open in the first report and not open in the second. */
  resolved: FlightFinding[];
  /** Open in the second report and not open in the first. */
  newFindings: FlightFinding[];
  /** Open in both. */
  still: FlightFinding[];
}

/** Which findings a change resolved and which are new, by key, as `reins report --compare` works (pure). */
export function compareFlightReports(before: FlightReport, after: FlightReport): FlightCompare {
  const fb = arr<FlightFinding>(before.findings);
  const fa = arr<FlightFinding>(after.findings);
  const kb = new Set(fb.map((x) => x.key));
  const ka = new Set(fa.map((x) => x.key));
  const resolved = fb.filter((x) => !ka.has(x.key));
  const newFindings = fa.filter((x) => !kb.has(x.key));
  const still = fa.filter((x) => kb.has(x.key));
  const items = (l: FlightFinding[]) => (l.length ? l.map((x) => `- ${code(x.key)} (${md(x.level)} · ${md(x.kind)}): ${md(x.text)}`).join('\n') : '- None.');
  const markdown = [
    `# reins flight compare: ${md(before.service)} → ${md(after.service)}`,
    '',
    `Before: report of ${when(before.at)}. After: report of ${when(after.at)}. Findings are matched by key.`,
    '',
    '## Resolved',
    '',
    items(resolved),
    '',
    '## New',
    '',
    items(newFindings),
    '',
    '## Still open',
    '',
    items(still),
    '',
  ].join('\n');
  return { markdown, resolved, newFindings, still };
}
