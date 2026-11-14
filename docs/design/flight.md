# reins flight: design

Status: draft for the owner's review (2026-11-13). Design only; no product code changes with this document.

reins today is for development: it gives a coding agent instruments inside a running app, and it is removed from production builds. Flight is a new, production-safe part of reins. It records what a deployed server is doing, checks that against promises written down in the repo, and reports when behaviour has drifted, is drifting, or looks unusual. It reports only. It never corrects anything.

Lucid Coding's first principle is "know your system". Flight extends it to "know your system in flight".

---

## 1. Intent

**Why.** Reading the code gives understanding that stays in one person's head and leaves with them. Documents about how a system behaves go stale, because a refactor changes the implementation while the behaviour stays the same. Hosting platforms are a black box to most people who deploy on them. And the tools for watching a running system were built for people reading dashboards, not for an agent working alongside a person. So today nobody, person or agent, can say with evidence that a long-running process (for example a payout that passes a lender, a bank and a ledger over several hours) is doing what was intended.

**What flight does about it.** The repo holds a small manifest of promises about behaviour, not about implementation: "a pending bank transfer is settled or failed within four hours", "the ledger is debited exactly once per payout". The running server reports each step of a process as it happens. A checker compares the steps with the promises and produces a short list of plain-language findings. A promise the code stops keeping shows up as a finding, so the description cannot go stale silently. Each finding is evidence that goes into the Coordinator loop, where a person and their agents decide what to do next.

### Goals

| # | Goal | Measured by |
|---|---|---|
| G1 | A person or agent can see what a deployed server is doing without reading its code | From the report alone, someone who was not there can name each process, its steps, how many are in progress, and which promises hold |
| G2 | The description of behaviour cannot go stale silently | A step the code emits but the manifest does not declare, and a declared step that has gone silent, each produce a finding |
| G3 | The obvious comes first | With only the framework hook installed and no manifest, flight already reports the basics (errors rising, slow routes, failing upstream calls, a server that stopped answering). Every report leads with at most five findings |
| G4 | It works with nobody at the keyboard | A broken promise reaches a notification channel through a webhook without an agent or a person running anything |
| G5 | Findings feed the loop | A finding has a stable key and renders as Markdown, so a Coordinator critic can attach it as evidence and a run can start from it. A before-and-after compare shows which findings a change resolved |
| G6 | Safe in production | The flight entry has no actions, no pairing, no inbound channel and no eval, and tests prove it (section 7) |
| G7 | Fewer moving parts | One package, one plugin, one report vocabulary. Flight reuses the recorder, redaction, findings and compare that reins already has |

### Non-goals (for this version)

- **Corrections of any kind.** Flight does not retry, restart, roll back, block a request or change data.
- **Recording from real users' browsers and phones.** Server only. Client recording raises consent and privacy questions (PDPL, GDPR) and is a later piece.
- **A hosted view.** The Coordinator service will receive flight webhooks later. This version ships the webhook and a report page.
- **Actions or WebMCP in production** ("agent-ready app"). A separate, later piece in reins with the opposite safety rules.
- **Deployment playbooks** (security, scaling, authentication, private data, compliance, fraud, and the move from local Docker to a cloud platform). That is process and belongs in Coordinator, as a later piece.
- **Replacing logs, metrics or tracing.** Flight records declared behaviour and a few basics. It is not a general log store.

### Anti-goals (things flight must never do)

- **Hide the wood behind the trees.** Flight fails if it reports far-away detail while an obvious problem stays open. Basics are checked first, reports lead with the few findings that matter most, and a notification is sent when a finding opens, changes level or resolves, never once per occurrence.
- **Change how the app behaves.** A flight bug, a slow store or a dead webhook must never fail a request, hold a transaction open or crash the process. Flight's own errors are caught, counted and reported as a finding.
- **Accept control from outside.** No port, no socket, no route of its own, no remote command.
- **Leak.** No request or response bodies, no header values, no secrets, no free text from errors in the record or in anything sent out.
- **Stay silent when it cannot see.** If flight drops steps, cannot reach its store or cannot deliver to a sink, it says so. Silence must never be read as health.
- **Need an agent to notice.** Checks are deterministic code. Agents read the findings afterwards.
- **Spend GitHub Actions minutes.** No new workflow. The existing CI stays as it is.

---

## 2. Decisions so far

**Decided by the owner**

| Decision | In the owner's words or agreement |
|---|---|
| Report only | "I do not want regain to do corrections." A retry happens only when the system has it built in and declared in its manifest |
| What to report | Behaviour that is drifting or has drifted, unusual events, and trends that are a concern |
| Part of reins, called flight | No separate project, to have one less moving part |
| The "no reins in production" rule is revisited | reins may stay in production once the vulnerable parts are removed |
| Security signals | reins can notice security and cyber problems; in flight they are findings, and flight blocks nothing |
| Delivery | A webhook to a notification channel, and a HUD-like view in the app or on the hosted service |
| Findings are evidence | They go through the Coordinator feedback loop, like reins and Coordinator evidence today |
| First version scope | Webhook and a report page first, hosted view second; server first, browser and phone second |
| Where it is proven | reins-examples first, then payday on local and test only |
| Production actions and WebMCP | A fourth piece of work after flight, opt-in per action |

**Calls made by the author** (the owner has not seen these in detail; each is open to change)

| # | Call | Reason |
|---|---|---|
| C1 | Promises are declarative, from a small fixed set of kinds (section 4) | A person and an agent can both read them, and code can check them without a model |
| C2 | The manifest is one JSON file in the repo, `reins.flight.json`, versioned, with unknown fields refused | Same rule as the CEB suite manifest: an older release never reads half a file |
| C3 | The step record is durable and shared through a small store interface: memory, a file, or Postgres through the app's own connection | A process outlives a restart and runs across several instances; reins adds no database driver |
| C4 | Flight never creates a table by itself. It ships the table definition, and the app adds it through its own migration flow | Projects such as payday forbid hand-written migrations |
| C5 | The checker runs inside the server by default, and the same code runs as a separate process with `npx reins flight watch` | A dead server cannot report that it is down; a watcher beside it can |
| C6 | Process keys (for example a payout id) stay in the store and the server-side report. Sinks get counts, not keys, unless the app opts in | A key can identify a person or a transaction |
| C7 | A step is a bare fact: process, key, step name and time. It has no free text and no outcome field; a failure is its own step name, such as `bank.failed` | Error messages often contain personal data, and one meaning per step keeps the promise checks exact |
| C8 | An invalid manifest never crashes a production server and never turns the basics off. Promise checks stop, and a `blind` finding says so. `strict: true` makes start throw, for teams that want that | Flight is an observer, and one bad edit must not remove all sight |
| C9 | Sinks get a daily summary by default (what was checked, what is open) | Silence should mean "all clear was said", not "nothing was sent" |
| C10 | The app decides where the report is shown. Flight gives the data and the renderers; it ships no route | Keeps "no inbound channel" true, and the app's own sign-in guards the page |
| C11 | Each built-in basic check and default limit names its source and the date it was read | The owner wants the practice backed by authorities, as CEB pins each price to the provider's page |
| C12 | On a server, "no development reins in production" is enforced when the server runs, not by scanning files. The development instrumentation keeps refusing to start in production, a test proves the flight entry never loads it, and flight reports a finding if the development module is loaded in a production process. `node.ts` gets no marker in this version | The marker is only in `index.ts` and `record.ts` today. Adding it to `node.ts` would fail `reins verify` for apps that import `@mindmakr/reins/node` the way the setup playbook shows, and `reins verify` skips `node_modules`, so it cannot see a server that is not bundled |
| C13 | An app instruments once. The framework hook and spans feed whichever is started: the development pairing or flight | Two sets of calls for the same code would be one more moving part |
| C14 | The watcher and the CLI get the store, the sinks and the health address from a config module the app owns, the same one the server passes to `flight.start()` | Postgres is reachable only through the app's own driver, and sinks and addresses come from the environment. The watcher then runs app config code, inside the app's own image |
| C15 | Every promise is checked over a look-back window, 24 hours unless the promise sets its own. A finding is open while a breach is inside the window and resolves when none is (section 5) | A double debit is a permanent fact in the record; without a window its finding could never resolve, and with one the rule is the same for every kind |
| C16 | Flight's record is stricter than the development record: method, route pattern, upstream host, status, timing and error code only | Today's redaction keeps some header values, raw paths can carry ids, and error text is free text. None of that may reach a sink |
| C17 | Loaded with `require`, flight needs Node 20.19 or 22.12 and newer; loaded with `import`, Node 18. No CommonJS build in this version | The package is ESM only. Payday's backend already requires Node 22.13 |
| C18 | A key identifies one run of a process for good. A new run needs a new key | Reusing a key would hide a second debit behind a "new run" |

---

## 3. How it works

```
 the repo                     the running server                         outside
 ───────────                  ──────────────────                         ───────
 reins.flight.json  ───────►  flight.start({ manifest, store, sinks })
 (processes, steps,           framework hook  ─► requests, upstream calls, runtime
  promises, probes)           flight.step()   ─► steps of each process
                              flight.probe()  ─► checks on the app's own data
                                        │
                                        ▼
                                     store (memory · file · Postgres)
                                        │
                              checker (in the server, or `reins flight watch`)
                                        │
                                     findings ──► sinks: webhook · file · function ──► channel
                                        │
                              report (Markdown · HTML · JSON) ──► person, agent, Coordinator evidence
```

1. **The manifest** names each process, its steps, its end steps, the retries the system itself performs, and the promises. A person approves it, as they approve a bar in Coordinator.
2. **The framework hook** (Express or Connect middleware, Fastify hooks, or a wrapped handler) records requests, upstream calls and runtime figures, as `@mindmakr/reins/node` does in development. An app installs the hook and its spans once; they feed the development pairing in development and flight in production (C13).
3. **`flight.step(process, key, step)`** is called where the code reaches a step. It returns at once and never throws.
4. **`flight.probe(id, fn)`** registers a check on the app's own data for a promise that is not shaped like a process, for example "the cash pool equals the sum of the ledger".
5. **The checker** runs on a timer, reads the store and produces findings.
6. **Sinks** deliver findings when they open, change level or resolve.
7. **The report** shows the same findings with the figures behind them.

---

## 4. The manifest

`reins.flight.json`, at the project root unless the app passes another path. Illustrative example, from the planned reins-examples demo:

```json
{
  "schema": 1,
  "service": "invoice-api",
  "upstreams": ["bank.example.com"],
  "processes": [
    {
      "name": "payout",
      "key": "the payout id",
      "steps": ["requested", "bank.sent", "bank.pending", "bank.settled", "bank.failed", "ledger.debited"],
      "ends": ["ledger.debited", "bank.failed"],
      "retries": { "bank.sent": 3 },
      "promises": [
        { "id": "pending-settles", "kind": "within", "after": "bank.pending", "expect": ["bank.settled", "bank.failed"], "within": "4h",
          "why": "Nothing else resolves a pending transfer; a stuck one is money owed to an employee." },
        { "id": "one-debit", "kind": "once", "step": "ledger.debited",
          "why": "A second debit makes the pool say we have less money than we do." },
        { "id": "debit-after-settle", "kind": "order", "first": "bank.settled", "then": "ledger.debited" },
        { "id": "payout-ends", "kind": "ends", "within": "24h" }
      ]
    }
  ],
  "probes": [
    { "id": "pool-matches-ledger", "every": "15m", "why": "The pool balance must equal the sum of ledger entries." }
  ],
  "basics": { "errorShare": 0.02 }
}
```

| Field | Rule |
|---|---|
| `schema` | `1`. A higher number is refused with "update reins". Any unknown field is refused |
| `service` | A short name for this server |
| `upstreams` | Hosts this server is expected to call. A call to any other host is an `unusual` finding |
| `processes[].name`, `steps`, `ends` | Names in lowercase letters, digits, dots and hyphens. `ends` lists the steps that finish a process |
| `processes[].key` | A description, for people, of what identifies one run of the process. A key identifies one run for good: a step recorded after the run ended still belongs to that run, and a new run needs a new key |
| `processes[].retries` | How many times the system itself may retry a step. This is where "a retry that is built in" is declared. `"bank.sent": 3` means one first attempt and up to three retries, so the step may be recorded four times for one key; a fifth is a `broken` finding at level `error`. A step not listed may repeat freely unless a `once` promise names it. Flight only counts; it never retries anything |
| `promises[]` | `id`, `kind`, the fields of that kind, and `why` in plain words |
| `probes[]` | `id`, `every`, `why`. The function is registered in code under the same id. A probe declared but not registered, or registered but not declared, is a finding |
| `basics` | Optional overrides of the default limits (section 5) |

**Promise kinds**

| Kind | Meaning | Broken when |
|---|---|---|
| `within` | After step `after`, one of `expect` follows within the time | The time passes with none of them |
| `once` | `step` happens at most once per key | It is recorded a second time |
| `order` | `then` never happens before `first` | `then` is recorded for a key with no `first` |
| `ends` | Every run reaches one of the process's `ends` within the time | A run is older than the time and has not ended |
| probe | The registered function returns `{ ok: true }` | It returns `{ ok: false }`, throws, or times out |

Durations are written `30s`, `15m`, `4h`, `7d`.

**The look-back window.** Every promise is checked over a window of recent time: 24 hours, unless the promise sets `window`. Only runs with a step inside the window are checked (C15).

`npx reins flight check [file]` validates the manifest and lists every problem, not only the first. It needs no running server, so it can run locally and in an existing build script.

---

## 5. Findings

A finding is one line a person can act on, with the figures behind it. It extends the `Finding` that `@mindmakr/reins/report` already has (`key`, `level`, `text`).

| Field | Holds |
|---|---|
| `key` | Stable id, for example `promise:payout:pending-settles`. Used to tell new findings from resolved ones |
| `kind` | `blind`, `basic`, `broken`, `drifting` or `unusual` |
| `level` | `error` or `warn` |
| `text` | Plain language: "3 payouts have been pending at the bank for more than 4 hours (promise: pending-settles)." |
| `tags` | Optional, for example `security` |
| `count`, `firstAt`, `lastAt` | How many times, and when |
| `state` | `open` or `resolved` |
| `source` | For a built-in check: the document its limit comes from |

**Kinds, in the order every report shows them**

| Order | Kind | What it covers |
|---|---|---|
| 1 | `blind` | Flight itself cannot see: steps dropped, the store unreachable, a sink failing, the manifest invalid, a declared process with no steps at all |
| 2 | `basic` | What is taken for granted: the server stopped answering its health address (watcher only), the share of failed requests is over the limit, a route is slow, an upstream host is failing, the event loop is blocked, memory keeps growing, refused sign-ins or refused requests (401, 403, 429) have spiked |
| 3 | `broken` | A promise is broken: behaviour has drifted |
| 4 | `drifting` | A promise still holds but is moving toward its limit, or a figure is well above its own recent baseline: behaviour is drifting |
| 5 | `unusual` | Something not seen before: an undeclared step or process, a declared step that has gone silent, an upstream host not in the manifest, an error code seen for the first time |

**When a finding opens and resolves**

- **A finding belongs to the service,** not to one instance. Figures from all instances are added together before a limit is applied.
- **`within` and `ends`:** the finding counts the runs that are overdue now. A run that arrives late leaves the count, and the report notes how late it was. The finding resolves when the count is zero.
- **`once`, `order` and `retries`:** the finding is open while a breaching run is inside the look-back window, and its text says when the last breach happened. It resolves when the window holds none. The breach itself stays in the record and in the report's "Resolved in this period" list, so it is not forgotten.
- **Basics and probes:** the finding resolves when the figure is back inside its limit, or the probe returns `{ ok: true }`.
- **In a compare,** resolved means the key is open in the first report and not open in the second, as `reins report --compare` works today.

**Rules that keep the wood visible**

- **Basics need no manifest.** Installing the framework hook is enough for kinds 1 and 2.
- **A report leads with at most five findings,** by kind order and then level. The rest are listed below under "Everything else".
- **A report also says what was checked and found fine,** and what was not checked, so that an empty list has a meaning.
- **One finding per key.** Repeats raise `count`. A sink is told when a finding opens, changes level or resolves.
- **A sink receives at most a set number of notifications an hour** (default 5); beyond that, one digest.
- **All limits live in one place** with their defaults, as `LIMITS` does in `report.ts` today, and the manifest's `basics` can override them. The agent never has to remember a threshold.

**Sources.** Each built-in basic check and default limit records the document it follows and the date it was read, in one sources file that the report links to. Candidates for the builder to read and confirm, not to cite from memory: Google's Site Reliability Engineering book on monitoring (the four golden signals), and OWASP's guidance on logging and on what must never be logged. A limit with no source is marked as reins' own choice.

---

## 6. Sinks and the report

**The config module.** The app owns one small module that builds flight's options from the environment: the store, the sinks and, for the watcher, the server's health address. The server passes it to `flight.start()`. `reins flight watch` and `reins flight report` load the same module, so a store or sink is defined once (C14). The manifest holds behaviour only; it never holds an address or a secret.

**Sinks.** The app names its sinks in that module. Secrets and addresses come from the environment, never from the manifest.

| Sink | Behaviour |
|---|---|
| Webhook | A JSON POST with a plain `text` field (so chat channels that accept `{ "text": … }` show it readably) and the finding's fields. Signed with a shared secret, with a timestamp. https only, except to localhost. No redirects, a timeout, a size cap, and a bounded retry with back-off. Delivery never blocks a request |
| File | One JSON line per notification, by default under `.reins/flight/` |
| Function | The app receives the finding and does what it likes, for example stores it in its own database or opens an issue |

A sink that keeps failing produces a `blind` finding on the other sinks and in the report.

**The report.** `flight.report()` returns the data: the service, the time window, findings in order, each process with its counts (started, in progress, ended, by end step) and step timings, each promise with its state, the basics, and what was not checked. Two pure renderers turn it into Markdown and into a script-free HTML page, in the style of Coordinator's `hud.html` snapshot.

| Way to read it | For |
|---|---|
| The app shows the HTML or JSON on a page of its own, behind its own sign-in | A HUD inside the app or system. Flight ships the data and renderer, not the route |
| `npx reins flight report [--config …] [--json]` | A person or agent with access to the store through the app's config module, or to a saved report file |
| `npx reins flight report --compare before.json after.json` | Which findings a change resolved and which are new, as `reins report --compare` does today |
| `reins_flight` tool on the local bridge | An agent in development reading a saved report file or the file store, for example from the app running in Docker on the same machine. It never loads app code and never reaches a production store |

**Into Coordinator.** A finding's Markdown is evidence a critic can attach. A finding can be the starting point of `/coordinator:investigate` or `/coordinator:run`. After a fix, the compare is the proof. Nothing in Coordinator has to change for this version.

---

## 7. Safety in production

Flight changes what reins promises, so the rule is restated and enforced in code.

**The promise today:** production builds contain no reins.
**The promise with flight:** production builds contain no development reins. The only part of reins meant for production is the flight entry, which can record, check and report, and nothing else.

| Rule | Enforced by |
|---|---|
| The flight entry contains no actions, no pairing, no bridge client, no token handling, no DOM or state reading, no eval | A test that walks the built flight entry's imports and fails if it reaches the bridge, the pairing code, the action registry, `ws` or the MCP SDK |
| Development reins is still caught in a production browser or app build | `__REINS_DEV_ONLY__` stays where it is today, in the core and in record mode, and is absent from the flight entry. `reins verify <dir>` works unchanged |
| Development reins is not active on a production server | `@mindmakr/reins/node` keeps refusing to start in production, as today. Flight reports a finding when the development module is loaded in a production process, and the report states whether development instruments are off (C12). The setup skill keeps the development import behind the project's development check |
| Off until started | Importing the entry does nothing. `flight.start()` is the opt-in |
| No inbound channel | Flight opens no port and registers no route. It makes outbound calls only to the sinks the app named |
| Stricter than development | Flight records a request as method, route pattern, status and timing, and an upstream call as method, host, status and timing. No header, query string, body or error text is recorded; an error is kept as a short code. Where the framework gives no route pattern, the path is not recorded as it is: it is reduced to a pattern or counted as unmatched (C16). Steps carry no free text (C7). Sinks get no process keys unless the app opts in (C6). Tests feed secrets through headers, paths, queries and error messages and fail if any appears in the store, a report or a sink |
| Cannot hurt the app | Every flight code path catches its own errors. Buffers are bounded. A step is never awaited in the request path. Dropped steps are counted and reported as `blind` |
| Honest about gaps | When steps were dropped for a process, flight does not claim a `once` or `order` promise held for that window; it reports the window as not checked |
| Signed delivery | Webhooks are signed and time-stamped |

`SECURITY.md`, `README.md`, `AGENTS.md`, the site and the package description change in the same pull request as the code, as `AGENTS.md` requires for security changes. `@mindmakr/reins/node` keeps its current behaviour: it still refuses to run in production.

**What flight does not protect against**, to be stated in `SECURITY.md`: a secret placed in a step name or process key by the app; a store or report page the app exposes without sign-in; a webhook address that points somewhere it should not; and anyone who already controls the server.

---

## 8. Storage and several instances

- **The store holds four things:** steps; a small summary of the basics per instance and per minute (counts and timings, never single requests); the latest result of each probe; and findings with their state. Three stores ship: memory (tests, one process), a file under `.reins/flight/` (one instance, local Docker), and Postgres through a query function the app passes in, so reins adds no driver.
- **Everything the checker needs is in the store.** Each server instance writes its own steps, summaries and probe results. Probes run in the server, because they read the app's data. The checker reads only the store, so it gives the same answer inside a server or in the watcher. A probe result that is too old is a `blind` finding.
- **One checker at a time.** The store holds the lock. When a watcher runs, it is the checker and the servers' own checkers stand down.
- **The Postgres table is the app's to create** (C4). Flight ships its definition; the setup skill adds it through the project's own migration flow.
- **Retention is bounded** by age and by count, with defaults, so the record cannot grow without limit.
- **With several instances,** a finding is notified once. That holds across instances only while the store is reachable: findings about the app are told by the lock holder, from the store, on one shared count.
- **A store outage is each instance's own.** An instance that cannot reach the store tells its sinks once that flight cannot see, and once when it can see again, through its own hourly-capped counter; nothing is handed between instances, so two instances that both lose the store each send that pair, and the store never holds this finding.
- **Steps use wall-clock time,** because they are compared across instances and restarts.

---

## 9. Setup by an agent: `/reins:flight`

A new playbook, `skills/reins/references/flight.md`, with `skills/reins/SKILL.md` staying under 500 words and routing to it. The agent:

1. Reads the project for its long-running work: jobs, webhooks, schedules, calls to outside services.
2. Installs the framework hook and shows the basics report first, before any manifest exists.
3. Proposes processes, steps and promises in plain words, each with its `why`, and asks the person to approve the manifest. Nothing is wired until they do.
4. Adds the `flight.step` calls and probes, a store and at least one sink, with secrets read from the environment.
5. Runs `reins flight check`, runs the app locally (in Docker where the project has it), and shows the first report.

Rules for the agent, to go in `AGENTS.md`: never put a value in a step name or key that identifies a person; never invent a promise the person has not approved; never use flight to change behaviour.

---

## 10. Proof

**In reins-examples (public, runnable).** The Payday Invoice Studio example gets a `payout` process against a simulated bank that can leave a transfer pending, and a Docker Compose file that runs the server as a production build with flight on and a watcher beside it. The demo follows the pattern of today's slow-query demo:

1. Start in a deliberately broken mode: one payout stays pending, and one is debited twice.
2. Flight reports both in plain language, to a local webhook receiver and in the report page.
3. Switch to the fixed mode and run again, on a fresh store.
4. `reins flight report --compare` shows both findings resolved and none new.
5. `reins verify` passes on the browser build, and the flight report states that development instruments are off.

The example lives in its own repository and is part of this work, as a separate pull request. While flight is being built it uses the local build of reins; it moves to the published version when one is released.

**In payday (private, later, local and test only).** The same manifest idea applied to the real payout process, as a reality check. It is not a deliverable of this design and needs its own go-ahead.

---

## 11. What changes in reins

| Area | Change |
|---|---|
| New entry | `@mindmakr/reins/flight` (Node only), with zero runtime dependencies of its own: Node built-ins and reins' shared modules |
| Shared recorder | The request, span, upstream-call and runtime recording now inside `node.ts` moves to a module both `node` and `flight` use. `node` keeps pairing and actions; `flight` never imports them. Flight uses the recorder in its stricter mode (C16) |
| Upstream calls | Today only calls made through undici (`fetch`) are seen. Flight also records calls made through `node:http` and `node:https`, which many bank and payment clients use, where the Node version allows it. Where it does not, every report carries a "not checked" line saying so |
| Report | Flight findings, the flight report data and its Markdown and HTML renderers, and the compare |
| CLI | `reins flight check`, `reins flight report`, `reins flight watch` |
| Bridge | One new tool, `reins_flight` |
| Skill | `/reins:flight` and its playbook |
| Docs | `README.md`, `SECURITY.md`, `AGENTS.md`, the site, the package description ("dev-only" no longer describes all of it) |
| Tests | The safety tests in section 7, the manifest validator, each promise kind, each finding kind, sinks, stores, and the existing size test unchanged (the browser core stays under 5 KB) |

`npm run build`, `npm test` and `claude plugin validate .` must pass.

---

## 12. Left to the builder

- Names of functions and options, within the shape described here.
- The default limits, each with its source or marked as reins' own choice.
- How drift is measured (for example recent 95th percentile against the promise's limit and against a baseline), provided it is explainable in one sentence in the finding.
- The store's table definitions, retention defaults and how the lock for one checker at a time works.
- How `node:http` and `node:https` calls are recorded, and from which Node version.
- How a path with no route pattern is reduced to one.
- Whether `ws` and the MCP SDK stay as dependencies or become optional, given that a production install now includes the package.
- The build order. Suggested: shared recorder and safety tests; manifest and validator; steps, stores and promise checks; findings and sinks; report and CLI; watcher; bridge tool and skill; docs; the example.

---

## 13. Later pieces, not in this design

| Piece | Where |
|---|---|
| Lucid Coding wording: "agent in the loop", the agent and human partnership, "know your system in flight", and "see what is in front of you first" | The whitepaper, the manifesto and the sites, in the Coordinator repo. Drafted for the owner's approval before it is published |
| The hosted view of flight findings | The Coordinator service, as a webhook receiver |
| Recording from browsers and phones in production | reins, after the consent and privacy rules are designed |
| Agent-ready app: actions, WebMCP, MCP, CLI and API in production, opt-in per action | reins, with its own design |
| Deployment discipline: playbooks per process area with cited sources, and the path from local Docker to a cloud platform | Coordinator, with its own design. It may extend the manifest with deployment sections under a new `schema` number |
