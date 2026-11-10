# Using reins with Coordinator (Lucid Coding)

[**Coordinator**](https://mindmakr.github.io/coordinator/) ([`mindmakr/coordinator`](https://github.com/mindmakr/coordinator)) and **reins** are designed as companions for [**Lucid Coding**](https://mindmakr.github.io/coordinator/lucid-coding.html) — building software with agents where you see how each agent read the problem, what it built, and how an independent blind critic judged it against a verifiable bar.

## The 8 Lucid Coding Principles

1. **Know your system.** If you cannot say what your agents changed, why, and what proved it, you don't know your system yet. Every other principle serves this one.
2. **Give agents instruments, not just screenshots.** A screenshot shows pixels; it hides why they are slow, broken or clipped. Let your app report its own actions, state, network calls, lifecycle timings (`reins_perf`) and DOM and CSS layout (`reins_dom`) in development, and strip that instrumentation from production.
3. **Agree the bar before the build.** Write down what done means, as behaviours someone else can check, before anyone starts.
4. **A blind critic, never the builder, grades the work.** A separate critic, who never sees the builder's reasoning, checks the real result against the bar.
5. **Evidence or it didn't happen.** A pass carries its proof: test output, a screenshot (`reins_snap`), a lifecycle or API timing (`reins_perf`), a DOM layout check (`reins_dom`), a log, a link.
6. **Every run is visible.** What the agent saw, what it built, and why it passed or failed stay on the record while the run is live and after it ends.
7. **Every run teaches the next.** Repeated gaps become lessons for the next brief, and past runs set the next budgets.
8. **Get the work done; performance comes with experience and measurement.** Finish the work to the bar first. Then measure what actually happened: when the page painted, when each component mounted, how long each API call took, and where the layout clipped. Speed and token cost improve from numbers on the record, not guesses.

## How Coordinator and reins fit together

| Role | What Coordinator does | What reins adds |
|---|---|---|
| **Intake & Bar** | Agrees the quality bar up front as testable *given / when / then* behaviours before any code is written. | Names the exact actions, state sources and `<ReinsPanel id>` ids each behaviour will be checked against. |
| **Builder** (`/coordinator:fix`) | Builds the unit in an isolated git worktree and runs tests. | Registers or updates `useReinsAction`, `reins.state`, `<ReinsPanel>`, and `reinsNode.span('db.*')`, drives the app via `reins_run_action`, `reins_perf`, `reins_dom`, and `reins_server`, and compares before/after sessions with `npx reins report --compare`. |
| **Blind Code & Visual Critics** (`/coordinator:review`, `/coordinator:visual`) | A separate agent — who never sees the builder's reasoning — checks the real running app against every behaviour in the bar. | Calls `reins_list_actions`, `reins_run_action` (e.g. switching locales `en` → `ar` and themes), asserts `reins_state`, `reins_network`, `reins_errors`, `reins_perf`, `reins_dom`, `reins_server` and `reins_report`, and attaches `reins_snap` PNGs and session Markdown reports as durable evidence (`run.mjs evidence`). |
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
