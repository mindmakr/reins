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

(Use `pnpm add -D @mindmakr/reins`, `yarn add -D @mindmakr/reins`, or `bun add -d reins` to match the repo's lockfile.)

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

## Step 8: Trim the agent prompt prefix for this project (optional, ask first)

Every agent turn re-sends a fixed prefix: tool definitions, the name and description of every enabled skill, agent types, MCP tool names and server instructions, plus project instructions and memory. One measured run put it near 72k tokens, about 15% of the run's cost, mostly plugins and skills the project never uses. Offer a per-project trim after the wiring works. Do it only for the app's project, never for the user level.

**If the coordinator plugin ships the script, use it.** Find the plugin folder: `installPath` of the first `coordinator@coordinator` entry under `plugins` in `~/.claude/plugins/installed_plugins.json`. If `<installPath>/skills/coordinator/scripts/prefix.mjs` exists (older Coordinator versions do not have it), run it with `node`: `prefix.mjs report --project <dir>`, then `prefix.mjs draft --project <dir> --keep reins,<named>`, then, after the person approves the draft, `prefix.mjs write --project <dir> --keep reins,<named> --confirm`. Put `reins` and every plugin and skill the person named in `--keep`, on both `draft` and `write`. The script does the same measure, draft and write as the steps below: it trims user skills only (not plugin skills, which go with their plugin) and adds the exclude line itself. Compare its draft with step 2 before the person approves. If the plugin or the script is missing, do the manual steps below.

1. **Measure.** List what loads here and how big it is:
   - Enabled plugins: `claude plugin list`, or the `enabledPlugins` keys in `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json`.
   - User skills: the folders under `~/.claude/skills`. Many are links (symlinks or junctions). Follow them (`statSync`, not `Dirent.isDirectory()`), skip names that start with `.` and the `synced` folder.
   - MCP servers: the project `.mcp.json`, and the user config (`mcpServers` in `~/.claude.json`, and `projects["<project dir>"].mcpServers` in the same file), or run `claude mcp list`. Names only: never print their `env` or `headers`.
   - Report the counts of plugins, skills and MCP servers, and the description characters of the skills. For the real number, ask the person to run `/context` and give the prefix tokens (the system prompt, tools, skills and MCP rows). If they cannot, say the tokens were not measured.
2. **Decide keep and off.** Keep: **reins** (this plugin), every server in the project's own `.mcp.json`, every plugin named in the project's `.claude/settings.json`, and anything the person names (ask which plugins and skills they use, and repeat their list back in the draft). Propose off the rest that the project does not use. Say why for each group, in a line.
3. **Draft, show, then write.** Draft `.claude/settings.local.json` in the project. Merge it into the file if one exists, and never drop a key that is there:
   - `enabledPlugins`: `{ "<plugin>@<marketplace>": false }`
   - `skillOverrides`: `{ "<skill>": "off" }` for a user or project skill, keyed by its bare name as the skill list shows it. `"name-only"` keeps the name and drops the description, a lighter cut for a skill the person might still call. Claude Code ignores `skillOverrides` for plugin skills, so a plugin's skills go only by turning the whole plugin off in `enabledPlugins`.
   - Only if the person agrees: `syncClaudeAiSkills: false`, `syncClaudeAiPlugins: false`, `disableClaudeAiConnectors: true`.

   Show the draft, and write it only after the person approves. Never turn off reins, a project `.mcp.json` server, or a plugin or skill the person names, and never edit the user-level `~/.claude/settings.json`.
4. **Keep it out of git.** Append `.claude/settings.local.json` to `.git/info/exclude` (or to `.gitignore` if the person prefers), unless it is already there.
5. **Tell the person.** Plugin changes load only in a new Claude process: `/clear` reloads skill overrides but keeps the old plugins. To undo, delete the keys, or delete `.claude/settings.local.json`.
6. **Check after.** In the new process the skill list is short. Record the counts (or the `/context` figure) before and after in the run's notes.
