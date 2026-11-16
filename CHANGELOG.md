# Changelog

## Unreleased

### Faster for agents

- **The CLI loads only the command it runs.** `reins verify`, `report`, `exec`, `scenario`, `packet`, `fuzz`, `map` and `flight` no longer load the bridge and the MCP SDK: a call starts in about 75 ms instead of about 260 ms (`reins exec` in about 130 ms). `test/cli-startup.test.ts` keeps it so.
- **The playbooks send agents to fewer calls.** After an action, the drive playbook checks only what the action should change, and takes one `reins_report` (or `reins packet --text`) per checkpoint instead of six tools after every action; snaps no longer need `reins_panel_box` and `reins_dom` first (`reins_snap` scrolls the panel itself). Agents run the CLI from `./node_modules/.bin/reins`: `npx` spent about half a second per call finding the package. The one-shot commands (`scenario`, `packet`) are in the drive playbook, with the scenario file format.

### Fixed

- **A request is recorded once when both request hooks are installed.** With the development `reinsNode.middleware()` and flight's hook on one server, every request was recorded twice; a second hook (or a second `fastify(app)`) now passes a captured request through, since one capture feeds every recorder.
- **Flight refuses a process key holding an email address or a card number** (15 to 19 digits from 3 to 6 that pass the Luhn check), counted as invalid, so neither reaches a store. Timestamps and generated ids are not caught; names, phone and account numbers still rely on the playbook's rule (SECURITY.md).
- **The skill's text matches the code.** `bun add -d @mindmakr/reins` (it named the wrong package); `companion` is a page, not a command; the skill's description covers flight; the packages are listed once (`setup.md`, Step 2) and "consequential" is defined once (Step 5), with the other pages linking to them; snaps say they need Playwright and `--cdp`, with the `.mcp.json` arguments; what to do when the bridge port is taken; a bridge for an app in a monorepo subfolder; `reins_list_actions`'s `servers` and `target: "server"`; Step 7 verifies the build only and runs the tests for the changed files; Step 8 runs Coordinator's `prefix.mjs` instead of repeating its rules; the companion page links the Lucid Coding principles instead of an outdated copy and describes `verdict --reins-packet` and the feature map.
- **Timing tests wait for the event, not a fixed time.** The probe tests run on fake timers, the sink tests wait for the slow write to start and land, and the watcher test for two passes, so they hold on a loaded machine; the secrets test (B11), which checks what is kept and not speed, gets 20 s instead of the 5 s default. A byte-order mark in `manifest.ts` is written as `﻿`.

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
