# cap-jev example

A CAP application with one action, `classify`, that asks System One which team should handle a message and returns that team's queue (`accounts` or `support`). The handler in [`srv/decision-service.ts`](srv/decision-service.ts) shows:

- `satisfies Questions` to keep the choice labels `'billing' | 'technical'`.
- A queue map checked against those labels, so adding a criterion without a queue fails type-checking.
- Mapping `SystemOneError` codes to HTTP responses: invalid input becomes 400, timeouts 504, cancellation 503, and other System One failures 502.

## Run

The app uses the `systemone-laya` kind, which calls a Jev-compatible server at `http://127.0.0.1:8000/v1/systemone` without a token. Start such a server, for example [Laya](https://github.com/WhoIsMrSentry/laya-system-one#self-hosting-http-server-jev-compatible), or point the app at another endpoint with `CDS_REQUIRES_SYSTEMONE_CREDENTIALS_URL`.

In this repository, the app is an npm workspace and uses the local `cap-jev`. Install and build from the repository root:

```sh
npm install
npm run build
cd examples/cap-app
```

For a copy of the app outside this repository, install `cap-jev` from a release archive as described in the [main README](../../README.md#install-and-use), for example:

```sh
curl -fLO https://github.com/hendrik77/cap-jev/releases/download/v0.5.1/cap-jev-0.5.1.tgz
npm install ./cap-jev-0.5.1.tgz
```

CAP loads TypeScript handlers when `CDS_TYPESCRIPT` is set. Node.js 22.18 or newer runs them without a separate compiler:

```sh
CDS_TYPESCRIPT=true npm start
```

Call the action as the mocked development user `alice` (empty password):

```sh
curl -u alice: -X POST http://localhost:4004/odata/v4/decision/classify \
  -H 'content-type: application/json' \
  -d '{"message":"I was billed twice"}'
```

## Authentication

`classify` calls a provider that can cost money, so [`srv/decision-service.cds`](srv/decision-service.cds) restricts the service with `@requires: 'authenticated-user'`. `cap-jev` serves no services itself; the application must protect every action that calls a provider. Without credentials the call gets 401.

In development CAP's mocked users apply, such as `alice` with an empty password (`curl -u alice: ...`). In production, configure a real authentication strategy, such as XSUAA or IAS, and add `@requires` roles or `@restrict` rules where only some users may spend the quota.

The repository checks this app in two tests: `tests/example-app.test.cjs` runs it with `cds.test` against a local fake server, and `tests/cap-integration.test.cjs` packs the plugin, installs it in a copy of this app and calls `classify`. Both run on every CI run.
