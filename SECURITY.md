# Security

reins lets an AI agent control a running app, so its job is to stay out of production and stay locked on your machine in development. This page says what it does, what it does not do, and how to report a problem.

## What reins does

- **Production builds do not contain it.** The core only turns on in dev builds (`__DEV__`, `import.meta.env.DEV`, or `NODE_ENV` other than `production`). `reins/vite`, `reins/next` and `reins/metro` swap `reins` and `reins/record` for empty stubs in production builds. `reins-verify-bundle <dir>` fails if the marker `__REINS_DEV_ONLY__` appears in any built file, including source maps and Hermes bytecode. Run it in CI after every production build.
- **The browser core does nothing until paired.** No patches and no listeners until the bridge accepts a token. The one exception is record mode, which a person turns on themselves (see below). The token is 192 random bits. The bridge writes it to `.reins/token`, which has its own `.gitignore`, and renews it after each pairing. It is deleted when the bridge stops. The bridge prints the path of the token file, never the token.
- **The bridge is local only.** It binds to `127.0.0.1`, with no option to change that. It refuses WebSocket upgrades from origins that are not localhost or on the `--origin` list. Clients that send no Origin, like React Native, still need the token. `--browser-only` refuses them.
- **The token route refuses cross-site requests.** It answers 403 when `Sec-Fetch-Site` is `cross-site` or `same-site`. Other sites cannot read it anyway, because it sends no CORS headers.
- **Redacted by default.** Bodies, `Authorization`, `Cookie` and `Set-Cookie` headers, storage values, cookie values, sensitive query values and sensitive state keys show as `[redacted]` unless you allowlist them.
- **Consequential actions need `confirm: true`.**
- **Audit log.** Every agent call, pairing, refusal and in-page call goes to `.reins/audit.log`, with arguments redacted.
- **No eval.** Only registered actions run.

## Record mode (`reins/record`)

- **It only exists in builds that already contain reins**: dev builds, or a private staging build made with `REINS_ENABLE=1`. Production builds get `reins/record-stub`, and `reins verify` fails if the real one is present.
- **A person has to turn it on**: by opening the page with `?reins=record` (when the app calls `recordFromUrl()`), or with a button that calls `startRecording()`. It then patches `fetch` and listens for errors in that browser tab, without a bridge.
- **Nothing is sent anywhere.** The session stays in the tab until the person clicks Export, which downloads a Markdown and a JSON file to their own machine. It uses the same redaction as the core.
- **In a staging build, any visitor can add `?reins=record`.** They can only record their own session in their own browser, but this is one more reason to keep `REINS_ENABLE=1` builds private.

## Backend instrumentation (`reins/node`)

- **It refuses to start when `NODE_ENV` is `production`**, unless `REINS_ENABLE=1`. An unset `NODE_ENV` counts as development, as it does for most Node tools, so call `reinsNode.connect()` behind your own dev check as well.
- **It records nothing until the bridge pairs**, like the browser core. Until the bridge on `127.0.0.1` accepts the token from `.reins/token`, the middleware passes requests straight through, spans just run their function, and no `Server-Timing` header is sent. Recording stops again when the bridge goes away. Once paired it keeps, in fixed-size buffers in memory, recent requests (method, URL with sensitive query values redacted, status, timings, span names), outbound `fetch` calls and event-loop delay. It opens no port of its own. `connect({ standalone: true })` records without a bridge, for tests and scripts that read `report()` themselves; it still refuses in production.
- **Request and response bodies are never recorded.** Request headers are redacted except a small allowlist (`content-type`, `content-length`, `cache-control`, `etag`, plus what you allow).
- **Span names are yours.** `span('db.users.find', ...)` records the name you pass, so do not put values such as emails or ids in span names.
- **`x-reins-trace` goes to your own origin only.** The browser core adds it to same-origin calls while paired, never to other origins. It is a random id with no meaning outside the session.
- **`Server-Timing` is off by default.** With `serverTiming: true` each response carries the route and three timings (app, db, event-loop p99). Do not turn it on in a build other people can reach.

## What reins does not protect against

- **Code already running on your machine.** A local process can read `.reins/token` and pair. reins guards against websites and other devices, not against malware on your machine.
- **What your actions do.** An action runs with the app's full power. Do not register actions that skip authentication or authorisation in a build anyone else can reach. Mark anything that changes real data or sends something as `consequential`.
- **Staging builds with `REINS_ENABLE=1`.** Those builds contain reins on purpose, including record mode and `reins/node`. Keep them off the public internet, and keep test-only actions out of them.
- **Your dev server on a network.** If your dev server listens on your LAN, devices there can fetch the token. They still cannot reach the bridge, which listens on loopback only.
- **Redaction misses.** Redaction works on key names. A secret stored under a harmless name, like `{ value: "sk-..." }`, is not caught. Keep state sources small. The same goes for a secret in a URL path (`/reset/<token>`), in a span name, or in visible page text, which `reins_dom` and session reports include.
- **Session files.** `reins_report` writes to `.reins/sessions/`, which is git-ignored. A tester's exported session is an ordinary download: read it before you attach it to a public issue.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository: Security tab, then "Report a vulnerability". We aim to reply within 7 days.
