# Security

reins lets an AI agent control a running app in development, and with flight it also watches a server in production. This page says what each part does, what it does not do, and how to report a problem.

## The production promise

**Production builds contain no development reins. The flight entry, `@mindmakr/reins/flight`, is the only part of reins meant for production.** It can record, check and report, and nothing else: no actions, no pairing, no bridge client, no token handling, no DOM or state reading, no eval, no port and no route.

Before flight (0.1.0) the promise was "production builds contain no reins". The rules that keep development reins out of production builds have not changed, and `reins verify` works as before. Flight is a separate entry that the app imports only on its server, on purpose.

## What reins does in development

- **Production builds do not contain development reins.** The core only turns on in dev builds (`__DEV__`, `import.meta.env.DEV`, or `NODE_ENV` other than `production`). `@mindmakr/reins/vite`, `@mindmakr/reins/next` and `@mindmakr/reins/metro` swap `@mindmakr/reins` and `@mindmakr/reins/record` for empty stubs in production builds. `reins-verify-bundle <dir>` fails if the marker `__REINS_DEV_ONLY__` appears in any built file, including source maps and Hermes bytecode. Run it in CI after every production build. The flight entry carries no marker.
- **The browser core does nothing until paired.** No patches and no listeners until the bridge accepts a token. The one exception is record mode, which a person turns on themselves (see below). The token is 192 random bits. The bridge writes it to `.reins/token`, which has its own `.gitignore`, and renews it after each pairing. It is deleted when the bridge stops. The bridge prints the path of the token file, never the token.
- **The bridge is local only.** It binds to `127.0.0.1`, with no option to change that. It refuses WebSocket upgrades from origins that are not localhost or on the `--origin` list. Clients that send no Origin, like React Native, still need the token. `--browser-only` refuses them.
- **The token route refuses cross-site requests.** It answers 403 when `Sec-Fetch-Site` is `cross-site` or `same-site`. Other sites cannot read it anyway, because it sends no CORS headers.
- **Redacted by default.** Bodies, `Authorization`, `Cookie` and `Set-Cookie` headers, storage values, cookie values, sensitive query values and sensitive state keys show as `[redacted]` unless you allowlist them.
- **Consequential actions need `confirm: true`.**
- **Audit log.** Every agent call, pairing, refusal and in-page call goes to `.reins/audit.log`, with arguments redacted.
- **No eval.** Only registered actions run.

## Record mode (`@mindmakr/reins/record`)

- **It only exists in builds that already contain reins**: dev builds, or a private staging build made with `REINS_ENABLE=1`. Production builds get `@mindmakr/reins/record-stub`, and `reins verify` fails if the real one is present.
- **A person has to turn it on**: by opening the page with `?reins=record` (when the app calls `recordFromUrl()`), or with a button that calls `startRecording()`. It then patches `fetch` and listens for errors in that browser tab, without a bridge.
- **Nothing is sent anywhere.** The session stays in the tab until the person clicks Export, which downloads a Markdown and a JSON file to their own machine. It uses the same redaction as the core.
- **In a staging build, any visitor can add `?reins=record`.** They can only record their own session in their own browser, but this is one more reason to keep `REINS_ENABLE=1` builds private.

## Backend instrumentation (`@mindmakr/reins/node`)

- **It refuses to start when `NODE_ENV` is `production`**, unless `REINS_ENABLE=1`. An unset `NODE_ENV` counts as development, as it does for most Node tools, so call `reinsNode.connect()` behind your own dev check as well. Flight does not change this.
- **It records nothing until the bridge pairs**, like the browser core. Until the bridge on `127.0.0.1` accepts the token from `.reins/token`, the middleware passes requests straight through, spans just run their function, and no `Server-Timing` header is sent. Recording stops again when the bridge goes away. Once paired it keeps, in fixed-size buffers in memory, recent requests (method, URL with sensitive query values redacted, status, timings, span names), outbound `fetch` calls and event-loop delay. It opens no port of its own. `connect({ standalone: true })` records without a bridge, for tests and scripts that read `report()` themselves; it still refuses in production.
- **Request and response bodies are never recorded.** Request headers are redacted except a small allowlist (`content-type`, `content-length`, `cache-control`, `etag`, plus what you allow).
- **Span names are yours.** `span('db.users.find', ...)` records the name you pass, so do not put values such as emails or ids in span names.
- **`x-reins-trace` goes to your own origin only.** The browser core adds it to same-origin calls while paired, never to other origins. It is a random id with no meaning outside the session.
- **`Server-Timing` is off by default.** With `serverTiming: true` each response carries the route and three timings (app, db, event-loop p99). Do not turn it on in a build other people can reach.

## Flight (`@mindmakr/reins/flight`)

Flight runs in production on a Node server. It records the steps of the server's processes, checks them against the promises in `reins.flight.json`, and tells sinks and a report what it finds. It never retries, restarts, rolls back or blocks anything.

### Safety rules and the tests that enforce them

| Rule | Enforced by (test file: test name) |
|---|---|
| The flight entry contains no actions, no pairing, no bridge client, no token handling, no DOM or state reading and no eval. Its imports never reach the bridge, the pairing code, the action registry, `ws` or the MCP SDK | `flight-safety.test.ts`: "never reaches development reins from the source entry", "never reaches development reins from the built entry (after npm run build)", "has a walker that sees what it must refuse". `flight-install.test.ts`: "imports and runs the built flight entry where neither module is installed (after npm run build)" |
| Development reins is still caught in a production browser or app build: `__REINS_DEV_ONLY__` stays in the core and in record mode, is absent from the flight entry, and `reins verify` works unchanged | `flight-safety.test.ts`: "keeps the dev marker where it is and out of the shared recorder". `verify.test.ts`: "exits 1 when the marker is present" |
| Development reins is not active on a production server. `@mindmakr/reins/node` keeps refusing to start in production; flight reports a finding, tagged `security`, when the development module is loaded in a production process, and the report says whether development instruments are off | `recorder.test.ts`: "keeps @mindmakr/reins/node off in production while flight records". `flight-safety.test.ts`: "states when the development module is loaded in a production process, and when it records". `flight-sinks.test.ts`: "a spike of refused responses and the development module loaded in production are tagged security" |
| Off until started. Importing the entry does nothing; `flight.start()` is the opt-in | `flight-safety.test.ts`: "starts no timer, listener, patch or global on import, and subscribes only once started", "loads the built entry in a fresh process without loading development reins" |
| No inbound channel. Flight opens no port and registers no route; it calls out only to the sinks the app named and, in the watcher, to the app's `healthUrl` | `flight-watch.test.ts`: "opens no port while it watches", "holds no server, route or process code" (this test reads `flight.ts` as well as the watcher) |
| Stricter than development. A request is kept as method, route pattern, status and timing; an upstream call as method, host, status and timing. No header, query string, body or error text is kept; an error is a short code. A path with no route pattern is reduced to a pattern or counted as unmatched | `recorder.test.ts`: "records a request as method, route pattern, status and timing, and an upstream call as method, host, status and timing", "reduces a path with no route pattern to a listed pattern, or counts it as unmatched", "keeps an error as a short code, never its message", "lets no secret from a header, path, query string, body or error message into what it emits", "never keeps the real text of an Express mount: an undeclared mount becomes (mount)" |
| Secrets reach no sink and not the store. Sinks get counts, not process keys, unless the app opts a sink in | `flight-sinks.test.ts`: "secrets fed through a header, a path, a query string and an error message reach no sink and not the store", "counts and not process keys, unless the app opts a sink in" |
| A manifest file that is not JSON is said in fixed words (`is not valid JSON`) on the server, `reins flight report` and the bridge, never with the parse message, which can quote the file; only `reins flight check` on the developer's own terminal shows it | `flight-sinks.test.ts`: "a manifest file that is not JSON is said in fixed words: none of its text reaches a sink, the store or the finding". `flight-findings.test.ts`: "steps dropped, the manifest invalid, and a declared process with no steps at all". `bridge-flight.test.ts`: "says only "not valid JSON", never the text it read" |
| Flight never adds a `Server-Timing` header | `recorder.test.ts`: "never adds a Server-Timing header when only flight records, even where the dev hook asks for one" |
| Cannot hurt the app. Every flight code path catches its own errors, buffers are bounded, a step is never awaited in the request path, and dropped steps are counted and reported as `blind` | `recorder.test.ts`: "completes the request normally when the recorder throws, and counts the error", "keeps its buffer bounded and counts what it dropped". `flight-sinks.test.ts`: "does not block a request or the checker", "a sink that throws does not stop the checker or the other sinks". `flight-checks.test.ts`: "returns at once, never throws on bad arguments and writes through the store", "counts steps dropped per process when the bounded buffer is full, and writes the counts to the store" |
| Honest about gaps. When steps were dropped, `once`, `order` and retries are reported as not checked for that window, never as held | `flight-checks.test.ts`: "reports once, order and retries for the window as not checked, not as held" |
| Signed delivery. Webhooks are signed and time-stamped, go to https only (http only to localhost), and follow no redirect | `flight-sinks.test.ts`: "sends a JSON POST with a plain text field and the finding fields, signed with the secret and a timestamp", "goes to https only, except localhost", "follows no redirect" |
| The watcher's health address is http or https with no user or password and no port fetch refuses, and what a config module throws is shown by its code only | `flight-watch.test.ts`: "refuses a health address fetch could never poll: not http or https, with a user or password, or on a port fetch refuses", "prints only the code of what a config getter throws, never its message" |
| `reins flight report` quotes nothing of a saved report it cannot read | `flight-report.test.ts`: "gives a fixed message for a saved report that is not valid JSON, and quotes none of its content" |
| `reins_flight` (the bridge tool) reads only under the project, writes nothing, loads no app code and leaves process keys out unless asked | `bridge-flight.test.ts`: "reaches no app config loader, no Postgres store and no dynamic import (static walk of its imports)", "reads .reins/flight with reins.flight.json by default, writes nothing and leaves keys out", "never loads the app config module, even when one sits in the project", "refuses .., absolute paths elsewhere, NUL bytes, UNC and device paths, drive-relative paths and streams", "refuses a link or junction that leads out of the project, for a file, a store and inside a store", "refuses a report file, a manifest or a store file with more than one hard link", "refuses a report file, a manifest or a store over its cap", "says only "not valid JSON", never the text it read" |

### Installing flight

Flight runs in production, so install `@mindmakr/reins` as a regular dependency (`npm i @mindmakr/reins`, not `npm i -D`): a production install (`npm ci --omit=dev`) leaves dev dependencies out. The package also installs `ws` and `@modelcontextprotocol/sdk`, which only `npx reins bridge` uses. They stay regular dependencies so that `npx reins bridge` works for everyone who installs the package. The flight entry never imports either one: the safety walk refuses them, and `flight-install.test.ts` runs the built flight entry from an install where neither exists. In ESM a module loads only when imported, so on a server that imports only `@mindmakr/reins/flight` they sit on disk and never load.

### What flight keeps

- **Steps are bare facts**: process, key, step name, time and instance. They carry no free text. Step names come from the manifest.
- **Span names and error codes come from the app.** Flight keeps a span name when it matches its name pattern (letters, digits, `_`, `.`, `:` and `-`, at most 64 characters) and otherwise records it as `span`. For an error it keeps a code of a known shape only: an errno-style code (`E` and capital letters, at most 16 characters, such as `ECONNREFUSED`), or `ERR_` or `UND_ERR_` and capital letters and underscores, at most 40 characters (such as `ERR_INVALID_URL`). Without one, it keeps the error's class name when that name is on a fixed list of built-in names (`Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`, `AggregateError`, `AbortError`, `TimeoutError`), so a code such as `sk_live_...` on a plain `Error` is recorded as `Error`. Anything else, such as a key-shaped `AKIAIOSFODNN7_EXAMPLE` set as a code or a name, becomes `error`. So do not build span names or error codes from data.
- **Upstream host names are kept as they are.** A host such as `acme.api.example.com` can carry a tenant or customer name in its subdomain.
- **Express mounts.** Express gives the mount path of a router (`app.use('/u/:id', router)`) as the real path text, not as a pattern, so it can hold an id. Flight records a route under a router with its mount only when the mount is listed in the `mounts` option (`flight.start({ mounts: ['/api', '/u/:id'] })`); otherwise the mount part becomes `(mount)`.
- **One copy of the package.** The check that development reins is loaded (`devModuleLoaded`) and the shared request hooks assume one copy of `@mindmakr/reins` in the process. With two copies (two versions in `node_modules`), each sees only its own.
- **Postgres refuses text holding U+0000.** A process key or instance with a control character is refused as invalid before it reaches any store. In finding data, every string has U+0000 removed (and a lone surrogate made U+FFFD) before it is stored, so the three stores keep the same text and Postgres never refuses a findings write over it.

### Sinks and webhook receivers

- **Webhooks are signed** as [Standard Webhooks](https://www.standardwebhooks.com/): headers `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature` (`v1,` and the base64 HMAC-SHA256 of `<id>.<timestamp>.<body>`). The secret is 24 to 64 bytes: `whsec_` and base64, or plain text. A retry keeps the same `webhook-id` with a new timestamp and signature.
- **A receiver should**: listen on https; compute the HMAC over the raw body as received, with the same secret bytes, and compare it with the signature in constant time; reject a timestamp more than about 5 minutes from its own clock, so a captured delivery cannot be replayed later; and drop a `webhook-id` it has already seen. The same checks are in any Standard Webhooks library.
- **Sinks get counts, not process keys**, unless the app sets `keys: true` on that sink.
- **A finding about the app is told once across server copies** while the store is reachable: only the copy that holds the checker lock tells, from one shared count in the store.
- **A store outage is each copy's own.** A copy that cannot reach the store tells its own sinks once that flight cannot see ("flight can't see"), and once when it can see again, through its own hourly-capped counter. Nothing is handed between copies, so with two copies one outage can give two alerts.
- **A store that refuses the findings write** (it answered the lock and the reads, then refused the write) gives a `blind` finding that flight cannot save its findings, told once per copy, and its end once. Nothing about the app is told for that pass.

### Stores, the lock and several copies

- **The file store and its lock are for one machine**: one server, or a server and a watcher beside it, for example in local Docker with a shared folder. Several machines need the Postgres store.
- **The checker lock.** One checker at a time holds a lease in the store. A file-store lock generation that cannot be read counts as held for 10 s (`BROKEN_LOCK_MS`) and then as free, so nothing in the lock folder blocks takeover for longer. That is also the lease's limit: a holder that stalls more than 10 s between creating its generation and writing it (a long GC pause, a suspended process, a very slow disk) can be taken over while it still goes on to hold, so for that pass two checkers hold at once; the stalled one loses at its next renewal. A lease is never longer than 24 hours (`MAX_LOCK_MS`); a lock time further ahead than that is treated as stale.
- **A write that lands after its lease ran out.** A checker pass that ran past its time limit asks whether it still holds the lock before it writes, and again before it tells any sink. But a write already on its way can hang longer than the lease (three periods, at least three minutes) and land after another copy took the lock. The stores have no conditional write, so that late write can overwrite newer findings records until the new holder's next pass. The late writer tells no sink about it.
- **Clock skew between copies.** Steps use each copy's wall clock, so they compare across copies and restarts. If two copies' clocks differ by some seconds, step times from them differ by as much: `within` and `ends` times and step timings can be off by the skew, and an `order` promise can be judged on the wrong order when the two steps are closer together than the skew. Lock leases are judged by each copy's own clock, and the holder compares its own writes with stored records by time, so with skew a sink can be told about the same change twice. Keep the clocks in sync (NTP).

### The watcher (`reins flight watch`)

- It loads the app's config module (`--config <module>`), runs the same checker as a server against the same store and sinks, and opens no port.
- **`healthUrl`** must be `http:` or `https:`, with no user or password, and not on a port fetch never connects to; otherwise the watcher does not start. The watcher prints only its origin (scheme, host and port), and findings do not name it. Each period it polls with GET and no redirects, within 10 s and at most half of `checkTimeoutMs`, beside the store work.
- **Bounded shutdown.** On Ctrl+C or SIGTERM it waits at most 5 s for the store to take the queued work and the lock back, and at most 10 s in all; a second signal exits at once.
- **A health finding with no poller.** When no watcher polls the address any more, an open health finding stays open for 10 minutes after the last poll and then resolves as "no longer checked", never as a recovery.
- **Taking over.** While a watcher holds the lock, the servers' checkers stand down. While a server holds it, the watcher waits and takes over once the server stops renewing it. The watcher does not yet always take precedence over a server that keeps renewing; that comes after 0.2.0.

### `reins_flight` on the bridge

`reins_flight` gives an agent in development the flight report from a saved report file or a file store under the project. It reads only under the project folder and writes nothing. It never loads app code (not the config module either) and never reaches a Postgres store. Process keys are left out unless the call passes `keys: true`. It refuses links and junctions that lead out of the project, files with more than one hard link, `..`, UNC, drive-relative and stream paths, and Windows device names (`CON`, `NUL`, `COM1`) in any segment, including absolute parent folders. It caps what it reads: a report file at 8 MB, the manifest at 1 MB, a store at 64 MB and 5,000 files, and waits at most 15 s.

Two limits remain. Between its check of a path and its read there is a short window in which a process on your machine could swap a checked file for a link; it guards against paths an agent passes, not against code already running on your machine. And another JSON file in the project named as the manifest is read as one: the problems it lists can show that file's key names and short string values.

## What reins does not protect against

- **Code already running on your machine.** A local process can read `.reins/token` and pair. reins guards against websites and other devices, not against malware on your machine.
- **What your actions do.** An action runs with the app's full power. Do not register actions that skip authentication or authorisation in a build anyone else can reach. Mark anything that changes real data or sends something as `consequential`.
- **Staging builds with `REINS_ENABLE=1`.** Those builds contain reins on purpose, including record mode and `@mindmakr/reins/node`. Keep them off the public internet, and keep test-only actions out of them.
- **Your dev server on a network.** If your dev server listens on your LAN, devices there can fetch the token. They still cannot reach the bridge, which listens on loopback only.
- **Redaction misses.** Redaction works on key names. A secret stored under a harmless name, like `{ value: "sk-..." }`, is not caught. Keep state sources small. The same goes for a secret in a URL path (`/reset/<token>`), in a span name, or in visible page text, which `reins_dom` and session reports include.
- **Session files.** `reins_report` writes to `.reins/sessions/`, which is git-ignored. A tester's exported session is an ordinary download: read it before you attach it to a public issue.

### What flight does not protect against

- **A secret the app puts in a step name or process key.** Flight keeps both as given. Never build them from personal data or secrets.
- **A store or report page the app exposes without sign-in.** The store holds process keys, and the report JSON holds them too. Show the report only behind the app's own sign-in, and keep the store private.
- **A webhook address that points somewhere it should not.** Flight sends to the address the app gives it. Read it from the environment and check where it goes.
- **Anyone who already controls the server.** They can change the app, its config module or flight itself.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository: Security tab, then "Report a vulnerability". We aim to reply within 7 days.
