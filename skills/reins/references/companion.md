# Using reins with Coordinator (Lucid Coding)

[**Coordinator**](https://mindmakr.github.io/coordinator/) ([`mindmakr/coordinator`](https://github.com/mindmakr/coordinator)) and **reins** are designed as companions for [**Lucid Coding**](https://mindmakr.github.io/coordinator/lucid-coding.html) — building software with agents where you see how each agent read the problem, what it built, and how an independent blind critic judged it against a verifiable bar.

## How they fit together

| Role | What Coordinator does | What reins adds |
|---|---|---|
| **Intake & Bar** | Agrees the quality bar up front as testable *given / when / then* behaviours before any code is written. | Names the exact actions, state sources and `<ReinsPanel id>` ids each behaviour will be checked against. |
| **Builder** (`/coordinator:fix`) | Builds the unit in an isolated git worktree and runs tests. | Registers or updates `useReinsAction`, `reins.state` and `<ReinsPanel>`, and drives the app via `reins_run_action` to self-check. |
| **Blind Code & Visual Critics** (`/coordinator:review`, `/coordinator:visual`) | A separate agent — who never sees the builder's reasoning — checks the real running app against every behaviour in the bar. | Calls `reins_list_actions`, `reins_run_action` (e.g. switching locales `en` → `ar` and themes), asserts `reins_state`, `reins_network` and `reins_errors`, and attaches `reins_snap` PNGs from `.reins/snaps/` as durable evidence (`run.mjs evidence`). |
| **Production Gate** | Refuses to pass a unit if build or security checks fail. | `reins verify` (`reins-verify-bundle`) guarantees zero dev marker (`__REINS_DEV_ONLY__`) in production bundles. |

## Installing Coordinator alongside reins

In Claude Code:

```text
/plugin marketplace add mindmakr/coordinator
/plugin install coordinator@coordinator
/plugin marketplace add mindmakr/reins
/plugin install reins@reins
```

Then in your project:

1. Run `/reins:setup` once to wire `reins`, its build plugin, `reins verify`, and `.mcp.json`.
2. Run `/coordinator:init` once to record the project's commands, locales, panels and reins actions in `COORDINATOR.md`.
3. Run `/coordinator:run <task>` to build and verify features unattended through builders and blind critics that drive your app through **reins**.
