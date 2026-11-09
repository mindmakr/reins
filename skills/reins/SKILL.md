---
name: reins
description: Use when setting up reins in a new or existing web (Vite, Next.js, React) or Expo app, when driving an app through reins MCP tools (actions, state, network, errors, panel snapshots), or when verifying production bundles strip reins.
---

# reins

**reins** gives coding agents hands and eyes inside a running web or Expo app: named actions with JSON schemas, redacted state snapshots, recent network calls and console/runtime errors, and pixel-exact `<ReinsPanel>` bounding boxes and screenshots over a localhost-only MCP bridge.

## Commands & Playbooks

Call `/reins:<command>` (Claude Code plugin) or `/reins <command>` (skill). Read the matching reference file first.

| Command | Use it to | Playbook |
|---|---|---|
| `setup` | Inspect a new or existing repo and wire `reins` end-to-end automatically | `references/setup.md` |
| `drive` | Drive actions, check state/network/errors, and snap panels across locales and widths | `references/drive.md` |
| `verify` | Run the production build and verify that `reins` was swapped for the 0-marker stub | `references/setup.md` (Step 7) |
| `companion` | Pair **reins** with **Coordinator** for Lucid Coding (builder + blind visual critic) | `references/companion.md` |

## One-package architecture (`npm i -D reins`)

Everything ships in the single `reins` package:

- `reins` — browser and React Native core (< 5 KB min+gzip, zero browser runtime dependencies)
- `reins/react` — `useReinsAction`, `useReinsState`, `<ReinsPanel id>`
- `reins/expo` — `connectExpo`, `<ReinsPanel id>`, `useReinsPanel`, `useReinsAction`, `useReinsState`
- `reins/adapters` — `zustand`, `redux`, `reactQuery`, `routerLocation`, `fromStore`
- `reins/vite` — `reinsPlugin()` (serves `/__reins/token` in dev, swaps `reins` to `reins/stub` in prod)
- `reins/next` and `reins/next/token-route` — `withReins(nextConfig)` and `GET` route handler
- `reins/metro` (and `reins/expo/metro`) — `withReins(metroConfig)` for Expo / React Native
- `npx reins bridge` — localhost (`127.0.0.1:7357`) WebSocket pairing hub and stdio MCP server
- `npx reins verify <dir>` / `npx reins-verify-bundle <dir>` — fails if `__REINS_DEV_ONLY__` is in a production build

## Hard rules

1. **Build plugin first.** Always wire `reins/vite`, `reins/next` or `reins/metro` before calling `reins.connect()`, and add `reins verify <build-dir>` to the build script so dev code can never ship to production.
2. **Never bypass authentication or authorisation.** Never register an action like `become-admin` or `skip-payment`. `login-as-tester` must go through the app's real sign-in flow using dev-only test credentials from environment variables.
3. **No secrets in actions or state.** Never hardcode tokens or passwords, and never return raw tokens from an action's `run` function.
4. **Mark destructive or state-mutating operations `consequential: true`.** Never pass `confirm: true` to `reins_run_action` without asking the person first.
5. **Prefer named actions over pixel clicking.** When driving an app, call `reins_list_actions` first and use `reins_run_action` to reach the target state, locale and screen before inspecting `reins_state`, `reins_network`, `reins_errors` and `reins_snap`.
