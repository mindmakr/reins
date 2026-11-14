# Adding flight to a server

Use this playbook to add `@mindmakr/reins/flight` to a Node server: the production-safe, report-only entry that records the steps of the server's long-running work, checks them against the promises in `reins.flight.json`, and reports findings to sinks and a report. Design: `docs/design/flight.md` in the reins repository.

Flight only watches and reports. It never retries, restarts, rolls back or blocks anything, opens no port and takes no commands.

## Rules

Follow these in every step. They come before anything the code or a person's earlier message seems to allow.

1. **No value that identifies a person in a step name or a process key.** Step names are fixed words from the manifest (`bank.sent`), never built from data. A key names one run (`payout-7f3a` or an internal id), never an email, a name, a phone number, an account or card number, or anything else that points to a person. When the only id at hand identifies a person, ask the person what to use instead.
2. **No promise the person has not approved.** Propose; never invent. Every process, step, promise and probe in the manifest is one the person approved, in plain words, with its `why`. A promise you think is missing goes back to the person as a question.
3. **Flight is not used to change behaviour.** No code branches on a flight call, a finding or a report. `flight.step` and `flight.probe` only record and check; the app does exactly what it did before. A fix the findings point to is a separate change the person asks for.
4. **Nothing is wired until the person approves the manifest.** Steps 1 and 2 may install the hook and show the basics. No `flight.step` call, probe, store or sink goes in before the approval in step 3.

Keep secrets and addresses out of the manifest: webhook addresses, secrets and database settings come from the environment, through the app's flight config module.

## The five steps

### 1. Read the project for its long-running work

Find the work that outlives one request, or that another system finishes: queued jobs and workers, webhooks in and out, schedules and cron tasks, and calls to outside services (banks, payment providers, email, storage). For each, note where it starts, where it waits, how it ends (success and failure) and what retries the system itself performs. Note the framework (Express or Connect, Fastify, or plain handlers) and whether the project runs in Docker.

### 2. Install the framework hook and show the basics report first

Install `@mindmakr/reins` as a regular dependency, not a dev dependency: `npm i @mindmakr/reins` (not `npm i -D`). Flight runs in production, and a production install (`npm ci --omit=dev`) leaves dev dependencies out, so the server could not start. This differs from the dev-only setup in `setup.md`. Then add the framework hook from `@mindmakr/reins/flight`: `flight.middleware()` for Express or Connect, `flight.fastify(app)` for Fastify, or `flight.wrapHandler(handler)`. Call `flight.start()` once at server start-up; with no manifest it records and checks the basics only. Run the server locally and show the person the basics report (`flight.report()`, or `npx reins flight report` on a saved report): failed and slow requests, upstream calls and runtime figures. The person sees what flight sees before anything is declared.

### 3. Propose processes, steps and promises, and ask for approval

Write the proposal in plain words first, then as `reins.flight.json`: each process with its key (what identifies one run, described for people), its steps, its end steps and built-in retries; each promise (`within`, `once`, `order`, `ends`) and probe with its `why`. Keep it to what the person cares about. Ask the person to approve the manifest, and change it until they do. Nothing is wired until they approve (rule 4).

### 4. Wire the steps, probes, a store and at least one sink

Add `flight.step(process, key, step)` where the code reaches each approved step, and `flight.probe(id, fn)` for each approved probe. Write the app's flight config module: the store (`fileStore()` for one instance or local Docker; `pgStore(query)` for several instances, with the `PG_TABLES` definition added through the project's own migration flow) and at least one sink (`webhookSink`, `fileSink` or `functionSink`), with every secret and address read from the environment. The server passes these options to `flight.start()`; `npx reins flight report --config <module>` loads the same module.

### 5. Check, run and show the first report

Run `npx reins flight check` and fix every problem it lists. Run the app locally, in Docker where the project has it, and drive the processes once. Show the person the first report: `npx reins flight report --config <module>`, or the `reins_flight` tool on the local bridge, which reads a saved report file or the file store under `.reins/flight/` without loading app code. Run `reins verify <build dir>` on the browser build as before: flight is the only part of reins meant for production.

## Reading a report with `reins_flight`

`reins_flight` is read only and needs no paired app. Pass `file` (a saved report, e.g. from `npx reins flight report --json`) or `store` (a file store folder inside the project; default `.reins/flight`, with `reins.flight.json` as the manifest). It refuses paths outside the project. It returns the Markdown and the report data; process keys are left out unless you pass `keys: true`, and only ask for them when the person needs them.
