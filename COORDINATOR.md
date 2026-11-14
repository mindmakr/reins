# Coordinator context

Facts for [Coordinator](https://github.com/mindmakr/coordinator) runs in this repo, each with its source. No secrets.

## Work flow
- Base branch `main`; work goes on a feature branch and reaches `main` through one pull request (CONTRIBUTING.md, "Pull requests").
- `main` is treated as protected: never push to it directly (owner, 2026-11-13). GitHub does not enforce this today.
- Units of a run stack on the run's feature branch and are merged into it locally as they pass, so CI runs once, on the pull request (owner, 2026-11-13).
- CI (`.github/workflows/ci.yml`) runs build and tests on Node 18, 20 and 22 for pull requests into `main` only, and skips docs-only changes. Each run is 3 jobs. Do not add or change a workflow without asking (owner's rule on Actions minutes).
- One change per pull request, with a test; commit messages say what changed and why (CONTRIBUTING.md).

## Checks
- Typecheck and build: `npm run build` (runs `tsc` in `packages/reins`). There is no lint step.
- Tests: `npm test` (vitest, runs against the sources). The `reins-verify-bundle` CLI test runs only after a build (CONTRIBUTING.md).
- Plugin: `claude plugin validate .` (AGENTS.md).
- Mapped tests: one test file per area in `packages/reins/test/`. Builders and critics run `npx vitest related --run <changed files>` or the area's file, plus `npm run build`.
- Full suite, once per unit head, run by the lead: `npm run build && npm test && claude plugin validate .`.
- Nothing needs a database or a service. Local Node is 22; Node 18 and 20 are proven only by CI on the pull request.

## Risk areas
- Security, on every change to the core, the bridge, record mode, `node` or `flight`: nothing happens before pairing, redaction by default, no eval, no shell strings (`execFileSync` with an argument array), the bridge binds to 127.0.0.1 only (AGENTS.md, CONTRIBUTING.md).
- Production safety: production builds contain no development reins; `reins verify` must keep catching it (SECURITY.md, AGENTS.md).
- Size: the core entry stays under 5 KB min+gzip and the DOM inspector under 1 KB (`packages/reins/test/size.test.ts`).
- Globals are guarded: the core runs in browsers, React Native and Node (CONTRIBUTING.md).
- Security changes need tests, and `SECURITY.md` and the README's security section change in the same pull request (AGENTS.md).
- `skills/reins/SKILL.md` stays under 500 words (AGENTS.md).
- Screens: the site (`docs/index.html`) and any generated report page are checked at phone and desktop width.

## Review
- Coordinator's review playbook at full depth, plus a security specialist critic (`ecc:security-reviewer`) on any unit that touches a risk area above.
- Ready means: every behaviour passes with evidence, the full suite passes on the head, and no high or medium finding is open.

## Standing rules
- A run may merge its units into its own feature branch when they pass.
- Merging into `main`, publishing to npm, tagging and releasing are approved per run, never standing.

## Never
- Push to `main` directly, force-push a shared branch, or publish to npm without the owner.
- Add a host option to the bridge, or set `REINS_ENABLE=1` for a public or production build (AGENTS.md).
- Add or re-enable a GitHub Actions workflow without asking.

## Isolation
- One git worktree per unit under `D:/projects/mindmakr/wt-reins-<unit>`, with `npm ci` at its root. No `node_modules` junctions.
- No shared database or fixed port: tests listen on port 0. A check that needs Postgres uses a throwaway Docker container on its own port, removed when done.

Theme: docs/site.css
