---
name: reins
description: Use when setting up reins in a new or existing web (Vite, Next.js, React), Node backend, or Expo app, when driving an app through reins MCP tools (actions, state, network, errors, perf timings, DOM/CSS layout, server spans, session reports, panel snapshots), or when verifying production bundles strip reins.
---

# reins

**reins** gives coding agents instruments, hands, and eyes inside web, Expo, and Node apps: named actions, redacted state, network and error buffers, lifecycle and render timings (`reins_perf`), DOM/CSS layout checks (`reins_dom`), backend request and DB spans (`reins_server`), Markdown/JSON session reports (`reins_report`), and `<ReinsPanel>` screenshots over a localhost MCP bridge.

Built for [**Lucid Coding**](https://mindmakr.github.io/coordinator/lucid-coding.html) — Principle #2 (*"Give agents instruments, not just screenshots"*) and Principle #8 (*"Performance comes with measurement"*).

## Commands & Playbooks

Call `/reins:<command>` (Claude Code plugin) or `/reins <command>` (skill). Read the matching reference file first.

| Command | Use it to | Playbook |
|---|---|---|
| `setup` | Inspect a repo and wire `reins` (frontend, optional `reins/node` backend, optional `reins/record`) | `references/setup.md` |
| `drive` | Drive actions, check state/network/errors/perf/DOM/server, snap panels, and save session reports | `references/drive.md` |
| `verify` | Run the production build and verify that `reins` and `reins/record` were swapped for 0-marker stubs | `references/setup.md` (Step 7) |
| `companion` | Pair **reins** with **Coordinator** for Lucid Coding (builder + blind visual critic) | `references/companion.md` |

## One-package architecture (`npm i -D reins`)

Everything ships in the single `reins` package:

- `reins` — browser/RN core (< 5 KB min+gzip, 0 browser deps): `action`, `state`, `panel`, `markComponent`, `perf`, `dom`
- `reins/react` — `useReinsAction`, `useReinsState`, `<ReinsPanel id>` (tracks mount time & render counts)
- `reins/expo` — `connectExpo`, `<ReinsPanel id>`, `useReinsPanel`, `useReinsAction`, `useReinsState`
- `reins/node` — dev-only Node backend middleware (`middleware`, `wrapHandler`, `fastify`), `span('db.*')`, `Server-Timing`, and `x-reins-trace` correlation
- `reins/record` — opt-in tester recording (`?reins=record` or `startRecording()`) to export `.md`/`.json` sessions without a bridge
- `reins/report` & `npx reins report [--compare a.json b.json]` — Markdown/JSON session reports and before/after regression diffs
- `reins/adapters` — `zustand`, `redux`, `reactQuery`, `routerLocation`, `fromStore`
- `reins/vite`, `reins/next`, `reins/metro` — bundler plugins (serve token in dev, swap to stubs in prod)
- `npx reins bridge` — localhost (`127.0.0.1:7357`) WebSocket hub and stdio MCP server (11 tools)
- `npx reins verify <dir>` — fails if `__REINS_DEV_ONLY__` is in a production build

## Hard rules

1. **Build plugin first.** Wire `reins/vite`, `reins/next` or `reins/metro` before `reins.connect()`, and add `reins verify <build-dir>` to the build script.
2. **Never bypass authentication or authorisation.** `login-as-tester` must use the real sign-in flow with dev-only env credentials.
3. **No secrets in actions or state.** Never hardcode tokens or return raw secrets from `run`.
4. **Mark mutating operations `consequential: true`.** Never pass `confirm: true` without asking the person first.
5. **Measure before and after.** Call `reins_list_actions` first, drive with `reins_run_action`, inspect `reins_perf`, `reins_dom`, `reins_server`, and capture `reins_report` diffs for performance fixes.
