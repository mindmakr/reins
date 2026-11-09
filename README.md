# reins

Give coding agents the reins: a tiny dev-only library to drive, inspect and debug your web and Expo apps.

An AI coding agent that tests your app usually clicks by pixels and guesses what happened. reins lets the app tell the agent what it can do and what state it is in. You register a few named actions ("log in as the tester", "switch to Arabic"), point at some state, and mark the panels worth looking at. The agent then calls those actions, reads the state, sees recent network calls and errors, and takes pixel-exact pictures of a panel. All of it goes through an MCP server on your machine.

reins is for development and test builds. Production builds swap it for an empty stub, and a check fails the build if any reins code is left.

- The core is under 5 KB min+gzip and has no dependencies.
- It works in the browser and in React Native.
- It does nothing until it pairs with the bridge on your machine using a one-time token.

> [!NOTE]
> Version 0.1. The packages are not on npm yet. To try them, clone this repo and use `npm link` or a `file:` dependency.

## Packages

| Package | What it does |
| --- | --- |
| [`reins`](packages/reins) | The core: actions, state, network and error buffers, panels, WebMCP. |
| [`@reins/react`](packages/react) | `useReinsAction`, `useReinsState`, `<ReinsPanel id>`. |
| [`@reins/expo`](packages/expo) | React Native glue: `connectExpo()`, `<ReinsPanel>` with `testID`, a Metro config helper. |
| [`@reins/vite`](packages/vite) | Vite plugin: serves the token in dev, stubs reins in production builds. |
| [`@reins/next`](packages/next) | `withReins(nextConfig)` and a token route. |
| [`@reins/bridge`](packages/bridge) | `reins bridge`: the localhost WebSocket server and the MCP server. |
| [`@reins/verify`](packages/verify) | `reins-verify-bundle <dir>`: fails if reins code is in a production bundle. |

## Five-minute setup

### Vite + React

```sh
npm i -D reins @reins/react @reins/vite @reins/bridge @reins/verify
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import reins from '@reins/vite';

export default defineConfig({ plugins: [reins(), react()] });
```

`src/main.tsx`:

```ts
import { reins } from 'reins';
import { zustand } from 'reins/adapters';
import { useAppStore } from './store';

if (import.meta.env.DEV) {
  reins.state('app', zustand(useAppStore));
  reins.connect(); // fetches the token from /__reins/token, then pairs
}
```

In a component:

```tsx
import { useReinsAction, ReinsPanel } from '@reins/react';

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

Add the check to your build script: `"build": "vite build && reins-verify-bundle dist"`.

### Next.js (App Router)

```sh
npm i -D reins @reins/react @reins/next @reins/bridge @reins/verify
```

`next.config.mjs`:

```js
import { withReins } from '@reins/next';
export default withReins({ /* your config */ });
```

`app/api/reins-token/route.ts`:

```ts
export { GET } from '@reins/next/token-route';
export const dynamic = 'force-dynamic';
```

A client component mounted once, for example in your root layout:

```tsx
'use client';
import { useEffect } from 'react';
import { reins } from 'reins';

export function Reins() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') reins.connect({ tokenUrl: '/api/reins-token' });
  }, []);
  return null;
}
```

Check the output: `"build": "next build && reins-verify-bundle .next/static"`.

### Expo

```sh
npx expo install reins @reins/react @reins/expo
npm i -D @reins/bridge @reins/verify
```

`metro.config.js`:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withReins } = require('@reins/expo/metro');
module.exports = withReins(getDefaultConfig(__dirname));
```

`App.tsx`:

```tsx
import { connectExpo, ReinsPanel, useReinsAction } from '@reins/expo';

if (__DEV__) connectExpo();

export default function App() {
  useReinsAction({ name: 'open-cart', description: 'Open the cart screen', run: () => navigation.navigate('Cart') });
  return <ReinsPanel id="home">…</ReinsPanel>;
}
```

The bridge only listens on `127.0.0.1`. The iOS simulator shares your machine's loopback, so that just works. For an Android emulator or a USB device, run `adb reverse tcp:7357 tcp:7357`. Phones on Wi-Fi cannot reach the bridge, on purpose.

Check the export: `npx expo export && npx reins-verify-bundle dist`.

> [!NOTE]
> `@reins/expo/metro` loads ESM with `require`, which needs Node 20.19 or newer, or 22.12 or newer. Metro must have package exports turned on, which is the default from Expo SDK 53.

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
| `reins_network` | Recent fetch and XHR calls: method, URL, status, time, redacted headers and bodies. |
| `reins_errors` | Recent console errors, uncaught errors and unhandled rejections. |
| `reins_panel_box` | A panel's box in CSS pixels, with `devicePixelRatio`. |
| `reins_snap` | A pixel-exact PNG of a panel under `.reins/snaps/`, and optionally a copy on the clipboard. |

A typical loop: list actions, run `login-as-tester`, run `set-locale` with `ar`, check `reins_errors` is empty, then `reins_snap` the `checkout` panel and compare it with the design.

`reins_snap` in a browser uses Playwright, if it is installed, over the Chrome DevTools Protocol. Start Chrome with `--remote-debugging-port=9222` and the bridge with `--cdp http://127.0.0.1:9222`. On Android it captures the screen with `adb` and returns the panel's box in device pixels. Otherwise it returns the box, so the agent's own browser tool can clip a screenshot to it.

People get the same handle in DevTools once the page is paired: `__reins__.actions()`, `__reins__.run('set-locale', { locale: 'ar' })`, `__reins__.state()`, `__reins__.network()`. Each action run shows as a collapsed console group and a `performance.measure` entry in the Performance panel.

If the browser supports [WebMCP](https://github.com/webmachinelearning/webmcp) (`navigator.modelContext` or `document.modelContext`), reins also registers each action as a WebMCP tool. Read-only actions get `readOnlyHint`. Consequential ones get `destructiveHint` and a required `confirm` input.

## State adapters

```ts
import { reins } from 'reins';
import { zustand, redux, reactQuery, routerLocation } from 'reins/adapters';

reins.state('cart', zustand(useCartStore));
reins.state('store', redux(store));
reins.state('queries', reactQuery(queryClient));
reins.state('route', routerLocation()); // or routerLocation(() => router.state.location)
reins.state('anything', () => ({ step, total }));
```

Pairing also adds `location`, `localStorage`, `sessionStorage` and `cookies`. Storage and cookies list key names only. Their values are redacted unless allowlisted.

## Security model

reins gives an agent real control of a running app, so the limits are enforced in code and covered by tests:

1. **Kept out of production.** The core only turns on when `__DEV__`, `import.meta.env.DEV` or `NODE_ENV !== 'production'` says it is a dev build. The Vite, Next and Metro plugins swap `reins` for an empty stub in production builds. The core carries the marker `__REINS_DEV_ONLY__`, and `reins-verify-bundle` fails your build if it finds it. A staging build keeps reins only when built with `REINS_ENABLE=1`.
2. **Off until paired.** Until the bridge accepts its token, the core adds no listeners and patches nothing. The bridge makes a random 192-bit token, writes it to `.reins/token` (with its own `.gitignore`) and renews it after each pairing. It listens on `127.0.0.1` only, which cannot be changed. It rejects WebSocket origins that are not localhost or on your `--origin` list. Clients with no Origin, like React Native, still need the token, and `--browser-only` refuses them.
3. **Redacted by default.** Request and response bodies, `Authorization`, `Cookie` and `Set-Cookie` headers, storage values, cookie values, sensitive query values and sensitive state keys (token, password, secret, session and so on) are replaced with `[redacted]`. Allowlist keys with `reins.connect({ allow: { headers, bodyKeys, storageKeys, cookies, queryKeys, stateKeys } })`. httpOnly cookies cannot be read by page code at all.
4. **Consequential actions need confirmation.** An action marked `consequential: true` is refused unless the call says `confirm: true`.
5. **Everything is logged.** Every call shows in the browser console. The bridge appends every agent call, pairing, refusal and DevTools or WebMCP call to `.reins/audit.log`, with arguments redacted.
6. **Lazy.** `connect()` waits for `load` and an idle moment before it does anything.
7. **No eval.** Only actions the app registered can run.

See [SECURITY.md](SECURITY.md) for what reins does not protect against and how to report a problem.

## Prior art and how reins differs

- **[Playwright MCP](https://github.com/microsoft/playwright-mcp)** drives a browser from the outside through the accessibility tree. reins works from inside the app: the agent calls the app's own named actions and reads its real state. They work well together, and `reins_snap` can use Playwright to take its pictures.
- **[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)** gives an agent DevTools: network, console, performance and screenshots. It sees everything, unredacted, and it knows nothing about your app's own flows. reins exposes only what the app chooses to, redacted, and it also works in React Native.
- **[WebMCP](https://github.com/webmachinelearning/webmcp)** is a proposed browser API for pages to offer tools to agents. reins registers its actions there when the browser supports it, and it also reaches agents that are not in the browser through the bridge.
- **[React DevTools](https://react.dev/learn/react-developer-tools)** shows a person the component tree and its state. reins gives an agent a small, stable interface chosen by the app instead of the whole tree.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For coding agents adding reins to an app, see [AGENTS.md](AGENTS.md).

## Licence

[MIT](LICENSE) © mindmakr
