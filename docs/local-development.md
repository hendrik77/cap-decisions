# Local development

In the `development` and `test` profiles, `cap-jev` answers from an in-process mock provider. `cds watch`, `cds serve` and `cds.test` work without a provider server, a token or network access. In production, the plugin keeps `systemone-generic`.

The mock is the `systemone-mock` kind. Its answers are simulated, deterministic and valid against the Jev protocol, so request and response validation, `before` and `after` handlers and logging behave as they do with a real provider. The design is explained in [ADR 0002](decisions/0002-in-process-mock-provider.md). The [example app](../examples/cap-app) runs on the mock. To exercise the HTTP path, start the [HTTP mock server](#http-mock-server) instead.

## When the mock is active

The plugin's `package.json` selects `systemone-mock` in the `development` and `test` profiles. An explicit `kind` in your application always wins.

| Your `cds.requires.systemone` | `development` and `test` | `production` |
| --- | --- | --- |
| No entry | Mock | Generic: connecting fails with `INVALID_CONFIG` because there is no URL |
| `"kind": "systemone-typesafe"` (or any other kind) | That kind | That kind |
| `"[production]": { "kind": "systemone-typesafe" }` | Mock | TypeSafe |
| Only `credentials.url`, no `kind` | Mock | Generic with that URL |

`cds add systemone` writes the configuration of the third row: the kind goes into `"[production]"` (or the profile of `--for`), so the mock stays active in `development` and `test`. If `package.json` has a base-level `kind`, the command leaves it and warns that it turns off the mock. See [Set up with `cds add systemone`](../README.md#set-up-with-cds-add-systemone).

The last row catches many applications: a URL alone does not select a real endpoint in development. Set a `kind` to use one. For a local Jev-compatible server, set `"kind": "systemone-generic"` together with the URL.

The mock logs one warning when it connects. The warning says that answers are simulated and that you must set a `kind` to use a real endpoint in development.

`cds.test` runs in the `development` profile unless `CDS_ENV` or `NODE_ENV` selects another one, so application tests get the mock. The `test` profile, for example `CDS_ENV=test`, uses the mock too.

## How answers are made

The mock needs no model. It builds every answer from the request alone.

- **Deterministic.** The random numbers are seeded from a SHA-256 hash of the JSON state and the question ID. The same state and question ID always give the same answer. A different state or question ID gives a different seed.
- **`model` and usage.** `model` is `mock`. Usage is estimated: `input_tokens` is the length of the request as JSON divided by four, rounded up, and `output_tokens` is the number of questions.
- **`choice` questions** depend on the `strategy` setting.

  | Strategy | Behaviour |
  | --- | --- |
  | `keywords` (default) | Splits the state, each choice label and its criteria text into lowercase words. Only words of at least three letters or digits count, and a few common English words such as `the` and `was` are ignored. A word of the state matches when it equals a word of the label or criteria text, or when both start with the same four letters (`refund` matches `refunds`). The choice with the most matching state words wins. The seed breaks ties. |
  | `seeded` | Picks a choice from the seed alone. |

  The chosen choice always has the largest probability, and `confidence` is that probability. With no matching words, all choices tie and the seed decides.
- **`score` questions** get seeded probabilities over the criteria indices. `score` is the expected value of that distribution, and `legend` maps each index to its criteria text.
- **`noul` questions** get a seeded value from 0 to 1.

For example, with the criteria `{ billing: 'Payments and refunds', technical: 'Errors and integrations' }`, the state `I was billed twice. Please refund me.` selects `billing`, because `refund` matches `refunds`.

## Fixtures

Fixtures are rules that give fixed answers or simulated failures for matching questions. They are plain JSON, so you can keep them in version control with your other test data.

The default file is `test/data/systemone.json`, relative to the project root. This is CAP's place for development and test data. To use another file, set `fixtures` (see [Settings](#settings)); the path is also relative to the project root.

- A missing default file is fine: the mock then uses the engine alone.
- A missing configured file fails when the service connects.

The file is a JSON array of rules. For each question, the first rule that matches wins. Questions that no rule matches are answered by the engine.

| Field | Meaning |
| --- | --- |
| `when.stateIncludes` | A string or an array of strings. The rule matches when any of them occurs in the state, ignoring case. The mock searches all string values in the state, nested ones included. A phrase matches inside one value, never across two. Omit it to match every state |
| `when.question` | The question ID the rule applies to. Omit it to apply the rule to every question |
| `answer` | An object with the fixed answer. Fields you leave out are completed. A `choice` answer needs `choice`, a `score` answer needs `score` and a `noul` answer needs `noul`. For example, `{ "choice": "billing" }` is enough. A rule with `answer` requires `when.question`, because answers depend on the question type |
| `fail` | A simulated failure instead of an answer. One of `INVALID_RESPONSE`, `HTTP_ERROR`, `PROVIDER_ERROR`, `NETWORK_ERROR` or `TIMEOUT` |
| `status` | For `HTTP_ERROR` only, and required there: an integer from 400 to 599 |
| `providerCode` | Optional string for a `fail` rule. It becomes the error's `providerCode` |

A rule has exactly one of `answer` and `fail`. A failing rule fails the whole call with a `SystemOneError` that has that code.

This is the rule file of the example app. It routes refund messages to `billing`:

```json
[
  {
    "when": { "stateIncludes": ["refund", "money back"], "question": "department" },
    "answer": { "choice": "billing" }
  }
]
```

`cds add systemone --with-fixtures` writes an example file at the default place, with two rules: a fixed `choice` answer for the question `department` when the state contains `refund` or `money back`, and an `HTTP_ERROR` with status 503 when the state contains `simulate outage`. An existing file is kept unless `--force` is set.

A failure rule looks like this:

```json
[
  {
    "when": { "stateIncludes": "overloaded" },
    "fail": "HTTP_ERROR",
    "status": 503,
    "providerCode": "overloaded"
  }
]
```

### Fixture errors

Both errors are `SystemOneError` with the code `INVALID_CONFIG`.

- A file that cannot be read, is not valid JSON, is not an array, or contains a malformed rule fails when the service connects. For a malformed rule, the message names the file and the rule index.
- An `answer` that does not fit its question, for example a `choice` that is not one of the criteria keys, fails the call that triggers it. The message names the file, the rule index and the question ID.

## Settings

Set these on `cds.requires.systemone`, next to `kind`. The mock also accepts the common settings, such as `timeoutMs` and `limits`.

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `fixtures` | string | `test/data/systemone.json` | Path of the fixtures file, relative to the project root |
| `strategy` | `keywords` or `seeded` | `keywords` | How `choice` answers are picked (see [How answers are made](#how-answers-are-made)) |
| `latencyMs` | non-negative integer | `0` | Simulated delay before each answer. If it reaches `timeoutMs`, the call waits `timeoutMs` and then fails with `TIMEOUT`. A cancelled `signal` ends the wait with `ABORTED` |
| `fail` | error code, or `{ code, status, providerCode }` | None | Fails every call. It applies after `latencyMs` and before the fixtures. `HTTP_ERROR` needs the object form with a `status` |
| `allowInProduction` | boolean | `false` | The mock refuses to start in the `production` profile unless this is `true` |

Invalid values fail with `INVALID_CONFIG` when the service connects.

Set them in your application's `package.json`:

```json
{
  "cds": {
    "requires": {
      "systemone": {
        "strategy": "seeded",
        "latencyMs": 200,
        "fail": { "code": "HTTP_ERROR", "status": 503, "providerCode": "overloaded" }
      }
    }
  }
}
```

These settings apply to the mock only. With another kind they have no effect, and the service logs them as unknown settings.

Environment variables work too. Use them to switch a behaviour for one run or one test file:

```sh
CDS_REQUIRES_SYSTEMONE_FAIL=NETWORK_ERROR npm start
CDS_REQUIRES_SYSTEMONE_FAIL_CODE=HTTP_ERROR CDS_REQUIRES_SYSTEMONE_FAIL_STATUS=503 npm start
```

CAP lowercases environment variable names, so a camel-case key such as `latencyMs` or `providerCode` needs `CDS_CONFIG`:

```sh
CDS_CONFIG='{"requires":{"systemone":{"latencyMs":200}}}' npm start
```

## Test your error handling

Use `fail` for a failure on every call, and fixture rules for a failure on certain inputs. The mock throws the same `SystemOneError` that a real provider would, so you can test how your handlers map errors.

CAP reads its configuration once per process. To change a setting for a test file, set the environment variable before CAP loads. [`tests/example-app-failure.test.cjs`](../tests/example-app-failure.test.cjs) does this for the example app:

```js
process.env.CDS_REQUIRES_SYSTEMONE_FAIL = 'NETWORK_ERROR';
const cds = require('@sap/cds');
const { POST } = cds.test('path/to/your/app');
```

The example action maps this failure to a 502 response, which the test checks. For failures that depend on the input, add a rule with `fail` to your fixtures file instead.

## HTTP mock server

The in-process mock skips HTTP. The HTTP mock server answers over HTTP, like a Jev server, with the same engine, fixture rules and settings. Use it when you want to exercise the HTTP path: retries for 429, 502, 503, 504 and 529, `Retry-After`, `timeoutMs`, network failures, a bearer token, `systemone-laya`, `systemone-cloudflare`, or a client outside CAP. For everything else the in-process mock is simpler, because it needs no second process. The design is explained in [ADR 0003](decisions/0003-http-mock-server.md).

The server and its command line are experimental until the first npm publication. It imports no CAP code, so it also runs without `@sap/cds`.

Start it in a terminal, then start your application with the kind that matches:

```sh
npx cap-jev-mock
CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya npm start
```

The defaults match `systemone-laya`: `http://127.0.0.1:8000/v1/systemone`. The server prints one line with its URL when it listens, and one line per request. `npx cap-jev-mock` works wherever `cap-jev` is installed; run it from the project root so that it finds the default fixtures file.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | `8000` | Port to listen on. `0` picks a free port |
| `--host <host>` | `127.0.0.1` | Address to listen on (see [Network access](#network-access)) |
| `--path <path>` | `/v1/systemone` | Request path |
| `--fixtures <file>` | `test/data/systemone.json` | Fixture rules, relative to the current directory |
| `--strategy <name>` | `keywords` | `keywords` or `seeded` (see [How answers are made](#how-answers-are-made)) |
| `--latency-ms <n>` | `0` | Delays every answer by `n` milliseconds |
| `--fail <CODE>` | None | Fails every request with this error code: `HTTP_ERROR`, `NETWORK_ERROR`, `TIMEOUT`, `INVALID_RESPONSE` or `PROVIDER_ERROR` (see [Failures](#failures)) |
| `--status <n>` | None | HTTP status from 400 to 599 for `--fail HTTP_ERROR`, required there. Needs `--fail` |
| `--provider-code <code>` | None | Provider error code for `--fail`. Needs `--fail` |
| `--token <token>` | `CAP_JEV_MOCK_TOKEN` | Requires `Authorization: Bearer <token>`. The option wins over the environment variable; an empty variable counts as unset |
| `--format <name>` | `jev` | `jev` or `cloudflare` (see [Cloudflare format](#cloudflare-format)) |
| `--quiet` | Off | Does not log requests |
| `-h`, `--help` | | Shows the options |
| `-v`, `--version` | | Shows the version |

Invalid options exit with code 2 and a message on stderr. If the server cannot listen, for example because the port is in use, it exits with code 1. `SIGINT` and `SIGTERM` close the server and exit with code 0.

### Requests and responses

Every answer is the one the in-process mock gives for the same request, fixtures and settings, so an answer is the same over HTTP and in-process. `model` in the request is accepted and ignored. The server checks the protocol, not a kind's `limits`; the client checks those before it sends.

The server checks a request in this order: path, method, token, body.

| Request | Response |
| --- | --- |
| `POST` on the path with a valid Jev request | 200 with the answer |
| Other path | 404 `{ "error": { "type": "not_found_error" } }` |
| Other method on the path | 405 with `Allow: POST` |
| `--token` set, header missing or wrong | 401 `{ "error": { "type": "authentication_error" } }` |
| Body larger than 1 MiB | 413 `{ "error": { "type": "request_too_large" } }` |
| Invalid JSON, or a request that does not fit the Jev schema | 400 `{ "error": { "type": "invalid_request_error", "message": "…" } }` |
| A fixture `answer` that does not fit its question | 500 `{ "error": { "type": "mock_fixture_error", "message": "…" } }` |

A latency from `--latency-ms` delays the answer. If the client disconnects, the wait ends.

### Failures

Simulated failures (`--fail` or a fixture rule with `fail`) happen on the HTTP level, so the client's own transport produces the error code. Retries and timeouts run as they do against a real server. The fixture rule format and the failure codes are the same as for the in-process mock (see [Fixtures](#fixtures)).

| `fail` | The server | A `cap-jev` client sees |
| --- | --- | --- |
| `HTTP_ERROR` with `status` | Answers with that status and `{ "error": { "type": "<providerCode>" } }`; the type is `mock_error` without a `providerCode` | `HTTP_ERROR` with `status` and `providerCode`. 429, 502, 503, 504 and 529 are retried twice first |
| `NETWORK_ERROR` | Closes the connection without a response | `NETWORK_ERROR` after the retries |
| `TIMEOUT` | Never answers; the connection stays open until the client gives up | `TIMEOUT` after `timeoutMs` |
| `INVALID_RESPONSE` | Answers 200 with a body that is not JSON | `INVALID_RESPONSE`, without retries |
| `PROVIDER_ERROR`, format `jev` | Answers 500 with `{ "error": { "type": "<providerCode>" } }`; the type is `provider_error` without a `providerCode` | `HTTP_ERROR` with status 500 and the `providerCode`, because Jev has no provider-level error. Not retried |
| `PROVIDER_ERROR`, format `cloudflare` | Answers 200 with `{ "success": false, "errors": [{ "code": "<providerCode>", "message": "…" }], "result": null }`; the code is `provider_error` without a `providerCode` | `PROVIDER_ERROR` with the `providerCode` |

For example, this makes every call fail with a 503 that the client retries:

```sh
npx cap-jev-mock --fail HTTP_ERROR --status 503 --provider-code overloaded
```

### Cloudflare format

`--format cloudflare` wraps every answer in the Cloudflare envelope, `{ "success": true, "errors": [], "result": … }`. Error responses use the envelope too, `{ "success": false, "errors": [{ "code": "<type>", "message": "…" }], "result": null }`, with the same error types as in the table above. This lets you try `systemone-cloudflare` locally. Point `credentials.url` at the server and set a token, because the kind requires one. The server accepts any token unless you start it with `--token`. A client sends a token over HTTP only to a loopback host (`localhost`, an IPv4 address `127.x.x.x` or `::1`), which the default `--host` is.

```sh
npx cap-jev-mock --format cloudflare
```

```json
{
  "cds": {
    "requires": {
      "systemone": {
        "kind": "systemone-cloudflare",
        "credentials": { "url": "http://127.0.0.1:8000/v1/systemone", "token": "local" }
      }
    }
  }
}
```

To check the token as well, start the server with `--token local`.

### Other ports, paths and kinds

- For another port, start the server with `--port` and give `systemone-laya` that URL: `CDS_REQUIRES_SYSTEMONE_CREDENTIALS_URL=http://127.0.0.1:9000/v1/systemone`.
- For another kind, set the kind and the URL, for example `systemone-generic` with `credentials.url`. A kind with `requiresToken` needs a token; start the server with `--token` to check it. A wrong token gives `HTTP_ERROR` with status 401 and the `providerCode` `authentication_error`.
- An explicit `kind` always wins over the mock, so the application uses the server in `development` and `test` too. The server's URL alone does not leave the mock (see [When the mock is active](#when-the-mock-is-active)).

### Fixture files

The server reads the same rule file as the in-process mock, with the same fields and the same rules for the first matching rule. Two differences:

- `--fixtures` is relative to the current directory, not to a CAP project root. The default is `test/data/systemone.json`. A missing default file is fine; a missing configured file exits with code 2.
- The server reads the file once, when it starts. Restart it after you change the rules.

An invalid file exits with code 2 and a message that names the file and the rule.

### Network access

By default, the server listens on `127.0.0.1` only. With any other `--host`, it prints a warning on stderr that it is reachable from the network, and adds "unprotected" when no token is set. Its answers are simulated, but anyone who can reach the port can use it. Set a token when you open it to a network, and do not run it on a public address.

### Programmatic use

`startMockServer` starts the same server from JavaScript, for tests that need an HTTP endpoint. The module is `cap-jev/mock-server`. It also exports the types `MockServerOptions` and `MockServer`.

```js
const { startMockServer } = require('cap-jev/mock-server');

// Inside an async test:
const server = await startMockServer({
  port: 0, // any free port
  rules: [{ when: { question: 'department' }, answer: { choice: 'technical' } }],
});
try {
  // Select the kind and the server's URL before CAP loads, as in "Test your error handling".
  process.env.CDS_REQUIRES_SYSTEMONE_KIND = 'systemone-generic';
  process.env.CDS_REQUIRES_SYSTEMONE_CREDENTIALS_URL = server.url;
  // ... run your test ...
} finally {
  await server.close();
}
```

`startMockServer(options)` returns a promise of `{ url, port, host, close() }`. `close()` also ends open connections, including those held by `TIMEOUT`. Invalid options reject with a `SystemOneError` with code `INVALID_CONFIG`. A listen failure rejects with Node's error, such as `EADDRINUSE`.

| Option | Default | Meaning |
| --- | --- | --- |
| `port` | `8000` | Port; `0` picks a free port, which `server.port` reports |
| `host` | `'127.0.0.1'` | Address to listen on |
| `path` | `'/v1/systemone'` | Request path |
| `fixtures` | `'test/data/systemone.json'` | Fixture file, relative to `root`. Not together with `rules` |
| `rules` | None | Fixture rules as an array, instead of a file. Not together with `fixtures` |
| `root` | `process.cwd()` | Base directory for `fixtures` |
| `strategy` | `'keywords'` | `'keywords'` or `'seeded'` |
| `latencyMs` | `0` | Delay before each answer |
| `fail` | None | An error code, or `{ code, status, providerCode }`; fails every request |
| `token` | None | Required bearer token |
| `format` | `'jev'` | `'jev'` or `'cloudflare'` |
| `log` | None | A function that gets one line per request. The server logs nothing without it |

## When to use something else

The mock does not understand text. Its answers show that your code handles the protocol and the shape of the answers. They say nothing about the quality of a real model. This holds for the in-process mock and for the HTTP mock server alike.

To check real answers, use a real endpoint:

- **The HTTP mock server**, if you want the HTTP path without a real model (see [HTTP mock server](#http-mock-server)). It is the first option when the question is about retries, timeouts, tokens or a client outside CAP.
- **Laya**, a self-hosted Jev-compatible server (`systemone-laya`), for answers from a real model.
- **A hosted provider**, such as `systemone-typesafe` or `systemone-cloudflare`, with a token from a secret source (see [Provider configuration](../README.md#provider-configuration)).

Select the kind explicitly, because an explicit kind always wins over the mock. For one run in development:

```sh
CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya npm start
```

This works with the HTTP mock server or with Laya, because both listen at `http://127.0.0.1:8000/v1/systemone`. The [example app](../examples/cap-app#use-a-real-jev-server) uses the mock in development and `systemone-laya` in production. Automated tests that need an HTTP endpoint must also select a kind explicitly, because the `development` and `test` profiles use the mock.

## Production

The mock refuses the `production` profile unless you set `allowInProduction: true`. Do not set it in a deployed application. The refusal is an `INVALID_CONFIG` error when the service connects.
