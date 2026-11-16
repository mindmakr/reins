# AGENTS.md: adding reins to an app

This page is for coding agents asked to add reins to a web or Expo app, or to work in this repository. For the full automated playbooks, read [`skills/reins/SKILL.md`](skills/reins/SKILL.md), [`skills/reins/references/setup.md`](skills/reins/references/setup.md), [`skills/reins/references/drive.md`](skills/reins/references/drive.md) and, for flight, [`skills/reins/references/flight.md`](skills/reins/references/flight.md).

**The production promise: production builds contain no development reins, and the flight entry (`@mindmakr/reins/flight`) is the only part of reins meant for production.** Keep both true in every change you make to an app or to this repository.

## Adding reins to an app

1. **Install the single dev package** (`npm i -D @mindmakr/reins`, or `npx expo install @mindmakr/reins` in Expo). What it provides is listed in [`setup.md`](skills/reins/references/setup.md), Step 2.
2. **Add the build plugin first** (`@mindmakr/reins/vite`, `@mindmakr/reins/next` or `@mindmakr/reins/metro`). It serves the pairing token in dev and swaps `@mindmakr/reins` for `@mindmakr/reins/stub` in production. Without it, production builds contain reins.
3. **Call `reins.connect()` once, in dev only**, behind `import.meta.env.DEV`, `process.env.NODE_ENV !== 'production'` or `__DEV__`. For Next, pass `tokenUrl: '/api/reins-token'` and add the token route (`@mindmakr/reins/next/token-route`). For Expo, call `connectExpo()` from `@mindmakr/reins/expo`.
4. **Add `reins verify <build dir>` (or `reins-verify-bundle <build dir>`) after the production build** in the build script and in CI.
5. **Add `.reins/` to `.gitignore`.** The bridge also writes `.reins/.gitignore`, but say it in the project file too.
6. **Register the MCP server** (`npx reins bridge`) in the project's agent config, such as `.mcp.json`.

## What to register

**Actions: the key flows a tester repeats.** Good actions:

- `login-as-tester`: signs in a seeded test account through the app's normal login, using credentials from a dev-only env file.
- `set-locale`, `set-theme`, `set-viewport-mode`.
- `open-screen` with a route name, `reset-onboarding`, `seed-cart` with a list of products.
- Read-only helpers, marked `readOnly: true`: `get-feature-flags`, `current-user-summary`.

Rules for actions:

- **Give every action a clear `description` and an object `input` schema.** The agent only sees these.
- **Mark consequential actions** as [`setup.md`](skills/reins/references/setup.md), Step 5, defines them.
- **Never register an action that skips authentication or authorisation**, like "become admin" or "skip payment". Not even "only in staging". Build the action on the app's real flows.
- **Do not put secrets in actions.** Read test credentials from dev-only env vars. Never hardcode them, and never return tokens from `run`.
- **Keep actions small and idempotent where you can**, so an agent can retry them.

**State: small, named snapshots.** Register the stores the agent needs to check results (`zustand(store)`, `redux(store)`, `reactQuery(client)`, `routerLocation()` from `@mindmakr/reins/adapters`, or a function). Keep secrets out of state sources. Redaction works on key names only.

**Panels: the screens worth comparing with designs.** Wrap them in `<ReinsPanel id="checkout">` from `@mindmakr/reins/react` (web) or `<ReinsPanel id="checkout">` from `@mindmakr/reins/expo` (a View with `testID`). Use stable, kebab-case ids that match screen names. Each `<ReinsPanel id>` also records its mount timestamp (`mountedAtMs`), latest render timestamp (`lastRenderMs`), and render count (`renders`) for `reins_perf`, and can be inspected on demand with `reins_dom({ panel: id })`.

## Flight on a production server

Flight (`@mindmakr/reins/flight`) records the steps of a server's long-running work, checks them against the promises in `reins.flight.json`, and reports findings. Follow [`skills/reins/references/flight.md`](skills/reins/references/flight.md): its rules (no personal value in a step name or key, no promise the person has not approved, flight never changes behaviour, nothing wired before the manifest is approved) and its install (a regular dependency, because it runs in production) live there.

Flight does not protect against a secret the app puts in a step name or process key, a store or report page shown without sign-in, a webhook address that points somewhere it should not, or anyone who already controls the server. See [SECURITY.md](SECURITY.md#what-flight-does-not-protect-against).

Keep the development imports (`reins.connect()`, `@mindmakr/reins/node`) behind the project's development check as before. Flight does not replace them and they never go to production.

## Staging

Only build with `REINS_ENABLE=1` for a private staging environment that the person asked for. Staging builds must not include test-only actions such as seeding or resetting data. Never set it for a public or production build.

## Working in this repository

- `npm run build`, `npm test` and `claude plugin validate .` must pass. CI runs build and tests on Node 18, 20 and 22.
- The browser/RN core entry (`packages/reins/src/index.ts`) has zero browser runtime dependencies and must stay under 5 KB min+gzip (`packages/reins/test/size.test.ts`). The DOM inspector (`packages/reins/src/dom.ts`) is a separate file that the core loads on the first `dom()` call; it has its own 1 KB limit.
- `skills/reins/SKILL.md` stays under 500 words and routes to `skills/reins/references/`.
- Guard all globals. Do nothing before pairing. Redact by default. No eval. No shell strings: use `execFileSync` with an argument array.
- The bridge only binds to `127.0.0.1`. Do not add a host option.
- Security changes need tests. Update `SECURITY.md` in the same change.
- Check a claim about another tool (Claude Code settings, a CLI flag, a file format) against that tool before writing it into a skill page: one skill step once described a settings key the CLI ignores.
- `src/cli.ts` loads each command's modules only when that command runs (`test/cli-startup.test.ts`): a one-shot command must not load the bridge or the MCP SDK.
- The flight entry (`packages/reins/src/flight.ts` and `src/flight/`) imports only Node built-ins and reins' shared modules, never the bridge, the pairing code, `ws` or the MCP SDK. `packages/reins/test/flight-safety.test.ts` walks its imports; keep it passing.
