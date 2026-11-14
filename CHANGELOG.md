# Changelog

## 0.2.0 (2026-11-14)

### The production promise changes

Production builds contain no development reins, and the flight entry, `@mindmakr/reins/flight`, is the only part of reins meant for production. Before 0.2.0 the promise was "production builds contain no reins". The development tools are unchanged: the build plugins still swap them for stubs in production builds, `reins verify` still fails a build that holds them, and `@mindmakr/reins/node` still refuses to start in production. [SECURITY.md](SECURITY.md) lists flight's safety rules and the test behind each.

### Added

- **`@mindmakr/reins/flight`** (Node only, ESM): a report-only entry for production servers. `flight.start()` records requests, upstream calls and runtime figures through the framework hook (`flight.middleware()`, `flight.fastify(app)`, `flight.wrapHandler(handler)`), in a stricter form than development: method, route pattern, status, timing and error code only. `flight.step(process, key, step)` records the steps of long-running work, and `flight.probe(id, fn)` registers checks on the app's own data.
- **The manifest, `reins.flight.json`**: processes, steps, end steps, built-in retries, and promises of four kinds (`within`, `once`, `order`, `ends`), each with a `why`, plus probes and overrides of the default limits. Unknown fields are refused.
- **Findings** of five kinds (`blind`, `basic`, `broken`, `drifting`, `unusual`), with the limits and their sources in one place (`LIMITS`, `SOURCES`).
- **Three stores**: memory, a file under `.reins/flight/` (one machine), and Postgres through the app's own query function (`pgStore({ query })`, tables in `PG_TABLES`). Retention by age and count.
- **Three sinks**: a signed webhook (Standard Webhooks), a JSON-lines file and a function. At most 5 notifications an hour per sink, then a digest, and a daily summary.
- **The report**: `flight.report()` and pure Markdown and HTML renderers (`renderFlightMarkdown`, `renderFlightHtml`), and `compareFlightReports`.
- **CLI**: `reins flight check`, `reins flight report` (from the app's config module, a saved report, or `--compare`) and `reins flight watch` (the checker beside the server, with a health address).
- **Bridge**: a 12th MCP tool, `reins_flight`, that reads a saved flight report or the file store under the project, read only.
- **Skill**: `/reins:flight` and its playbook, `skills/reins/references/flight.md`.

### Changed

- The request, span, upstream-call and runtime recording moved from `node.ts` to a shared recorder (`src/recorder.ts`) that `@mindmakr/reins/node` and `@mindmakr/reins/flight` both use. An app installs the hook once.
- Upstream calls made through `node:http` and `node:https` are recorded too, where the Node version allows it.
- Package and plugin descriptions, the README, SECURITY.md, AGENTS.md and the site state the new production promise.

### Install

A server that uses flight installs `@mindmakr/reins` as a regular dependency (`npm i @mindmakr/reins`). That also installs `ws` and the MCP SDK, which only `npx reins bridge` uses; the flight entry never loads them. The development tools stay a dev install (`npm i -D @mindmakr/reins`).

### Known limits

- A watcher takes over when a server stops renewing the checker lock; it does not yet always take precedence over a server that keeps renewing.
- With several server copies, a store outage is alerted by each copy on its own.
- See [SECURITY.md](SECURITY.md) for the late write past a lease, clock skew between copies, and what flight does not protect against.

## 0.1.0

The version before flight: the core, React and Expo hooks, the Vite, Next and Metro plugins, `@mindmakr/reins/node`, record mode, session reports, the MCP bridge with 11 tools, and `reins verify`.
