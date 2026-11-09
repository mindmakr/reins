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

```
packages/
  reins/    core (browser and React Native, no dependencies)
  react/    hooks and <ReinsPanel>
  expo/     React Native glue and the Metro helper
  vite/     Vite plugin
  next/     Next.js wrapper and token route
  bridge/   `reins bridge`: WebSocket + MCP server (Node)
  verify/   `reins-verify-bundle` (Node)
```

## Rules

- **The core stays under 5 KB min+gzip and has no runtime dependencies.** `packages/reins/test/size.test.ts` checks this. If you add to the core, take something out or put it in a separate entry, like `reins/adapters`.
- **Guard every global.** The core runs in browsers, React Native and Node. Do not touch `window`, `document` or `navigator` without checking they exist.
- **Nothing happens before pairing.** No listeners, patches or globals until the bridge accepts the token. Add a test when you touch this.
- **Redact by default.** New data sources must redact values unless the key is allowlisted.
- **No eval and no shell strings.** In Node code, run programs with `execFileSync` and an argument array.
- **The bridge binds to 127.0.0.1.** Do not add a host option.
- Security-related changes need tests, not only docs. Update [SECURITY.md](SECURITY.md) and the README's security section in the same PR.

## Pull requests

1. One change per PR, with a test.
2. `npm run build` and `npm test` pass. CI runs both on Node 18, 20 and 22.
3. Write commit messages and docs plainly: say what changed and why.

Please report security problems privately, as described in [SECURITY.md](SECURITY.md).
