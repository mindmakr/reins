# Contributing

Thanks for helping. reins is small on purpose, so please keep changes small and readable.

## Setup

```sh
git clone https://github.com/mindmakr/reins.git
cd reins
npm install
npm run build
npm test
```

Node 18 or newer. Tests use vitest and run against the sources, so `npm test` works before a build. The CLI test for `reins-verify-bundle` runs only after `npm run build`.

## Layout

Everything ships as one package, `packages/reins`, with one entry file per import path:

```
packages/reins/src/
  index.ts            `reins`: the core (browser and React Native, no dependencies)
  stub.ts             `reins/stub`: what production builds get instead
  react.ts, expo.ts   hooks and <ReinsPanel> for web and React Native
  adapters.ts         state sources for Zustand, Redux, TanStack Query and routers
  vite.ts, next.ts, next-token-route.ts, metro.ts   build plugins and token routes (Node)
  node.ts             `reins/node`: backend instrumentation (Node)
  record.ts, record-stub.ts   tester record mode and its production stand-in
  report.ts           session reports, shared by the bridge and record mode (no Node or DOM imports)
  verify.ts, verify-cli.ts    `reins verify` and `reins-verify-bundle`
  bridge/             `reins bridge`: WebSocket hub, MCP tools, audit log, snaps, session files
  cli.ts              the `reins` command
packages/reins/test/  one test file per area; all run against the sources
```

A new import path needs an entry in `exports` in `packages/reins/package.json`, an alias in `vitest.config.ts`, and, if app code imports it and it carries dev code, a stub and an entry in each build plugin.

## Rules

- **The core stays under 5 KB min+gzip and has no runtime dependencies.** It is at about 4.5 KB. The DOM inspector already lives in its own file (`src/dom.ts`), loaded on the first `dom()` call. `packages/reins/test/size.test.ts` checks this. If you add to the core, take something out or put it in a separate entry, like `reins/adapters`.
- **Guard every global.** The core runs in browsers, React Native and Node. Do not touch `window`, `document` or `navigator` without checking they exist.
- **Nothing happens before pairing.** No listeners, patches or globals until the bridge accepts the token. Add a test when you touch this.
- **Redact by default.** New data sources must redact values unless the key is allowlisted.
- **No eval and no shell strings.** In Node code, run programs with `execFileSync` and an argument array.
- **The bridge binds to 127.0.0.1.** Do not add a host option.
- Security-related changes need tests, not only docs. Update [SECURITY.md](SECURITY.md) and the README's security section in the same PR.

## Pull requests

1. One change per PR, with a test.
2. `npm run build` and `npm test` pass on your machine before you open the PR. CI runs both on Node 18, 20 and 22 for pull requests into `main`.
3. Write commit messages and docs plainly: say what changed and why.

Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Licence and contributor agreement

reins is [MIT](LICENSE). Before your first pull request is merged, agree to the [contributor agreement](CLA.md) by ticking its box in the pull request. You keep ownership of your work. The names are covered by the [trademark policy](TRADEMARKS.md).
