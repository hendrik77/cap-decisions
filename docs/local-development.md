# Local development

In the `development` and `test` profiles, `cap-jev` answers from an in-process mock provider. `cds watch`, `cds serve` and `cds.test` work without a provider server, a token or network access. In production, the plugin keeps `systemone-generic`.

The mock is the `systemone-mock` kind. Its answers are simulated, deterministic and valid against the Jev protocol, so request and response validation, `before` and `after` handlers and logging behave as they do with a real provider. The design is explained in [ADR 0002](decisions/0002-in-process-mock-provider.md). The [example app](../examples/cap-app) runs on the mock.

## When the mock is active

The plugin's `package.json` selects `systemone-mock` in the `development` and `test` profiles. An explicit `kind` in your application always wins.

| Your `cds.requires.systemone` | `development` and `test` | `production` |
| --- | --- | --- |
| No entry | Mock | Generic: connecting fails with `INVALID_CONFIG` because there is no URL |
| `"kind": "systemone-typesafe"` (or any other kind) | That kind | That kind |
| `"[production]": { "kind": "systemone-typesafe" }` | Mock | TypeSafe |
| Only `credentials.url`, no `kind` | Mock | Generic with that URL |

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
| `when.stateIncludes` | A string or an array of strings. The rule matches when any of them occurs in the state, ignoring case. The mock searches all string values in the state, nested ones included. Omit it to match every state |
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

## When to use something else

The mock does not understand text. Its answers show that your code handles the protocol and the shape of the answers. They say nothing about the quality of a real model.

To check real answers, use a real endpoint:

- **Laya**, a self-hosted Jev-compatible server (`systemone-laya`).
- **A hosted provider**, such as `systemone-typesafe` or `systemone-cloudflare`, with a token from a secret source (see [Provider configuration](../README.md#provider-configuration)).

Select the kind explicitly, because an explicit kind always wins over the mock. For one run in development:

```sh
CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya npm start
```

The [example app](../examples/cap-app#use-a-real-jev-server) uses the mock in development and `systemone-laya` in production. Automated tests that need a real endpoint must also select a kind explicitly, because the `development` and `test` profiles use the mock.

## Production

The mock refuses the `production` profile unless you set `allowInProduction: true`. Do not set it in a deployed application. The refusal is an `INVALID_CONFIG` error when the service connects.
