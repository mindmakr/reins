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

## Step 2: Install `reins`

Install the single package as a dev dependency (or via `npx expo install reins` in Expo):

```sh
npm i -D reins
```

(Use `pnpm add -D reins`, `yarn add -D reins`, or `bun add -d reins` to match the repo's lockfile.)

## Step 3: Wire the build plugin and token endpoint

Wire the build plugin **before** connecting the client so production builds always swap `reins` for `reins/stub`.

### Vite (`vite.config.ts`)

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import reins from 'reins/vite';

export default defineConfig({
  plugins: [reins(), react()],
});
```

### Next.js (`next.config.mjs` + `app/api/reins-token/route.ts`)

Wrap `nextConfig` in `next.config.mjs` (or `next.config.ts`):

```js
import { withReins } from 'reins/next';

export default withReins({
  // existing Next.js config
});
```

Create `app/api/reins-token/route.ts` (or `src/app/api/reins-token/route.ts`):

```ts
export { GET } from 'reins/next/token-route';
export const dynamic = 'force-dynamic';
```

### Expo (`metro.config.js`)

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withReins } = require('reins/metro');

module.exports = withReins(getDefaultConfig(__dirname));
```

## Step 4: Connect in dev mode and expose state adapters

### Vite / React entry (`src/main.tsx` or `src/index.tsx`)

```ts
import { reins } from 'reins';
import { zustand, reactQuery, routerLocation } from 'reins/adapters';

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
import { reins } from 'reins';
import { routerLocation } from 'reins/adapters';

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
import { connectExpo } from 'reins/expo';

if (__DEV__) {
  connectExpo();
}
```

### Optional: Node backend instrumentation (`reins/node`)

If the project runs a Node API server (Express, Connect, Fastify, or `http.createServer`), wire `reins/node` in dev mode so `reins_server`, `reins_perf` and `reins_report` join backend DB spans and event-loop lag with browser fetches via `x-reins-trace`:

```ts
import { reinsNode } from 'reins/node';

if (process.env.NODE_ENV !== 'production') {
  void reinsNode.connect({ meta: { name: 'api' } });
  app.use(reinsNode.middleware({ serverTiming: true }));
}

// Wrap DB or external queries in named spans (db.* counts toward dbMs):
const rows = await reinsNode.span('db.invoices.select', () => db.query('SELECT ...'));
```

### Optional: Tester session export (`reins/record`)

To let human QA testers record a session (`?reins=record`) and download `.md` + `.json` diagnostics in dev or private staging (`REINS_ENABLE=1`), add `recordFromUrl()` in the browser entry (`reins/vite`, `reins/next`, and `reins/metro` swap `reins/record` for `reins/record-stub` in production builds):

```ts
import { recordFromUrl } from 'reins/record';

if (import.meta.env.DEV) {
  recordFromUrl();
}
```

## Step 5: Register high-value actions and `<ReinsPanel>` boundaries

In the app's root shell or key feature components, import `useReinsAction`, `useReinsState` and `ReinsPanel` from `reins/react` (or `reins/expo` on React Native):

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
- **Consequential actions**:
  Any action that resets dev data, deletes records or triggers side effects must set `consequential: true`.
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

## Step 7: Add bundle verification to `package.json` and verify

Update the `"build"` script in `package.json` so every production build checks that no reins dev code (`__REINS_DEV_ONLY__`) remains:

- **Vite**: `"build": "vite build && reins verify dist"`
- **Next.js**: `"build": "next build && reins verify .next/static"`
- **Expo**: `"export:verify": "npx expo export && npx reins verify dist"`

Run the production build and `npx reins verify <build-dir>` (or `npx reins-verify-bundle <build-dir>`) to confirm the check exits `0` (`reins-verify-bundle: clean`), and run the project's test suite.
