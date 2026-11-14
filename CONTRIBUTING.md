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
  index.ts            `@mindmakr/reins`: the core (browser and React Native, no dependencies)
  stub.ts             `@mindmakr/reins/stub`: what production builds get instead
  react.ts, expo.ts   hooks and <ReinsPanel> for web and React Native
  adapters.ts         state sources for Zustand, Redux, TanStack Query and routers
  vite.ts, next.ts, next-token-route.ts, metro.ts   build plugins and token routes (Node)
  node.ts             `@mindmakr/reins/node`: backend instrumentation (Node, development only)
  recorder.ts         the request, span, upstream-call and runtime recorder shared by `node` and `flight`
  flight.ts           `@mindmakr/reins/flight`: the production-safe, report-only entry (Node)
  flight/             flight's parts, imported by flight.ts or the CLI:
    manifest.ts         reins.flight.json: the validator and durations
    steps.ts            the step writer: bounded buffer, flush, dropped counts
    store.ts            the store interface, retention and the memory store
    file-store.ts       the file store and its lock (one machine)
    pg-store.ts         the Postgres store and PG_TABLES
    probes.ts           flight.probe: registry and runs with a time limit
    checker.ts          the checker pass: promises, probes and blind facts from the store
    findings.ts         findings from a check: kinds, levels, open and resolved
    limits.ts           every default limit, with its range and source
    sources.ts          the documents the basic checks and limits follow
    sinks.ts            webhook, file and function sinks, and the notifier
    report.ts           the report data
    render.ts           the Markdown and HTML renderers, and the compare
    check-cli.ts        `reins flight check`, and the `reins flight` commands
    report-cli.ts       `reins flight report`, and loading the app's config module
    watch-cli.ts        `reins flight watch`
  record.ts, record-stub.ts   tester record mode and its production stand-in
  report.ts           session reports, shared by the bridge and record mode (no Node or DOM imports)
  verify.ts, verify-cli.ts    `reins verify` and `reins-verify-bundle`
  bridge/             `reins bridge`: WebSocket hub, MCP tools, audit log, snaps, session files
    flight.ts           the read-only `reins_flight` tool
  cli.ts              the `reins` command
packages/reins/test/  one test file per area; all run against the sources
```

A new import path needs an entry in `exports` in `packages/reins/package.json`, an alias in `vitest.config.ts`, and, if app code imports it and it carries dev code, a stub and an entry in each build plugin.

## Rules

- **The core stays under 5 KB min+gzip and has no runtime dependencies.** It is at about 4.5 KB. The DOM inspector already lives in its own file (`src/dom.ts`), loaded on the first `dom()` call. `packages/reins/test/size.test.ts` checks this. If you add to the core, take something out or put it in a separate entry, like `@mindmakr/reins/adapters`.
- **Guard every global.** The core runs in browsers, React Native and Node. Do not touch `window`, `document` or `navigator` without checking they exist.
- **Nothing happens before pairing.** No listeners, patches or globals until the bridge accepts the token. Add a test when you touch this.
- **Redact by default.** New data sources must redact values unless the key is allowlisted.
- **No eval and no shell strings.** In Node code, run programs with `execFileSync` and an argument array.
- **The bridge binds to 127.0.0.1.** Do not add a host option.
- **Flight stays report only and free of development reins.** `src/flight.ts` and `src/flight/` import Node built-ins and reins' shared modules only; `test/flight-safety.test.ts` walks the imports. Flight opens no port, registers no route and never retries, restarts, rolls back or blocks anything.
- Security-related changes need tests, not only docs. Update [SECURITY.md](SECURITY.md) and the README's security section in the same PR.

## Pull requests

1. One change per PR, with a test.
2. `npm run build` and `npm test` pass on your machine before you open the PR. CI runs both on Node 18, 20 and 22 for pull requests into `main`.
3. Write commit messages and docs plainly: say what changed and why.

Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Licence and contributor agreement

reins is [MIT](LICENSE). Before your first pull request is merged, agree to the [contributor agreement](CLA.md) by ticking its box in the pull request. You keep ownership of your work. The names are covered by the [trademark policy](TRADEMARKS.md).
