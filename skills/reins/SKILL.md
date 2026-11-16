---
name: reins
description: Use when setting up reins in a new or existing web (Vite, Next.js, React), Node backend, or Expo app, when driving an app through reins MCP tools (actions, state, network, errors, perf timings, DOM/CSS layout, server spans, session reports, panel snapshots), when verifying production bundles strip reins, or when adding report-only flight checks to a production Node server.
---

# reins

**reins** gives coding agents instruments, hands, and eyes inside web, Expo, and Node apps: named actions, redacted state, network and error buffers, lifecycle and render timings (`reins_perf`), DOM/CSS layout checks (`reins_dom`), backend request and DB spans (`reins_server`), Markdown/JSON session reports (`reins_report`), and `<ReinsPanel>` screenshots over a localhost MCP bridge. **Flight** (`@mindmakr/reins/flight`) is the one part meant for production: it records a server's long-running work and reports where it broke its promises.

Built for [**Lucid Coding**](https://mindmakr.github.io/coordinator/lucid-coding.html) (Principles #2 and #8).

## Commands & Playbooks

Call `/reins:<command>` (Claude Code plugin) or `/reins <command>` (skill). Read the matching reference file first.

| Command | Use it to | Playbook |
|---|---|---|
| `setup` | Inspect a repo and wire `@mindmakr/reins` (frontend, optional `@mindmakr/reins/node` backend, optional `@mindmakr/reins/record`); the packages are listed in Step 2 | `references/setup.md` |
| `drive` | Drive actions, check what they changed, take one report per checkpoint, snap the panels the task names | `references/drive.md` |
| `verify` | Run the production build and verify that `@mindmakr/reins` and `@mindmakr/reins/record` were swapped for 0-marker stubs | `references/setup.md` (Step 7) |
| `flight` | Add report-only production checks to a Node server | `references/flight.md` |

Using reins with **Coordinator** (builder and blind visual critic, evidence, the feature map): `references/companion.md`.

Run the CLI from the project's install, `./node_modules/.bin/reins` (`references/drive.md`).

## Hard rules

1. **Build plugin first.** Wire `@mindmakr/reins/vite`, `@mindmakr/reins/next` or `@mindmakr/reins/metro` before `reins.connect()`, and add `reins verify <build-dir>` to the build script.
2. **Never bypass authentication or authorisation.** `login-as-tester` must use the real sign-in flow with dev-only env credentials.
3. **No secrets in actions or state.** Never hardcode tokens or return raw secrets from `run`.
4. **Mark consequential actions** (`references/setup.md`, Step 5). Pass `confirm: true` only after the person agrees.
5. **For a performance fix, measure before and after.** Take `reins_report` before and after, and compare them with `reins report --compare`.
6. **Development reins never ship.** Install `@mindmakr/reins` as a dev dependency; flight alone is a regular dependency (`references/flight.md`).
