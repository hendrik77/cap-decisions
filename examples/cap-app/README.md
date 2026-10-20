# cap-jev example

A CAP application with one action, `classify`, that asks System One which team should handle a message and returns that team's queue (`accounts` or `support`). The handler in [`srv/decision-service.ts`](srv/decision-service.ts) shows:

- `satisfies Questions` to keep the choice labels `'billing' | 'technical'`.
- A queue map checked against those labels, so adding a criterion without a queue fails type-checking.
- Mapping `SystemOneError` codes to HTTP responses: invalid input becomes 400, timeouts 504, cancellation 503, and other System One failures 502.

## Run

The app uses the `systemone-laya` kind, which calls a Jev-compatible server at `http://127.0.0.1:8000/v1/systemone` without a token. Start such a server, for example [Laya](https://github.com/WhoIsMrSentry/laya-system-one#self-hosting-http-server-jev-compatible), or point the app at another endpoint with `CDS_REQUIRES_SYSTEMONE_CREDENTIALS_URL`.

`cap-jev` is not yet published to npm, so install it from a release archive before the other dependencies:

```sh
cd examples/cap-app
npm install https://github.com/hendrik77/cap-jev/releases/download/v0.4.3/cap-jev-0.4.3.tgz
npm install
```

CAP loads TypeScript handlers when `CDS_TYPESCRIPT` is set. Node.js 22.18 or newer runs them without a separate compiler:

```sh
CDS_TYPESCRIPT=true npm start
```

Call the action:

```sh
curl -X POST http://localhost:4004/odata/v4/decision/classify \
  -H 'content-type: application/json' \
  -d '{"message":"I was billed twice"}'
```

The repository's integration test packs the plugin, installs it in a copy of this app, and calls `classify` against a local fake server, so the example is checked on every CI run.
