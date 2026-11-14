# @mindmakr/reins

Give coding agents the reins: development tools to drive, inspect and debug web and Expo apps, and a report-only flight entry for Node servers.

**Production builds contain no development reins. The flight entry, `@mindmakr/reins/flight`, is the only part meant for production.** It records, checks and reports, and nothing else.

- `@mindmakr/reins`: the core (actions, state, network and error buffers, panels and WebMCP). No dependencies, under 5 KB min+gzip. Install the development tools with `npm i -D @mindmakr/reins`; the build plugins swap the core for an empty stub in production builds, and `reins verify` checks it.
- `@mindmakr/reins/flight`: records the steps of a server's processes, checks them against the promises in `reins.flight.json`, and reports findings to sinks and a report. It runs in production, so a server that uses it installs the package as a regular dependency: `npm i @mindmakr/reins`.

See the [main README](https://github.com/mindmakr/reins#readme) for setup, and [SECURITY.md](https://github.com/mindmakr/reins/blob/main/SECURITY.md) for the security model and flight's safety rules.

Flight (`@mindmakr/reins/flight` and `npx reins flight watch`) is ESM only: loaded with `import` it needs Node 18 or newer; loaded with `require` it needs Node 20.19 or 22.12 and newer (design C17).

MIT © mindmakr
