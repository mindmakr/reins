# Using reins with Coordinator (Lucid Coding)

[**Coordinator**](https://mindmakr.github.io/coordinator/) ([`mindmakr/coordinator`](https://github.com/mindmakr/coordinator)) and **reins** are designed as companions for [**Lucid Coding**](https://mindmakr.github.io/coordinator/lucid-coding.html) — building software with agents where you see how each agent read the problem, what it built, and how an independent blind critic judged it against a verifiable bar.

## What reins adds to Lucid Coding

The principles are on the [Lucid Coding page](https://mindmakr.github.io/coordinator/lucid-coding.html); this page keeps only what reins adds to two of them. **Instruments, not screenshots** (#2): the app reports its own actions, state, network, lifecycle timings (`reins_perf`) and layout (`reins_dom`) in development, and production builds carry none of it (`reins verify`). **Measure what happened** (#8): `reins_report` before and after a fix, and `reins report --compare`, put the numbers on the record.

## How Coordinator and reins fit together

| Role | What Coordinator does | What reins adds |
|---|---|---|
| **Intake & Bar** | Agrees the quality bar up front as testable *given / when / then* behaviours before any code is written. | Names the exact actions, state sources and `<ReinsPanel id>` ids each behaviour will be checked against. |
| **Builder** (`/coordinator:fix`) | Builds the unit in an isolated git worktree and runs tests. | Registers or updates `useReinsAction`, `reins.state`, `<ReinsPanel>`, and `reinsNode.span('db.*')`, drives the app via `reins_run_action`, `reins_perf`, `reins_dom`, and `reins_server`, and compares before/after sessions with `reins report --compare`. |
| **Blind Code & Visual Critics** (`/coordinator:review`, `/coordinator:visual`) | A separate agent — who never sees the builder's reasoning — checks the real running app against every behaviour in the bar. | Calls `reins_list_actions`, `reins_run_action` (e.g. switching locales `en` → `ar` and themes), asserts `reins_state`, `reins_network`, `reins_errors`, `reins_perf`, `reins_dom`, `reins_server` and `reins_report`, and attaches `reins_snap` PNGs and session Markdown reports as durable evidence (`run.mjs evidence <run> <unit> --kind reins --file .reins/sessions/<report>.md`; for a fix, also the output of `reins report --compare <before.json> <after.json> --out compare.md`). Coordinator reads the Findings out of those files and shows them on the unit's page. A packet from `reins packet` goes on the verdict as `--reins-packet <packet.json>`, where undeclared `reins_state` transitions fail the round (Coordinator's `references/bar.md`). |
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

1. Run `/reins:setup` once to wire `@mindmakr/reins`, its build plugin, `reins verify`, and `.mcp.json`.
2. Run `/coordinator:init` once to record the project's commands, locales, panels and reins actions in `COORDINATOR.md`.
3. Run `/coordinator:run <task>` to build and verify features unattended through builders and blind critics that drive your app through **reins**.

## The feature map for Coordinator

With the dev app running and paired, `reins map` writes the app's actions, state sources and `<ReinsPanel>` ids to `feature-map.json`, and `reins map --static .coordinator/runs/<run>/map/map.json --out feature-map.json` merges Coordinator's project map into it. Coordinator uses it for a unit's statechart and its bar checks (Coordinator's `references/bar.md`). The file carries no dev marker, so `reins verify` still exits `0`.
