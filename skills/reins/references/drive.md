# Driving and inspecting an app with reins

Use this playbook when verifying a feature, reproducing a bug, or running a visual, layout, and performance review on a web or Expo app wired with **reins**.

## 1. Pair with the running app

1. Make sure the `reins` MCP server (`npx reins bridge`) is running and the app is open in dev mode (`npm run dev` or `npx expo start`).
   - For browser screenshots via `reins_snap`, start Chrome with `--remote-debugging-port=9222` and run the bridge with `--cdp http://127.0.0.1:9222`.
   - For Android emulators or USB devices on Expo, run `adb reverse tcp:7357 tcp:7357` so the app can reach the localhost bridge.
2. Call `reins_list_actions` first. It returns:
   - `app`: the paired app's URL, title and platform metadata
   - `actions`: every registered action with its `name`, `description`, `input` JSON schema, `readOnly` and `consequential` flags
   - `states`: registered state sources (`location`, `localStorage`, `sessionStorage`, `cookies`, plus app stores)
   - `panels`: every `<ReinsPanel id="...">` currently mounted

If `reins_list_actions` says `No app is paired`, open the dev URL in the browser (or reload the page) so `reins.connect()` fetches `/__reins/token` and pairs.

## 2. Drive flows through actions, not pixel clicks

Instead of guessing coordinates or brittle CSS selectors:

1. **Authenticate through the app's registered action** (if needed):
   Call `reins_run_action` with `{ "name": "login-as-tester", "input": {} }`.
2. **Navigate or seed state**:
   Call `reins_run_action` with the action and input schema returned by `reins_list_actions` (for example `navigate`, `open-cart`, `set-locale`, `set-theme`).
3. **Consequential actions**:
   If an action is marked `consequential: true`, `reins_run_action` refuses it without `confirm: true`. Ask the person for confirmation before calling with `confirm: true`.

## 3. Check state, network, errors, performance and DOM after every action

After running an action, verify what actually happened inside the app using its instruments:

- **State (`reins_state`)**:
  Read `{ "name": "app" }` (or omit `name` to read all sources). Confirm store values updated as expected. Sensitive keys (`token`, `password`, `secret`, `session`, etc.) are automatically `[redacted]`.
- **Network (`reins_network`)**:
  Pass `{ "limit": 20 }` or `{ "url": "/api/checkout" }` to verify request methods, status codes, start timestamps (`startMs`), and duration (`ms`). Check for unexpected `4xx`/`5xx` responses or duplicate fetches.
- **Errors (`reins_errors`)**:
  Confirm zero console errors, uncaught exceptions or unhandled promise rejections occurred during the flow.
- **Performance & Lifecycle (`reins_perf`)**:
  Call `reins_perf` to inspect:
  - `lifecycle`: `ttfbMs`, `firstPaintMs`, `firstContentfulPaintMs`, `domInteractiveMs`, `domContentLoadedMs`, `loadMs`, `domNodes`, `nowMs`
  - `components`: mount timestamps (`mountedAtMs`), latest render timestamp (`lastRenderMs`), and `renders` count for every `<ReinsPanel id>` (or `reins.markComponent(id)`)
  - `api`: `totalCalls`, `failedCalls`, `avgMs`, `maxMs`, `slowest`, and `calls`
  - `actions`: duration of every `[reins] <action>` measure
  - `timeline`: a single chronological millisecond timeline combining lifecycle milestones, component mounts, API calls, and actions
- **DOM & Computed CSS Layout (`reins_dom`)**:
  Call `reins_dom` with `{ "panel": "<panel-id>", "depth": 3, "maxNodes": 40 }` (or `{ "selector": "..." }`) to inspect:
  - `tag`, `id`, `classes`, `panel`, `role`, redacted direct `text`, and `box` (`x`, `y`, `width`, `height`)
  - `styles`: computed `display`, `position`, `flexDirection`, `justifyContent`, `alignItems`, `gap`, `overflowX`, `overflowY`, `direction` (`ltr`/`rtl`), `color`, `backgroundColor`, `fontSize`, `fontWeight`, `opacity`, `visibility`, `zIndex`
  - `issues`: automatic layout anomaly flags (`horizontal-clip`, `vertical-clip`, `zero-size`)
- **Backend Server & DB Spans (`reins_server`)**:
  When a Node server is paired via `reins/node`, call `reins_server` (optionally with `{ "route": "/api/invoices", "limit": 20 }`) to inspect inbound request durations, `dbMs` (`db.*` spans), N+1 query loops, outbound upstream fetches, `traceId` correlation with `reins_network`, slowest routes, and Node event-loop delay (`p50Ms`, `p99Ms`, `maxMs`) and memory.
- **Session Reports & Regression Diffs (`reins_report` & `npx reins report --compare`)**:
  Call `reins_report` (`{ "title": "before-fix" }`) to save `.reins/sessions/<time>-<slug>.md` and `.json` with automatic plain-language `findings` (slow API > 500 ms, duplicate calls, N+1 server spans, excessive panel renders, layout clipping, errors). After applying a fix, capture a second report (`{ "title": "after-fix" }`) and run `npx reins report --compare <before.json> <after.json>` to verify every metric improved and findings moved to `Resolved`. If a human tester hands you an exported `reins-session-*.json` or `.md` from `reins/record`, read it directly or render/compare it with `npx reins report --from <file>`.

## 4. Measure and snap panels across locales and widths

For every changed or target `<ReinsPanel id="...">`:

1. Call `reins_panel_box` with `{ "id": "<panel-id>", "scroll": true }` to scroll the panel into view and inspect its bounding box (`x`, `y`, `width`, `height`, `devicePixelRatio`, `viewportWidth`, `viewportHeight`).
2. Call `reins_dom` with `{ "panel": "<panel-id>" }` to verify computed CSS (`direction`, flex/grid alignment) and confirm `issues` is empty (`[]`) with no `horizontal-clip`, `vertical-clip` or `zero-size` elements.
3. Call `reins_snap` with `{ "id": "<panel-id>" }` to capture a pixel-exact PNG under `.reins/snaps/<panel-id>-<timestamp>.png`.
4. If the app supports multiple locales or themes (e.g. `set-locale` with `en` and `ar` for RTL, `set-theme` with `light` and `dark`), loop through each via `reins_run_action`, check `reins_errors` and `reins_dom`, and take a `reins_snap` of the panel in each state.
