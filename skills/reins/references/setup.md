# Setting up reins in a new or existing project

Follow these steps in order to do the full setup for the person. Do not leave half-wired configs or ask the person to copy-paste boilerplate you can write directly.

## Step 1: Inspect the repository

Before touching files, detect:

1. **Framework & bundler** from `package.json` and config files:
   - **Vite + React**: `vite.config.ts` / `vite.config.js`
   - **Next.js (App Router or Pages)**: `next.config.mjs` / `next.config.ts` / `next.config.js`, `app/` or `src/app/`
   - **Expo / React Native**: `app.json` / `app.config.ts`, `metro.config.js`
   - **Plain web / other bundler**: entry HTML/TS file
2. **State stores**: check dependencies and `src/` for Zustand (`create(`), Redux Toolkit (`configureStore`), TanStack React Query (`new QueryClient()`), or router state.
3. **Auth, locale and theme hooks**: find where sign-in, language/locale switching (`i18n`, `setLocale`), and theme switching (`setTheme`) live.
4. **Key screens / panels**: identify 2–5 high-value screens or views (for example `home`, `login`, `dashboard`, `settings`, `checkout`) to wrap in `<ReinsPanel id="...">`.

## Step 2: Install `@mindmakr/reins`

Install the single package as a dev dependency (or via `npx expo install @mindmakr/reins` in Expo):

```sh
npm i -D @mindmakr/reins
```

(Use `pnpm add -D @mindmakr/reins`, `yarn add -D @mindmakr/reins`, or `bun add -d @mindmakr/reins` to match the repo's lockfile. Flight is the exception: it runs in production, so it is a regular dependency, `references/flight.md`.)

What the package provides:

- `@mindmakr/reins`: the browser and React Native core (under 5 KB min+gzip, no browser dependencies): `action`, `state`, `panel`, `markComponent`, `perf`, `dom`
- `@mindmakr/reins/react`: `useReinsAction`, `useReinsState`, `<ReinsPanel id>` (tracks mount time and render counts)
- `@mindmakr/reins/expo`: `connectExpo`, `<ReinsPanel id>`, `useReinsPanel`, `useReinsAction`, `useReinsState`
- `@mindmakr/reins/node`: dev-only Node middleware (`middleware`, `wrapHandler`, `fastify`), `span('db.*')`, `Server-Timing` and `x-reins-trace` correlation
- `@mindmakr/reins/record`: opt-in tester recording (`?reins=record` or `startRecording()`) that exports `.md` and `.json` sessions without a bridge
- `@mindmakr/reins/report`: Markdown and JSON session reports and before/after diffs (`reins report --compare a.json b.json`)
- `@mindmakr/reins/adapters`: `zustand`, `redux`, `reactQuery`, `routerLocation`, `fromStore`
- `@mindmakr/reins/vite`, `@mindmakr/reins/next`, `@mindmakr/reins/metro`: build plugins (serve the token in dev, swap to stubs in production)
- `reins bridge`: the localhost (`127.0.0.1:7357`) WebSocket hub and stdio MCP server; `reins verify <dir>`: fails if `__REINS_DEV_ONLY__` is in a production build; `reins exec|scenario|packet|fuzz|map`: one-shot commands against a running bridge (`drive.md`)

## Step 3: Wire the build plugin and token endpoint

Wire the build plugin **before** connecting the client so production builds always swap `@mindmakr/reins` for `@mindmakr/reins/stub`.

### Vite (`vite.config.ts`)

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import reins from '@mindmakr/reins/vite';

export default defineConfig({
  plugins: [reins(), react()],
});
```

### Next.js (`next.config.mjs` + `app/api/reins-token/route.ts`)

Wrap `nextConfig` in `next.config.mjs` (or `next.config.ts`):

```js
import { withReins } from '@mindmakr/reins/next';

export default withReins({
  // existing Next.js config
});
```

Create `app/api/reins-token/route.ts` (or `src/app/api/reins-token/route.ts`):

```ts
export { GET } from '@mindmakr/reins/next/token-route';
export const dynamic = 'force-dynamic';
```

### Expo (`metro.config.js`)

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withReins } = require('@mindmakr/reins/metro');

module.exports = withReins(getDefaultConfig(__dirname));
```

## Step 4: Connect in dev mode and expose state adapters

### Vite / React entry (`src/main.tsx` or `src/index.tsx`)

```ts
import { reins } from '@mindmakr/reins';
import { zustand, reactQuery, routerLocation } from '@mindmakr/reins/adapters';

if (import.meta.env.DEV) {
  // Register state stores discovered in Step 1:
  reins.state('route', routerLocation());
  // e.g. reins.state('app', zustand(useAppStore));
  // e.g. reins.state('queries', reactQuery(queryClient));
  reins.connect();
}
```

### Next.js client bootstrap (`components/ReinsBootstrap.tsx` mounted in root layout)

```tsx
'use client';
import { useEffect } from 'react';
import { reins } from '@mindmakr/reins';
import { routerLocation } from '@mindmakr/reins/adapters';

export function ReinsBootstrap() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      reins.state('route', routerLocation());
      reins.connect({ tokenUrl: '/api/reins-token' });
    }
  }, []);
  return null;
}
```

### Expo entry (`App.tsx` or `app/_layout.tsx`)

```tsx
import { connectExpo } from '@mindmakr/reins/expo';

if (__DEV__) {
  connectExpo();
}
```

### Optional: Node backend instrumentation (`@mindmakr/reins/node`)

If the project runs a Node API server (Express, Connect, Fastify, or `http.createServer`), wire `@mindmakr/reins/node` in dev mode so `reins_server`, `reins_perf` and `reins_report` join backend DB spans and event-loop lag with browser fetches via `x-reins-trace`:

```ts
import { reinsNode } from '@mindmakr/reins/node';

if (process.env.NODE_ENV !== 'production') {
  void reinsNode.connect({ meta: { name: 'api' } });
  app.use(reinsNode.middleware({ serverTiming: true }));
}

// Wrap DB or external queries in named spans (db.* counts toward dbMs):
const rows = await reinsNode.span('db.invoices.select', () => db.query('SELECT ...'));
```

If the server also runs flight (`references/flight.md`), both hooks may stay: they share one capture per request, so each request is recorded once.

### Optional: Tester session export (`@mindmakr/reins/record`)

To let human QA testers record a session (`?reins=record`) and download `.md` + `.json` diagnostics in dev or private staging (`REINS_ENABLE=1`), add `recordFromUrl()` in the browser entry (`@mindmakr/reins/vite`, `@mindmakr/reins/next`, and `@mindmakr/reins/metro` swap `@mindmakr/reins/record` for `@mindmakr/reins/record-stub` in production builds):

```ts
import { recordFromUrl } from '@mindmakr/reins/record';

if (import.meta.env.DEV) {
  recordFromUrl();
}
```

## Step 5: Register high-value actions and `<ReinsPanel>` boundaries

In the app's root shell or key feature components, import `useReinsAction`, `useReinsState` and `ReinsPanel` from `@mindmakr/reins/react` (or `@mindmakr/reins/expo` on React Native):

- **Locale & theme switching**:
  ```tsx
  useReinsAction({
    name: 'set-locale',
    description: 'Switch the UI locale',
    input: {
      type: 'object',
      properties: { locale: { type: 'string', enum: ['en', 'ar', 'fr'] } },
      required: ['locale'],
    },
    run: ({ locale }) => setLocale(locale),
  });
  ```
- **Navigation / screen opening**:
  ```tsx
  useReinsAction({
    name: 'navigate',
    description: 'Navigate to an app route',
    input: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    run: ({ path }) => router.push(path),
  });
  ```
- **Tester sign-in (only when a real login flow exists)**:
  Use the app's normal sign-in function with dev-only environment variables (`import.meta.env.VITE_TEST_USER_EMAIL`, etc.). **Never** bypass authentication or hardcode secrets.
- **Consequential actions** (the one definition; other pages link here):
  Set `consequential: true` on an action that changes real data, deletes records, resets dev data, spends money or sends messages. `reins_run_action` then refuses it without `confirm: true`, and an agent passes `confirm: true` only after the person agrees.
- **Panels**:
  Wrap the 2–5 main screens or sections in `<ReinsPanel id="kebab-case-id">…</ReinsPanel>` so agents can measure and snap them by ID, inspect their DOM and computed CSS via `reins_dom`, and automatically track their mount time and render counts in `reins_perf`.

## Step 6: Add `.reins/` to `.gitignore` and configure `.mcp.json`

1. Append `.reins/` to the project's `.gitignore` if not already present.
2. Add or merge the `reins` MCP server in `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "reins": {
      "command": "npx",
      "args": ["reins", "bridge"]
    }
  }
}
```

- **Snaps in a browser**: add `"--cdp", "http://127.0.0.1:9222"` to `args`, and Playwright to the project's dev dependencies (`drive.md`, step 1).
- **The app in a subfolder** (a monorepo whose root `package.json` does not have `@mindmakr/reins`): `npx reins` at the root cannot find it. Point at the installed CLI and the app's folder instead: `"command": "node", "args": ["<app>/node_modules/@mindmakr/reins/dist/cli.js", "bridge", "--dir", "<app>"]` (the root `node_modules` when the workspace hoists it).

## Step 7: Add bundle verification to `package.json` and verify

Update the `"build"` script in `package.json` so every production build checks that no reins dev code (`__REINS_DEV_ONLY__`) remains (inside npm scripts `reins` is on the path, so no `npx`):

- **Vite**: `"build": "vite build && reins verify dist"`
- **Next.js**: `"build": "next build && reins verify .next/static"`
- **Expo**: `"export:verify": "npx expo export && reins verify dist"`

Then run the production build: it exits `0` with `reins-verify-bundle: clean`. Run the tests for the files you changed, not the whole suite.

To export the app's actions, state and panels as `feature-map.json` for Coordinator, see `companion.md`.

## Step 8: Trim the agent prompt prefix (optional, ask first)

Every agent turn re-sends a fixed prefix of tool definitions, skill descriptions and MCP tool names, mostly plugins and skills the project never uses. If Coordinator 1.6.0 or later is installed (`installPath` of the `coordinator@coordinator` entry in `~/.claude/plugins/installed_plugins.json`), run its script for this project and show the person the draft before writing it:

```sh
node <installPath>/skills/coordinator/scripts/prefix.mjs report --project <dir>
node <installPath>/skills/coordinator/scripts/prefix.mjs draft --project <dir> --keep <plugins and skills the person names>
node <installPath>/skills/coordinator/scripts/prefix.mjs write --project <dir> --keep <the same> --confirm
```

Leave `--keep` out when the person names nothing. The script keeps reins (the project's `.mcp.json` names it) and writes only the project's `.claude/settings.local.json`; plugin changes need a new Claude process. Without Coordinator, skip this step: its rules live in Coordinator's `references/context.md`, rule 7.
