# reins

Give coding agents the reins: a small library and agent skill to drive, inspect and debug your web and Expo apps in development, with one report-only entry, flight, for production servers. Built for [**Lucid Coding**](https://mindmakr.github.io/coordinator/lucid-coding.html), and the companion to [**Coordinator**](https://mindmakr.github.io/coordinator/) ([`mindmakr/coordinator`](https://github.com/mindmakr/coordinator)).

**[Live site & docs → mindmakr.github.io/reins](https://mindmakr.github.io/reins/)** · **[Official examples → mindmakr/reins-examples](https://github.com/mindmakr/reins-examples)**

An AI coding agent that tests your app usually clicks by pixels and guesses what happened. **reins** gives the agent real instruments inside the app: you register a few named actions ("log in as the tester", "switch to Arabic"), point at some state, and mark the panels worth looking at. The agent then calls those actions, reads redacted state, inspects page lifecycle and component mount/render timings (`reins_perf`), checks DOM bounding boxes and computed CSS layout with automatic clipping flags (`reins_dom`), sees recent network calls and errors, and takes pixel-exact pictures of a panel (`reins_snap`). All of it goes through an MCP server on your machine.

**Production builds contain no development reins, and the flight entry (`@mindmakr/reins/flight`) is the only part meant for production.** The development tools are for development and test builds: production builds swap them for an empty stub, and `reins verify` fails the build if any development reins code is left. Flight runs on a Node server in production and only records, checks and reports: it has no actions, no pairing, no port and no route ([Flight](#flight-report-only-checks-on-a-production-server)).

- **One package (`npm i -D @mindmakr/reins` for the development tools; `npm i @mindmakr/reins` when a server uses flight)** includes the core, React & Expo hooks, Vite/Next/Metro plugins, the MCP bridge (`npx reins bridge`) and the bundle verifier (`npx reins verify`).
- **The browser/RN core (`@mindmakr/reins`) is under 5 KB min+gzip** and has zero browser runtime dependencies.
- **Agent skill included:** install the Claude Code plugin (or skill folder) and run `/reins:setup`—your agent inspects your repo and wires everything for you.
- **Inert until paired:** it does nothing until it pairs with the bridge on your machine using a one-time token.

## New here? Paste one prompt

You don't need to understand MCP, bridges or bundlers. Paste this into your coding agent (Claude Code, Codex, Antigravity, Cursor, Gemini CLI) inside your web or Expo project:

```text
Set up reins in this project using the reins skill from https://github.com/mindmakr/reins
(in Claude Code: /plugin marketplace add mindmakr/reins, then /plugin install reins@reins, then /reins:setup).
Register actions for the main things a tester does, wrap the main screens in ReinsPanel,
and make sure the production build passes `reins verify`. Then start the app,
drive it with the reins tools, and show me screenshots, the reins_perf numbers and any errors.

Also install Coordinator from https://github.com/mindmakr/coordinator and run its init,
so every change you make from now on is checked by a separate critic.
```

What you get back: screenshots of your screens in each language and theme, how fast the page and each panel appeared, how long each API call took, and any layout that is clipped or broken. Your agent gets the same numbers, so it can fix what it finds instead of guessing from a picture.

### Why this matters for vibe-coded apps

Your agent can make a screen that looks right. It can't see that the screen took 3 seconds, rendered 40 times, called the same API five times, or cut off the Arabic text, unless something inside the app tells it. reins is that something, in development; on a production server, its flight entry reports what the server's long-running work did, and changes nothing. [Coordinator](https://github.com/mindmakr/coordinator) adds the other half: a second agent that checks every change against a bar you agreed, with these numbers as evidence. Together they matter most when the first version is done and you need to refactor, fix or hand it over without breaking what works.

## Let your agent set it up (`/reins:setup`)

In Claude Code, install the **reins** plugin:

```text
/plugin install reins --marketplace mindmakr/reins
```

Or in two steps:

```text
/plugin marketplace add mindmakr/reins
/plugin install reins@reins
```

Then in any new or existing Vite, Next.js, React or Expo project:

- `/reins:setup` — inspects your project, installs `@mindmakr/reins`, wires `@mindmakr/reins/vite`, `@mindmakr/reins/next` or `@mindmakr/reins/metro` (and `@mindmakr/reins/node` if you have a Node backend), adds dev-only `reins.connect()`, hooks up state adapters and high-value actions, wraps key screens in `<ReinsPanel>`, adds `reins verify` to your build script, and configures `.mcp.json`.
- `/reins:drive` — drives your paired app and server through the bridge's MCP tools (`reins_list_actions`, `reins_run_action`, `reins_state`, `reins_network`, `reins_errors`, `reins_panel_box`, `reins_snap`, `reins_perf`, `reins_dom`, `reins_server`, `reins_report`).
- `/reins:verify` — runs your production build and verifies zero `reins` dev code shipped.
- `/reins:flight` — adds report-only production checks to a Node server with `@mindmakr/reins/flight`, after you approve its manifest of processes and promises, and reads its flight report.

In OpenAI Codex CLI, Cursor or Antigravity: copy `skills/reins/` into `.agents/skills/` (or `~/.gemini/config/skills/`) and ask the agent to follow the `reins` skill.

## What's in `@mindmakr/reins`

Everything ships in the single `@mindmakr/reins` package:

| Import / CLI | What it does |
| --- | --- |
| `@mindmakr/reins` | The core (< 5 KB min+gzip, 0 browser deps): actions, state, network and error buffers, panels, `perf()`, `dom()` (its inspector loads on the first call), `markComponent()`, WebMCP. |
| `@mindmakr/reins/react` | `useReinsAction`, `useReinsState`, `<ReinsPanel id>` (automatically tracks mount time & render count). |
| `@mindmakr/reins/expo` | React Native glue: `connectExpo()`, `<ReinsPanel id>` with `testID`, `useReinsPanel`, `useReinsAction`, `useReinsState`. |
| `@mindmakr/reins/node` | Node backend instrumentation (Express/Connect `middleware()`, `wrapHandler()`, `fastify()`, `span('db.*')`, `Server-Timing`, outbound `undici` fetches, event-loop p50/p99/max), joined with browser fetches via `x-reins-trace`. |
| `@mindmakr/reins/flight` | The only part meant for production (Node only): records the steps of a server's processes, checks them against the promises in `reins.flight.json`, and reports findings to sinks and a report. Report only, no port, no route. |
| `@mindmakr/reins/record` | Opt-in tester recording (`recordFromUrl()` via `?reins=record`, or `startRecording()`) to export `.md` + `.json` session reports in dev or private staging (`REINS_ENABLE=1`) without a bridge. |
| `@mindmakr/reins/report` | Isomorphic session report builder, plain-language `findings()` detector, Markdown renderer, and `compareSessions()` diff. |
| `@mindmakr/reins/adapters` | `zustand`, `redux`, `reactQuery`, `routerLocation`, `fromStore`. |
| `@mindmakr/reins/vite` | Vite plugin: serves `/__reins/token` in dev, swaps `@mindmakr/reins` and `@mindmakr/reins/record` for 0-marker stubs in production builds. |
| `@mindmakr/reins/next` & `@mindmakr/reins/next/token-route` | `withReins(nextConfig)` (Webpack + Turbopack) and the `GET` token route handler. |
| `@mindmakr/reins/metro` (or `@mindmakr/reins/expo/metro`) | `withReins(metroConfig)` for Expo and React Native. |
| `npx reins bridge` | The localhost (`127.0.0.1:7357`) WebSocket pairing hub and stdio MCP server (12 tools, including the read-only `reins_flight`). |
| `npx reins report [--compare a.json b.json]` | Renders a saved session as Markdown or prints a before/after regression table of metrics, per-URL latency, panel renders, and resolved/new findings. |
| `npx reins flight check \| report \| watch` | Checks a flight manifest, prints or compares flight reports, and runs the flight checker beside a server. |
| `npx reins verify <dir>` (`reins-verify-bundle`) | Fails if `__REINS_DEV_ONLY__` is found anywhere in a production build output folder. |

## Five-minute setup (by hand)

### Vite + React

```sh
npm i -D @mindmakr/reins
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import reins from '@mindmakr/reins/vite';

export default defineConfig({ plugins: [reins(), react()] });
```

`src/main.tsx`:

```ts
import { reins } from '@mindmakr/reins';
import { zustand } from '@mindmakr/reins/adapters';
import { useAppStore } from './store';

if (import.meta.env.DEV) {
  reins.state('app', zustand(useAppStore));
  reins.connect(); // fetches the token from /__reins/token, then pairs
}
```

In a component:

```tsx
import { useReinsAction, ReinsPanel } from '@mindmakr/reins/react';

export function Settings() {
  const { setLocale } = useI18n();
  useReinsAction({
    name: 'set-locale',
    description: 'Switch the UI language',
    input: { type: 'object', properties: { locale: { type: 'string', enum: ['en', 'ar', 'fr'] } }, required: ['locale'] },
    run: ({ locale }) => setLocale(locale),
  });
  return <ReinsPanel id="settings">…</ReinsPanel>;
}
```

Add the check to your build script: `"build": "vite build && reins verify dist"`.

### Next.js (App Router)

```sh
npm i -D @mindmakr/reins
```

`next.config.mjs`:

```js
import { withReins } from '@mindmakr/reins/next';
export default withReins({ /* your config */ });
```

`app/api/reins-token/route.ts`:

```ts
export { GET } from '@mindmakr/reins/next/token-route';
export const dynamic = 'force-dynamic';
```

A client component mounted once, for example in your root layout:

```tsx
'use client';
import { useEffect } from 'react';
import { reins } from '@mindmakr/reins';

export function Reins() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') reins.connect({ tokenUrl: '/api/reins-token' });
  }, []);
  return null;
}
```

Check the output: `"build": "next build && reins verify .next/static"`.

### Expo

```sh
npx expo install @mindmakr/reins
```

`metro.config.js`:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withReins } = require('@mindmakr/reins/metro');
module.exports = withReins(getDefaultConfig(__dirname));
```

`App.tsx`:

```tsx
import { connectExpo, ReinsPanel, useReinsAction } from '@mindmakr/reins/expo';

if (__DEV__) connectExpo();

export default function App() {
  useReinsAction({ name: 'open-cart', description: 'Open the cart screen', run: () => navigation.navigate('Cart') });
  return <ReinsPanel id="home">…</ReinsPanel>;
}
```

The bridge only listens on `127.0.0.1`. The iOS simulator shares your machine's loopback, so that just works. For an Android emulator or a USB device, run `adb reverse tcp:7357 tcp:7357`. Phones on Wi-Fi cannot reach the bridge, on purpose.

Check the export: `npx expo export && npx reins verify dist`.

> [!NOTE]
> `@mindmakr/reins/metro` loads ESM with `require`, which needs Node 20.19 or newer, or 22.12 or newer. Metro must have package exports turned on, which is the default from Expo SDK 53.

### Run the bridge and connect your agent

Add reins as an MCP server in your agent. For example, in `.mcp.json` (Claude Code) or your agent's MCP settings:

```json
{
  "mcpServers": {
    "reins": { "command": "npx", "args": ["reins", "bridge"] }
  }
}
```

The agent starts the bridge for you. You can also start it yourself with `npx reins bridge --no-mcp` to watch it. The bridge writes a fresh token to `.reins/token`. Your dev server serves that file to the page, and the page pairs.

Options: `--port`, `--dir`, `--origin <exact origin>` (extra allowed page origins), `--cdp <url>` (for `reins_snap` in a browser), `--no-rotate`, `--no-mcp`, `--browser-only`.

## How an agent uses it

| Tool | What it returns |
| --- | --- |
| `reins_list_actions` | The paired app, its actions with input schemas, state sources and panels. Call this first. |
| `reins_run_action` | Runs one action: `{ name, input, confirm? }`. |
| `reins_state` | A redacted snapshot of one state source or all of them. |
| `reins_network` | Recent fetch calls: method, URL, status, `startMs`, `ms`, redacted headers and bodies. |
| `reins_errors` | Recent console errors, uncaught errors and unhandled rejections. |
| `reins_panel_box` | A panel's box in CSS pixels, with `devicePixelRatio`. |
| `reins_snap` | A pixel-exact PNG of a panel under `.reins/snaps/`, and optionally a copy on the clipboard. |
| `reins_perf` | Page lifecycle timings (`ttfbMs`, `firstPaintMs`, `firstContentfulPaintMs`, `domInteractiveMs`, `domContentLoadedMs`, `loadMs`), `<ReinsPanel>` mount times and render counts, API call latency stats, and a unified millisecond timeline (with paired `@mindmakr/reins/node` server spans joined by `x-reins-trace`). |
| `reins_dom` | Inspects a panel or CSS selector's DOM subtree, bounding boxes, computed CSS styles (`direction`, `display`, `flexDirection`, `overflowX`, etc.), and automatic layout issue flags (`horizontal-clip`, `vertical-clip`, `zero-size`). |
| `reins_server` | When a Node dev server is paired via `@mindmakr/reins/node`: recent inbound requests with `dbMs`, `spans` (such as `db.line_items.select ×6`), outbound upstream fetches, `traceId` matching `reins_network`, slowest routes, and runtime stats (event-loop delay `p50`/`p99`/`max`, RSS/heap). |
| `reins_report` | Gathers everything (actions, redacted state, network, errors, joined frontend+backend `reins_perf` timeline, per-panel DOM layout issues, screenshots, audit log) into `.reins/sessions/<time>-<slug>.md` and `.json` with automatic plain-language findings (slow APIs, duplicate calls, N+1 server spans, excess renders, layout clips). Compare before and after a fix with `npx reins report --compare before.json after.json`. |
| `reins_flight` | Read only, needs no paired app: the flight report from a saved report file or the file store under the project (default `.reins/flight`), as Markdown and data. Process keys only with `keys: true`. |

### Backend instrumentation (`@mindmakr/reins/node`) and tester session exports (`@mindmakr/reins/record`)

- **Backend (`@mindmakr/reins/node`)**: In Express, Connect, Fastify or `http.createServer`, call `reinsNode.connect({ meta: { name: 'api' } })` in dev mode, add `reinsNode.middleware({ serverTiming: true })` (or `reinsNode.wrapHandler(handler, { serverTiming: true })`), and wrap database calls in `reinsNode.span('db.invoices.select', () => ...)`. Same-origin browser `fetch` calls carry `x-reins-trace`, so `reins_perf` and `reins_report` place server spans right inside the browser call that triggered them—and `Server-Timing` headers let an in-app dev HUD display live `db` and `app` latency.
- **Tester recording (`@mindmakr/reins/record`)**: Import `recordFromUrl()` from `'@mindmakr/reins/record'` in your dev or private staging (`REINS_ENABLE=1`) entry. Opening `?reins=record` mounts a tiny `● Recording · Export` pill so a QA tester can click through a bug and download `reins-session-<time>.md` and `.json` for an agent to diagnose—no MCP bridge required on the tester's machine. Production builds swap `@mindmakr/reins/record` for `@mindmakr/reins/record-stub`.

A typical loop: list actions, run `login-as-tester`, run `set-locale` with `ar`, check `reins_errors` is empty, inspect `reins_perf` (mount times, render counts, API latency) and `reins_dom` (confirm `direction: "rtl"` and `issues: []`), then `reins_snap` the `checkout` panel and compare it with the design.

`reins_snap` in a browser uses Playwright, if it is installed, over the Chrome DevTools Protocol. Start Chrome with `--remote-debugging-port=9222` and the bridge with `--cdp http://127.0.0.1:9222`. On Android it captures the screen with `adb` and returns the panel's box in device pixels. Otherwise it returns the box, so the agent's own browser tool can clip a screenshot to it.

People get the same handle in DevTools once the page is paired: `__reins__.actions()`, `__reins__.run('set-locale', { locale: 'ar' })`, `__reins__.state()`, `__reins__.network()`, `__reins__.perf()`, `await __reins__.dom({ panel: 'checkout' })`. Each action run also records a `performance.measure` entry.

If the browser supports [WebMCP](https://github.com/webmachinelearning/webmcp) (`navigator.modelContext` or `document.modelContext`), reins also registers each action as a WebMCP tool. Read-only actions get `readOnlyHint`. Consequential ones get `destructiveHint` and a required `confirm` input.

## Flight: report-only checks on a production server

`@mindmakr/reins/flight` is the only part of reins meant for production. It runs in a Node server, records the steps of the server's long-running work (a payout, an import, a webhook), checks them against promises written in `reins.flight.json`, and tells sinks and a report when behaviour has drifted, is drifting or looks unusual. It only reports: it never retries, restarts, rolls back or blocks anything, and it opens no port and registers no route. Design: [`docs/design/flight.md`](docs/design/flight.md). Safety rules and their tests: [SECURITY.md](SECURITY.md#flight-mindmakrreinsflight). An agent can set it up with `/reins:flight`.

**Install it as a regular dependency**, because it runs in production and a production install (`npm ci --omit=dev`) leaves dev dependencies out:

```sh
npm i @mindmakr/reins
```

This also installs `ws` and `@modelcontextprotocol/sdk`, which only `npx reins bridge` uses. The flight entry never loads them. Flight is ESM only: with `import` it needs Node 18 or newer; with `require`, Node 20.19 or 22.12 and newer.

### The config module

The app owns one small module that builds flight's options from the environment: the store, the sinks and, for the watcher, the server's health address. The server passes it to `flight.start()`, and `reins flight watch` and `reins flight report --config` load the same module, so a store or sink is defined once. Addresses and secrets come from the environment, never from the manifest.

```js
// flight.config.mjs
import pg from 'pg';
import { fileSink, fileStore, pgStore, webhookSink } from '@mindmakr/reins/flight';

const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;

export default {
  // Several server copies share Postgres; one machine can use the file store under .reins/flight/.
  store: pool ? pgStore({ query: (text, params) => pool.query(text, params) }) : fileStore(),
  // The webhook is added only when both variables are set, so a local run does not keep failing a send.
  sinks: [...(process.env.FLIGHT_WEBHOOK_URL && process.env.FLIGHT_WEBHOOK_SECRET ? [webhookSink({ url: process.env.FLIGHT_WEBHOOK_URL, secret: process.env.FLIGHT_WEBHOOK_SECRET })] : []), fileSink()],
  healthUrl: process.env.FLIGHT_HEALTH_URL, // read by `reins flight watch` only
};
```

The default export can also be a function that returns the options (it may be async): the CLI calls it, and the server passes what it returns to `flight.start()`.

### In the server: `flight.start`, `flight.step`, `flight.probe`, `flight.report`

```ts
import express from 'express';
import { flight, renderFlightHtml } from '@mindmakr/reins/flight';
import config from './flight.config.mjs';

// Once, at start-up. Reads reins.flight.json from the current folder unless `manifest` names another file or
// passes the object. Never throws (except with `strict: true` and an invalid manifest); false on a bad option.
flight.start({ ...config, routes: ['/api/payouts/:id'] });

const app = express();
app.use(flight.middleware()); // or flight.fastify(app), or http.createServer(flight.wrapHandler(handler))

app.post('/api/payouts', async (req, res) => {
  const payout = await createPayout(req.body);
  flight.step('payout', payout.id, 'requested'); // process, key, step: returns at once, never throws
  res.json(payout);
});

// A check on the app's own data, under the id the manifest declares. `{ ok: true }` when it holds.
flight.probe('pool-matches-ledger', async () => ({ ok: (await poolBalance()) === (await ledgerTotal()) }));

// The report data, rendered as a script-free page behind the app's own sign-in. Flight ships no route.
app.get('/admin/flight', requireAdmin, async (_req, res) => {
  const report = await flight.report(); // { windowMs } to change the default 24 hours
  res.type('html').send(report ? renderFlightHtml(report) : 'Flight is off.');
});
```

- `flight.start(options)`: the options are the config module's, plus `manifest` (an object or a path; default `reins.flight.json`), `strict`, `instance` (this copy's name), `routes` and `mounts` (route patterns for paths the framework gives no pattern for, and Express mount paths), `checkEveryMs` (default 60 s; 0 turns the checker off in this server), `checkTimeoutMs` (default 30 s), `probeTimeoutMs` (default 10 s), `stepBuffer` (default 10,000), `flushMs` (default 1 s), `notify` (`perHour`, default 5; `daily` summary, default on after `dailyHourUtc` 8), `service` and `retention`. Without a manifest flight checks the basics only. An invalid manifest never stops the basics: promise checks stop and a `blind` finding says so.
- `flight.step(process, key, step)`: records that run `key` of `process` reached `step`. Names come from the manifest. A key identifies one run for good: a new run needs a new key. It is never awaited in the request path; when the buffer is full, steps are dropped, counted and reported as `blind`.
- `flight.probe(id, fn)`: `fn` returns `{ ok: true }` when the data holds. `{ ok: false }`, a throw or a time-out is a broken probe. A probe declared but not registered, or registered but not declared, is a finding.
- `flight.report({ windowMs })`: the report data (null when flight is off). `renderFlightMarkdown(report)` and `renderFlightHtml(report)` are pure renderers; `findingMarkdown(finding)` gives one finding with its key as evidence; `compareFlightReports(before, after)` lists the findings resolved, new and still open.
- `flight.watch(options, cwd)`: runs the checker beside the server instead of in it, as `reins flight watch` does. `flight.stop()` stops either, and `await flight.closed()` waits until queued steps are written and the lock is given back.
- Also: `flight.span(name, fn)` times part of a request, `flight.flush()`, `flight.checkNow()` and `flight.findings()`.

### The manifest: `reins.flight.json`

```json
{
  "schema": 1,
  "service": "invoice-api",
  "upstreams": ["bank.example.com"],
  "processes": [
    {
      "name": "payout",
      "key": "the payout id",
      "steps": ["requested", "bank.sent", "bank.pending", "bank.settled", "bank.failed", "ledger.debited"],
      "ends": ["ledger.debited", "bank.failed"],
      "retries": { "bank.sent": 3 },
      "promises": [
        { "id": "pending-settles", "kind": "within", "after": "bank.pending", "expect": ["bank.settled", "bank.failed"], "within": "4h",
          "why": "Nothing else resolves a pending transfer; a stuck one is money owed to an employee." },
        { "id": "one-debit", "kind": "once", "step": "ledger.debited", "why": "A second debit makes the pool look smaller than it is." },
        { "id": "debit-after-settle", "kind": "order", "first": "bank.settled", "then": "ledger.debited" },
        { "id": "payout-ends", "kind": "ends", "within": "24h", "window": "7d" }
      ]
    }
  ],
  "probes": [{ "id": "pool-matches-ledger", "every": "15m", "why": "The pool balance must equal the sum of ledger entries." }],
  "basics": { "errorShare": 0.02 }
}
```

| Field | Rule |
|---|---|
| `schema` | `1`. A higher number is refused with "update reins". Any unknown field anywhere is refused |
| `service` | A short name for this server |
| `upstreams` | Hosts this server is expected to call. A call to any other host is an `unusual` finding |
| `processes[].name`, `steps`, `ends` | Lowercase letters, digits, dots and hyphens, at most 100 characters. `ends` lists the steps that finish a run |
| `processes[].key` | For people: what identifies one run |
| `processes[].retries` | Retries the system itself performs. `"bank.sent": 3` allows four records of that step per key; a fifth is a `broken` finding. Flight only counts; it never retries |
| `processes[].promises[]` | `id`, `kind`, the fields of that kind, `why` in plain words, and an optional `window` (default 24 hours) |
| `probes[]` | `id`, `every`, `why`. The function is registered in code with `flight.probe` under the same id |
| `basics` | Optional overrides of the default limits, by name (for example `errorShare`, `slowRouteMs`, `driftMinRuns`). `LIMITS` in `@mindmakr/reins/flight` lists each with its default, range and source |

| Promise kind | Fields | Broken when |
|---|---|---|
| `within` | `after`, `expect`, `within` | After step `after`, none of `expect` follows within the time |
| `once` | `step` | `step` is recorded a second time for one key |
| `order` | `first`, `then` | `then` is recorded for a key before any `first` |
| `ends` | `within` | A run is older than the time and has reached none of the process's `ends` |

Durations are written `30s`, `15m`, `4h`, `7d`. Each promise is checked over its look-back window: `once` and `order` judge runs with a step inside the window. `within` and `ends` count the runs overdue now, whatever their age: a stuck run stays counted until it reaches its expected or end step, or retention removes it (then a `blind` fact, `overdue-pruned`, says so). A `within` or `ends` promise is `drifting` when the 95th percentile of its runs reaches 80% of its limit (`driftShare`), judged only once at least 20 runs finished in the window (`driftMinRuns`, which `basics` can change).

`npx reins flight check [file]` validates the manifest and lists every problem with its path, not only the first. It needs no running server.

### Findings

Each finding has a stable `key` (for example `promise:payout:pending-settles`), a `kind`, a `level` (`error` or `warn`), plain `text`, a `count`, `firstAt`, `lastAt` and a `state` (`open` or `resolved`). Kinds, in the order every report shows them:

1. `blind`: flight itself cannot see (steps dropped, the store unreachable or refusing the findings write, a sink failing, the manifest invalid).
2. `basic`: what is taken for granted (failed or slow requests, a failing upstream host, a blocked event loop, growing memory, a spike of 401, 403 and 429 answers, the health address not answering). These need no manifest.
3. `broken`: a promise is broken.
4. `drifting`: a promise is moving toward its limit, or a figure is well above its own baseline.
5. `unusual`: something not seen before (an undeclared step or host, a declared step gone silent, a new error code).

A report leads with at most five findings and lists the rest below. It also says what was checked and found fine, and what was not checked.

### Stores

| Store | For |
|---|---|
| `memoryStore()` | Tests and one process. Default when `start()` gets no store. Keeps at most 100,000 steps (`MEMORY_MAX_STEPS`) |
| `fileStore({ dir })` | One machine: one server, or a server and a watcher beside it (local Docker with a shared folder). Default folder `.reins/flight/`. Not for several machines |
| `pgStore({ query })` | Several server copies. `query(text, params)` is the app's own Postgres call (for example `pool.query`), so reins adds no driver |

Flight never creates a table. Add `PG_TABLES` (exported from `@mindmakr/reins/flight`) through the project's own migration flow:

```sql
create table reins_flight_steps (
  id bigserial primary key,
  process text not null,
  key text not null,
  step text not null,
  at bigint not null,
  instance text not null
);
create index reins_flight_steps_process_key on reins_flight_steps (process, key);
create index reins_flight_steps_process_at on reins_flight_steps (process, at);
create index reins_flight_steps_at on reins_flight_steps (at);

create table reins_flight_minutes (
  instance text not null,
  minute bigint not null,
  data jsonb not null,
  primary key (instance, minute)
);
create index reins_flight_minutes_minute on reins_flight_minutes (minute);

create table reins_flight_probes (
  id text primary key,
  instance text not null,
  at bigint not null,
  ok boolean not null,
  reason text,
  ms integer not null
);

create table reins_flight_findings (
  key text primary key,
  state text not null,
  updated_at bigint not null,
  data jsonb not null
);

create table reins_flight_lock (
  name text primary key,
  owner text not null,
  until bigint not null
);
```

**Retention.** `retention: { maxAgeMs, maxSteps }` bounds each store. Defaults: 7 days (or the widest promise window and a day, if longer), and 1,000,000 steps in a file or Postgres store, 100,000 in memory. Whole runs go, oldest first, never single steps. Each removed run leaves one marker step, so a key keeps naming one run; a later step for that key joins a run known to be partial, which `once`, `order` and retries do not judge (`blind` fact `runs-partial`). Marker-only runs have their own bounds: at most `maxSteps` of them, each kept for 2 x `maxAgeMs`; markers removed early by that count give the `blind` fact `markers-dropped`. So the worst case after a prune is about 3 x `maxSteps` rows: the memory store's 100,000 steps measured about 47 MB of heap with 200-character keys, and about 118 MB with the markers. The file store never deletes a step file written in the last hour, as a writer may still append to it, so on disk it can hold one to two hours of writes beyond these bounds. The `markers-dropped` and `overdue-pruned` facts are kept as long as the stored minutes, which go at `maxAgeMs`: with a `maxAgeMs` shorter than the widest promise window they go early.

The checker lock, several copies, clock skew and a write that lands after its lease are covered in [SECURITY.md](SECURITY.md#stores-the-lock-and-several-copies).

### Sinks

A sink is told when a finding opens, changes level or resolves, at most 5 times an hour (then one digest), plus a daily summary. Sinks get counts, not process keys, unless the sink is created with `keys: true`. A sink that keeps failing (3 deliveries in a row) is a `blind` finding on the other sinks and in the report.

| Sink | Behaviour |
|---|---|
| `webhookSink({ url, secret })` | A JSON POST with a plain `text` field (so a chat channel that accepts `{ "text": … }` shows it) and the finding's fields. Signed as Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`). https only, except to localhost; no redirects; 15 s per attempt; 20,000-byte body; 3 retries with back-off. How a receiver checks it: [SECURITY.md](SECURITY.md#sinks-and-webhook-receivers) |
| `fileSink({ dir, file })` | One JSON line per notification, by default `.reins/flight/notifications.jsonl`, started afresh past 10 MB |
| `functionSink(fn)` | The app receives each notification and does what it likes, for example stores it or opens an issue. A plain function in `sinks` works the same |

### The report and the CLI

```sh
npx reins flight check [reins.flight.json]               # validate the manifest; exit 0 valid, 1 problems, 2 bad usage
npx reins flight report --config flight.config.mjs       # the report from the store, as Markdown (--json for the data)
npx reins flight report saved.json                       # render a saved report (the JSON of flight.report() or --json)
npx reins flight report --compare before.json after.json # findings resolved, new and still open, by key
npx reins flight watch --config flight.config.mjs        # the checker beside the server, with its health address
```

`--json` output holds process keys: treat it as server-side data. `reins flight report` gives a fixed message for a saved file that is not a valid report and quotes none of its content.

**The watcher.** A server cannot report that it is down; a watcher beside it can. `reins flight watch` runs the same checker as a server on the same store and sinks, opens no port, and polls `healthUrl` each period (within 10 s, and at most half of `checkTimeoutMs`), keeping a `basic` finding open while the server does not answer with a 2xx status. While the watcher holds the store's checker lock, the servers' checkers stand down; while a server holds it, the watcher waits and takes over once the server stops renewing it. On Ctrl+C or SIGTERM it gives the lock back within 10 s, and a second signal exits at once. When no watcher polls any more, an open health finding resolves after 10 minutes as "no longer checked".

**For an agent in development**, the bridge's read-only `reins_flight` tool reads a saved report or the file store under the project, without loading app code.

## State adapters

```ts
import { reins } from '@mindmakr/reins';
import { zustand, redux, reactQuery, routerLocation } from '@mindmakr/reins/adapters';

reins.state('cart', zustand(useCartStore));
reins.state('store', redux(store));
reins.state('queries', reactQuery(queryClient));
reins.state('route', routerLocation()); // or routerLocation(() => router.state.location)
reins.state('anything', () => ({ step, total }));
```

Pairing also adds `location`, `localStorage`, `sessionStorage` and `cookies`. Storage and cookies list key names only. Their values are redacted unless allowlisted.

## Companion: Coordinator & The 8 Lucid Coding Principles

[**Coordinator**](https://mindmakr.github.io/coordinator/) ([`mindmakr/coordinator`](https://github.com/mindmakr/coordinator)) asks every open question up front, agrees a testable bar, and runs multi-step work through isolated builders and independent **blind critics** until the bar is met.

Together, **Coordinator** and **reins** practise the [**8 Lucid Coding Principles**](https://mindmakr.github.io/coordinator/lucid-coding.html):

1. **Know your system.** If you cannot say what your agents changed, why, and what proved it, you don't know your system yet.
2. **Give agents instruments, not just screenshots.** A screenshot shows pixels; it hides why they are slow, broken or clipped. Let your app report its own actions, state, network calls, lifecycle timings (`reins_perf`) and DOM and CSS layout (`reins_dom`) in development, and strip that instrumentation from production.
3. **Agree the bar before the build.** Write down what done means, as behaviours someone else can check, before anyone starts.
4. **A blind critic, never the builder, grades the work.** A separate critic, who never sees the builder's reasoning, checks the real result against the bar.
5. **Evidence or it didn't happen.** A pass carries its proof: test output, a screenshot (`reins_snap`), a lifecycle or API timing (`reins_perf`), a DOM check (`reins_dom`), a log, a link.
6. **Every run is visible.** What the agent saw, what it built, and why it passed or failed stay on the record while the run is live and after it ends.
7. **Every run teaches the next.** Repeated gaps become lessons for the next brief, and past runs set the next budgets.
8. **Get the work done; performance comes with experience and measurement.** Finish the work to the bar first. Then measure what actually happened: when the page painted, when each component mounted, how long each API call took, and where the layout clipped.

**reins** is Coordinator's runtime instrument panel inside your app:

- **Builders** wire features along with `useReinsAction`, `reins.state` and `<ReinsPanel id>`.
- **Blind visual & code critics** (who never see the builder's reasoning) use `reins_run_action` to switch locales (`en`, `ar` RTL) and themes, check `reins_state`, `reins_network`, `reins_errors`, `reins_perf` and `reins_dom`, and attach `reins_snap` PNGs as durable proof on the Coordinator run dashboard.

Install both in Claude Code:

```text
/plugin install coordinator --marketplace mindmakr/coordinator
/plugin install reins --marketplace mindmakr/reins
```

Read the [Lucid Coding Manifesto](https://mindmakr.github.io/coordinator/lucid-coding.html).

## Security model

reins gives an agent real control of a running app, so the limits are enforced in code and covered by tests:

1. **Development reins is kept out of production; flight is the only part meant for it.** The core only turns on when `__DEV__`, `import.meta.env.DEV` or `NODE_ENV !== 'production'` says it is a dev build. The Vite, Next and Metro plugins swap `@mindmakr/reins` for an empty stub in production builds. The core carries the marker `__REINS_DEV_ONLY__`, and `reins verify` (`reins-verify-bundle`) fails your build if it finds it. A staging build keeps reins only when built with `REINS_ENABLE=1`. On a server, `@mindmakr/reins/node` refuses to start in production. `@mindmakr/reins/flight` is the only part meant for production: it has no actions, no pairing, no bridge client, no token handling, no DOM or state reading and no eval, opens no port, records requests as method, route pattern, status and timing only, and reports a finding tagged `security` when the development module is loaded in a production process. A test walks its imports and fails if they reach development reins, `ws` or the MCP SDK.
2. **Off until paired.** Until the bridge accepts its token, the core adds no listeners and patches nothing. The one exception is record mode (`@mindmakr/reins/record`), which a person turns on themselves in a dev or private staging build; it sends nothing anywhere and only downloads a file when they click Export. [SECURITY.md](SECURITY.md) covers record mode and `@mindmakr/reins/node` in full. The bridge makes a random 192-bit token, writes it to `.reins/token` (with its own `.gitignore`) and renews it after each pairing. It listens on `127.0.0.1` only, which cannot be changed. It rejects WebSocket origins that are not localhost or on your `--origin` list. Clients with no Origin, like React Native, still need the token, and `--browser-only` refuses them.
3. **Redacted by default.** Request and response bodies, `Authorization`, `Cookie` and `Set-Cookie` headers, storage values, cookie values, sensitive query values and sensitive state keys (token, password, secret, session and so on) are replaced with `[redacted]`. Allowlist keys with `reins.connect({ allow: { headers, bodyKeys, storageKeys, cookies, queryKeys, stateKeys } })`. httpOnly cookies cannot be read by page code at all.
4. **Consequential actions need confirmation.** An action marked `consequential: true` is refused unless the call says `confirm: true`.
5. **Everything is logged.** The bridge appends every agent call, pairing, refusal and DevTools or WebMCP call to `.reins/audit.log`, with arguments redacted.
6. **Lazy.** `connect()` waits for `load` and an idle moment before it does anything.
7. **No eval.** Only actions the app registered can run.

See [SECURITY.md](SECURITY.md) for flight's safety rules and the test behind each, what reins and flight do not protect against, and how to report a problem.

## Prior art and how reins differs

- **[Playwright MCP](https://github.com/microsoft/playwright-mcp)** drives a browser from the outside through the accessibility tree. reins works from inside the app: the agent calls the app's own named actions and reads its real state. They work well together, and `reins_snap` can use Playwright to take its pictures.
- **[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)** gives an agent DevTools: network, console, performance and screenshots. It sees everything, unredacted, and it knows nothing about your app's own flows. reins exposes only what the app chooses to, redacted, and it also works in React Native.
- **[WebMCP](https://github.com/webmachinelearning/webmcp)** is a proposed browser API for pages to offer tools to agents. reins registers its actions there when the browser supports it, and it also reaches agents that are not in the browser through the bridge.
- **[React DevTools](https://react.dev/learn/react-developer-tools)** shows a person the component tree and its state. reins gives an agent a small, stable interface chosen by the app instead of the whole tree.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For coding agents adding reins to an app, see [AGENTS.md](AGENTS.md) and [`skills/reins/SKILL.md`](skills/reins/SKILL.md).

## Licence

[MIT](LICENSE) © Asif Raja, by [mindmakr](https://github.com/mindmakr). Use it, change it and ship with it, in personal and commercial projects.

- **Names:** "reins" and "Lucid Coding" are covered by the [trademark policy](TRADEMARKS.md). The code is free to use; the names are not free to reuse for another product.
- **Your work and the risk:** what you make with reins is yours, and the software comes with no warranty or guarantee and no liability. Read the [notice](DISCLAIMER.md) before you rely on it.
- **Contributing:** pull requests are welcome under the [contributor agreement](CLA.md).
- **Sponsoring:** use the Sponsor button on this repository, or the [sponsor or partner form](https://github.com/mindmakr/coordinator/issues/new?template=sponsor-or-partner.yml).
