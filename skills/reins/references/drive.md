# Driving and inspecting an app with reins

Use this playbook when verifying a feature, reproducing a bug, or running a visual, layout, and performance review on a web or Expo app wired with **reins**.

Run the CLI from the project's own install, `./node_modules/.bin/reins …` (`.\node_modules\.bin\reins …` in PowerShell): `npx reins …` gives the same result but spends about half a second per call finding the package. Run it from the folder whose `package.json` has `@mindmakr/reins` (the app's folder in a monorepo); a workspace that hoists packages keeps the CLI in the root's `node_modules/.bin` instead, and `npx reins` finds either.

## 1. Pair with the running app

1. Make sure the `reins` MCP server (`reins bridge`) is running and the app is open in dev mode (`npm run dev` or `npx expo start`).
   - **Snaps** (`reins_snap`) in a browser need Playwright installed in the project, Chrome started with `--remote-debugging-port=9222`, and the bridge started with `--cdp http://127.0.0.1:9222` (in `.mcp.json`: `"args": ["reins", "bridge", "--cdp", "http://127.0.0.1:9222"]`). Without them `reins_snap` returns the panel's box and a note instead of a PNG. On Android the snap is the whole screen, with a `pixelBox` to crop to.
   - For Android emulators or USB devices on Expo, run `adb reverse tcp:7357 tcp:7357` so the app can reach the localhost bridge.
   - **Port taken** (a second agent session or terminal runs a bridge): stop that one, or start this one with `--port <n>` and give the app the same port, `reins.connect({ url: 'ws://127.0.0.1:<n>' })`.
2. Call `reins_list_actions` first. It returns:
   - `app`: the paired app's URL, title and platform metadata
   - `actions`: every registered action with its `name`, `description`, `input` JSON schema, `readOnly` and `consequential` flags
   - `states`: registered state sources (`location`, `localStorage`, `sessionStorage`, `cookies`, plus app stores)
   - `panels`: every `<ReinsPanel id="...">` currently mounted
   - `servers`: the actions of each paired `@mindmakr/reins/node` server (run one with `target: "server"` when the app has an action of the same name)

If `reins_list_actions` says `No app is paired`, open the dev URL in the browser (or reload the page) so `reins.connect()` fetches `/__reins/token` and pairs.

## 2. Drive flows through actions, not pixel clicks

Instead of guessing coordinates or brittle CSS selectors:

1. **Authenticate through the app's registered action** (if needed):
   Call `reins_run_action` with `{ "name": "login-as-tester", "input": {} }`.
2. **Navigate or seed state**:
   Call `reins_run_action` with the action and input schema returned by `reins_list_actions` (for example `navigate`, `open-cart`, `set-locale`, `set-theme`).
3. **Consequential actions** (`setup.md`, Step 5): `reins_run_action` refuses one without `confirm: true`. Ask the person before calling with `confirm: true`.
4. **A flow of several steps** with checks: write it once as a scenario and run it in one call, `reins scenario flow.json [--confirm] [--panel <id>]`. The file is `{ "steps": [{ "action": "login-as-tester" }, { "action": "set-locale", "input": { "locale": "ar" }, "assertState": { "app": { "locale": "ar" } } }] }`; each step can also name a `tool`, `target`, `assertNoErrors` or `allowErrors`, and errors fail a step unless allowed.

## 3. Check what the action should have changed

After an action, check only what it should change: the store it writes (`reins_state` with `{ "name": "<source>" }`), the request it sends (`reins_network` with `{ "url": "/api/checkout" }`), and that no error appeared (`reins_errors`). Sensitive keys (`token`, `password`, `secret`, `session`, and so on) come back `[redacted]`.

At a checkpoint (the end of a flow, before and after a fix), take everything in one call instead of one tool each:

- **`reins_report`** (`{ "title": "before-fix" }`) gathers actions, state, network, errors, perf and the DOM of every mounted panel, and saves `.reins/sessions/<time>-<slug>.md` and `.json` with plain-language `findings` (slow API over 500 ms, duplicate calls, N+1 server spans, excessive panel renders, layout clipping, errors). After a fix, take another (`{ "title": "after-fix" }`) and run `reins report --compare <before.json> <after.json>`: the findings that went away move to `Resolved`. A tester's exported `reins-session-*.json` or `.md` (`@mindmakr/reins/record`) is read directly or rendered with `reins report --from <file>`.
- **`reins packet --text`** prints the same evidence as compact tables (server spans joined by `x-reins-trace`, event-loop lag, panel boxes, RTL and clipping metrics), for a report or a critic; without `--text` it is redacted JSON.

Use the single tools when a question needs more detail than a report gives:

- **`reins_perf`**: `lifecycle` (`ttfbMs`, `firstPaintMs`, `firstContentfulPaintMs`, `domInteractiveMs`, `domContentLoadedMs`, `loadMs`, `domNodes`, `nowMs`), `components` (`mountedAtMs`, `lastRenderMs` and `renders` per `<ReinsPanel id>` or `reins.markComponent(id)`), `api` (`totalCalls`, `failedCalls`, `avgMs`, `maxMs`, `slowest`, `calls`), `actions` (each `[reins] <action>` measure) and one `timeline` of all of them.
- **`reins_dom`** (`{ "panel": "<panel-id>", "depth": 3, "maxNodes": 40 }` or `{ "selector": "..." }`): each node's tag, id, classes, role, redacted text and `box`; computed `styles` (display, position, flex, gap, overflow, `direction`, colour, font, opacity, visibility, z-index); and `issues` (`horizontal-clip`, `vertical-clip`, `zero-size`).
- **`reins_server`** (when a Node server is paired through `@mindmakr/reins/node`; optionally `{ "route": "/api/invoices", "limit": 20 }`): request durations, `dbMs` from `db.*` spans, N+1 query loops, outbound fetches, `traceId` to match `reins_network`, the slowest routes, event-loop delay (`p50Ms`, `p99Ms`, `maxMs`) and memory.

## 4. Snap the panels the task names

For each panel the task's bar names, in each locale and theme the bar names (for example `set-locale` `en` and `ar` for RTL, `set-theme` `light` and `dark`, set through the app's actions; reins does not change the viewport, so a width is an app action such as `set-viewport-mode` when the app has one):

1. Set the locale or theme with `reins_run_action`.
2. Call `reins_snap` with `{ "id": "<panel-id>" }`. It scrolls the panel into view itself and saves `.reins/snaps/<panel-id>-<timestamp>.png`.
3. Call `reins_dom` with `{ "panel": "<panel-id>" }` only when the snap looks wrong or the bar asks about layout: `issues` should be `[]`.
