# AGENTS.md: adding reins to an app

This page is for coding agents asked to add reins to a web or Expo app, or to work in this repository.

## Adding reins to an app

1. **Install the dev packages** for the stack (see the README's setup): `reins`, `@reins/react` or `@reins/expo`, the build plugin (`@reins/vite`, `@reins/next` or `@reins/expo/metro`), and `@reins/bridge` and `@reins/verify` as dev dependencies.
2. **Add the build plugin first.** It serves the pairing token in dev and swaps reins for a stub in production. Without it, production builds contain reins.
3. **Call `reins.connect()` once, in dev only**, behind `import.meta.env.DEV`, `process.env.NODE_ENV !== 'production'` or `__DEV__`. For Next, pass `tokenUrl: '/api/reins-token'` and add the token route. For Expo, call `connectExpo()`.
4. **Add `reins-verify-bundle <build dir>` after the production build** in the build script and in CI.
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
- **Mark anything that changes real data, spends money, sends messages or deletes things as `consequential: true`.** Callers must then pass `confirm: true`, and an agent should ask the person first.
- **Never register an action that skips authentication or authorisation**, like "become admin" or "skip payment". Not even "only in staging". Build the action on the app's real flows.
- **Do not put secrets in actions.** Read test credentials from dev-only env vars. Never hardcode them, and never return tokens from `run`.
- **Keep actions small and idempotent where you can**, so an agent can retry them.

**State: small, named snapshots.** Register the stores the agent needs to check results (`zustand(store)`, `redux(store)`, `reactQuery(client)` from `reins/adapters`, or a function). Keep secrets out of state sources. Redaction works on key names only.

**Panels: the screens worth comparing with designs.** Wrap them in `<ReinsPanel id="checkout">` (web) or `<ReinsPanel id="checkout">` from `@reins/expo` (a View with `testID`). Use stable, kebab-case ids that match screen names.

## Staging

Only build with `REINS_ENABLE=1` for a private staging environment that the person asked for. Staging builds must not include test-only actions such as seeding or resetting data. Never set it for a public or production build.

## Working in this repository

- `npm run build` and `npm test` must pass. CI runs them on Node 18, 20 and 22.
- The core (`packages/reins`) has no dependencies and must stay under 5 KB min+gzip (`test/size.test.ts`).
- Guard all globals. Do nothing before pairing. Redact by default. No eval. No shell strings: use `execFileSync` with an argument array.
- The bridge only binds to `127.0.0.1`. Do not add a host option.
- Security changes need tests. Update `SECURITY.md` in the same change.
