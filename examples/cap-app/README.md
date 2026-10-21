# cap-jev example

A CAP application with one action, `classify`, that asks System One which team should handle a message and returns that team's queue (`accounts` or `support`). The handler in [`srv/decision-service.ts`](srv/decision-service.ts) shows:

- `satisfies Questions` to keep the choice labels `'billing' | 'technical'`.
- A queue map checked against those labels, so adding a criterion without a queue fails type-checking.
- Mapping `SystemOneError` codes to HTTP responses: invalid input becomes 400, timeouts 504, cancellation 503, and other System One failures 502.

## Run

In this repository, the app is an npm workspace and uses the local `cap-jev`. Install and build from the repository root, then start the app:

```sh
npm install && npm run build
cd examples/cap-app
CDS_TYPESCRIPT=true npm start
```

CAP loads TypeScript handlers when `CDS_TYPESCRIPT` is set. Node.js 22.18 or newer runs them without a separate compiler.

The app needs no provider server, token or network. In development `cap-jev` answers with its mock provider (`systemone-mock`), so the answers are simulated but deterministic: the same message always gets the same queue. Keywords in the message are matched against the criteria, and the rule in [`test/data/systemone.json`](test/data/systemone.json) routes refund messages to `billing`, so they end up in the `accounts` queue.

Call the action as the mocked development user `alice` (empty password):

```sh
curl -u alice: -X POST http://localhost:4004/odata/v4/decision/classify \
  -H 'content-type: application/json' \
  -d '{"message":"I want a refund"}'
```

### Use a real Jev server

An explicit `kind` always wins over the mock. To send the app's requests over HTTP in development, select the kind from the environment and run a Jev-compatible server at `http://127.0.0.1:8000`.

The easiest server is the HTTP mock server of `cap-jev`. It needs no model, token or network access and gives the same answers as the in-process mock, so the app's behaviour stays the same while its HTTP transport runs. Use two terminals. In the first, start the server in this directory, so that it reads the fixture rule in [`test/data/systemone.json`](test/data/systemone.json). Starting it in the repository root works too, but then it has no fixture rule and answers from keywords alone:

```sh
npx cap-jev-mock
```

In the second, start the app with the kind that matches the server's defaults:

```sh
CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya CDS_TYPESCRIPT=true npm start
```

The server logs each request. Options such as `--fail HTTP_ERROR --status 503`, `--latency-ms` and `--format cloudflare` simulate slow and failing providers; see [HTTP mock server](../../docs/local-development.md#http-mock-server).

For answers from a real model, run [Laya](https://github.com/WhoIsMrSentry/laya-system-one#self-hosting-http-server-jev-compatible) or another Jev-compatible server instead, and start the app the same way. To use another endpoint with `systemone-laya`, set `CDS_REQUIRES_SYSTEMONE_CREDENTIALS_URL`. The URL alone does not leave the mock; the kind must be set too.

In production (`CDS_TYPESCRIPT=true npm start -- --production`), [`package.json`](package.json) selects `systemone-laya`, which needs a Jev-compatible server and a real authentication strategy (see below). The HTTP mock server serves for this too, as a stand-in for Laya, if you run it as above and configure authentication. The in-process mock refuses to run in production.

### Outside this repository

For a copy of the app outside this repository, install `cap-jev` from a release archive as described in the [main README](../../README.md#install-and-use), for example:

```sh
curl -fLO https://github.com/hendrik77/cap-jev/releases/download/v0.7.1/cap-jev-0.7.1.tgz
npm install ./cap-jev-0.6.0.tgz
```

## Authentication

`classify` calls a provider that can cost money, so [`srv/decision-service.cds`](srv/decision-service.cds) restricts the service with `@requires: 'authenticated-user'`. `cap-jev` serves no services itself; the application must protect every action that calls a provider. Without credentials the call gets 401.

In development CAP's mocked users apply, such as `alice` with an empty password (`curl -u alice: ...`). In production, configure a real authentication strategy, such as XSUAA or IAS, and add `@requires` roles or `@restrict` rules where only some users may spend the quota.

The repository checks this app in three tests, which run on every CI run:

- `tests/example-app.test.cjs` runs it with `cds.test` in development on the mock provider, including the fixture rule and the authentication check.
- `tests/example-app-failure.test.cjs` simulates a provider failure (`CDS_REQUIRES_SYSTEMONE_FAIL=NETWORK_ERROR`) and checks the 502 response.
- `tests/cap-integration.test.cjs` packs the plugin, installs it in a copy of this app and calls `classify` in the production profile against a local fake server, plus once in development on the mock.
