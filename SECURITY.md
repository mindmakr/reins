# Security

reins lets an AI agent control a running app, so its job is to stay out of production and stay locked on your machine in development. This page says what it does, what it does not do, and how to report a problem.

## What reins does

- **Production builds do not contain it.** The core only turns on in dev builds (`__DEV__`, `import.meta.env.DEV`, or `NODE_ENV` other than `production`). `@reins/vite`, `@reins/next` and `@reins/expo/metro` swap it for an empty stub in production builds. `reins-verify-bundle <dir>` fails if the marker `__REINS_DEV_ONLY__` appears in any built file, including source maps and Hermes bytecode. Run it in CI after every production build.
- **It does nothing until paired.** No patches and no listeners until the bridge accepts a token. The token is 192 random bits. The bridge writes it to `.reins/token`, which has its own `.gitignore`, and renews it after each pairing. It is deleted when the bridge stops.
- **The bridge is local only.** It binds to `127.0.0.1`, with no option to change that. It refuses WebSocket upgrades from origins that are not localhost or on the `--origin` list. Clients that send no Origin, like React Native, still need the token. `--browser-only` refuses them.
- **The token route refuses cross-site requests.** It answers 403 when `Sec-Fetch-Site` is `cross-site` or `same-site`. Other sites cannot read it anyway, because it sends no CORS headers.
- **Redacted by default.** Bodies, `Authorization`, `Cookie` and `Set-Cookie` headers, storage values, cookie values, sensitive query values and sensitive state keys show as `[redacted]` unless you allowlist them.
- **Consequential actions need `confirm: true`.**
- **Audit log.** Every agent call, pairing, refusal and in-page call goes to `.reins/audit.log`, with arguments redacted.
- **No eval.** Only registered actions run.

## What reins does not protect against

- **Code already running on your machine.** A local process can read `.reins/token` and pair. reins guards against websites and other devices, not against malware on your machine.
- **What your actions do.** An action runs with the app's full power. Do not register actions that skip authentication or authorisation in a build anyone else can reach. Mark anything that changes real data or sends something as `consequential`.
- **Staging builds with `REINS_ENABLE=1`.** Those builds contain reins on purpose. Keep them off the public internet, and keep test-only actions out of them.
- **Your dev server on a network.** If your dev server listens on your LAN, devices there can fetch the token. They still cannot reach the bridge, which listens on loopback only.
- **Redaction misses.** Redaction works on key names. A secret stored under a harmless name, like `{ value: "sk-..." }`, is not caught. Keep state sources small.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository: Security tab, then "Report a vulnerability". We aim to reply within 7 days.
