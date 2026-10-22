# cap-jev

`cap-jev` adds an internal System One decision service to SAP CAP Node.js applications. It evaluates `choice`, `score`, and `noul` questions against one text or JSON state. It works with any Jev-compatible System One HTTP endpoint that accepts the same request and response schema. The package creates no OData endpoint and produces no text.

Requirements: Node.js 22 or newer and `@sap/cds` 9 or 10 (the peer range is `^9 || ^10`). CI tests Node.js 22, 24 and 26 against CAP 9 and CAP 10. `cap-jev` supports the last two stable CAP major versions, currently CAP 9 and CAP 10; when a new CAP major is released, the oldest is dropped in the release that adds it. The `cds add systemone` command (see below) needs `@sap/cds-dk` 9 or 10, like every `cds add`; the package itself does not depend on it.

## Install and use

The package is not yet published to npm. Install a release archive from [GitHub releases](https://github.com/hendrik77/cap-jev/releases) in your CAP application. Since npm 12, `npm install` refuses tarball URLs unless the project allows them (the `allow-remote` setting), so either allow URLs listed in your `package.json`:

```sh
npm config set allow-remote root --location=project
npm install https://github.com/hendrik77/cap-jev/releases/download/v0.8.0/cap-jev-0.8.0.tgz
```

or download the archive and install the file, which works with every npm version:

```sh
curl -fLO https://github.com/hendrik77/cap-jev/releases/download/v0.8.0/cap-jev-0.8.0.tgz
npm install ./cap-jev-0.8.0.tgz
```

The first way records the URL in `package.json` and writes `allow-remote=root` to the project's `.npmrc`, so later `npm ci` runs work too. The second records `file:cap-jev-0.8.0.tgz`; keep the archive in the project.

To use an unreleased build, run `npm install && npm pack` in this repository and install the resulting `cap-jev-<version>.tgz` file.

After npm publication, use `npm install cap-jev`.

CAP loads the package's `cds-plugin.js` and adds the `systemone` required service. Select a provider kind for production, either with [`cds add systemone`](#set-up-with-cds-add-systemone) or by hand (see [Provider configuration](#provider-configuration)), supply its secrets through a runtime configuration source, then connect from a service handler:

```ts
import cds from '@sap/cds';
import type { SystemOneService } from 'cap-jev';

const systemOne = (await cds.connect.to('systemone')) as SystemOneService;
const result = await systemOne.decide({
  state: { message: 'I was billed twice. Please refund me.' },
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' },
    },
    urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Low', 'Medium', 'High'] },
    refund: { type: 'noul', instructions: 'Does the customer request a refund?' },
  },
});
console.log(result.answers.department.choice, result.answers.urgency.score, result.answers.refund.noul);
```

Each answer has the `type` of its question:

| Type | Fields |
| --- | --- |
| `choice` | `choice`: the selected criteria key; `probabilities`: one value per key; `confidence` |
| `score` | `score`: a number from 0 to the last criteria index; `legend`: the criteria text by index (`'0'`, `'1'`, …); `probabilities` by index; `confidence` |
| `noul` | `noul`: the probability, from 0 to 1, that the answer is true |

Probabilities and confidence values are numbers from 0 to 1, and each probability map sums to 1.

Choice labels are inferred from the criteria keys: `result.answers.department.choice` is typed as `'billing' | 'technical'`, and its probability map has those same keys. TypeScript rejects unknown labels and can check that a handler map covers every choice:

```ts
// Continues the example above.
const handlers = {
  billing: () => 'Send to accounts',
  technical: () => 'Send to support',
} satisfies Record<typeof result.answers.department.choice, () => string>;
const nextStep = handlers[result.answers.department.choice]();
```

For questions held in a variable, use `satisfies Questions` to keep literal question types and choice labels:

```ts
import type { Questions } from 'cap-jev';
const questions = {
  department: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' },
  },
  refund: { type: 'noul', instructions: 'Does the customer request a refund?' },
} satisfies Questions;
const decision = await systemOne.decide({ state: 'Please refund me', questions });
// decision.answers.department.choice: 'billing' | 'technical'
```

To annotate an answer explicitly, use `ChoiceAnswer<'billing' | 'technical'>`. The default `ChoiceAnswer` and questions with dynamic `Record<string, ...>` criteria keep `choice: string`. Numeric criteria keys infer their string forms, matching the JSON response. Maps explicitly typed as `Questions` keep the broad `Answer` union; once the keys have been widened, the answer type cannot recover their original labels.

Optional criteria keys, such as `technical?: string`, remain valid choices, but their probabilities are typed as `number | undefined` because an omitted key is not sent to the provider; `ChoiceAnswer<'billing' | 'technical', 'technical'>` names that shape explicitly. Responses are validated against the criteria keys present at runtime, so a criteria object with more keys than its declared type, for example a variable assigned to a narrower annotation, can return a label outside the inferred union. Declare criteria inline or with `satisfies` to keep the types and the runtime keys aligned.

Request state, instructions, and criteria must contain plain JSON data: strings, arrays, and plain objects (including null-prototype objects), with JSON primitive values inside them. Circular references and objects such as `Map`, `Set`, `Date`, or class instances are rejected with `INVALID_REQUEST`. Shared references are allowed when they do not form a cycle. Dynamically built maps typed as `Questions` return the `Answer` union, which can be narrowed using `answer.type`.

The [example CAP application](examples/cap-app) shows a TypeScript action handler with exhaustive label handling and error mapping, and explains how to run it. Its CDS action belongs to the application; the plugin registers no annotations or handlers for application actions.

`decide()` sends an internal CAP `decide` event. Applications can register `before` and `after` handlers on the connected service. Configuration is checked when `cds.connect.to('systemone')` runs; invalid settings or a missing endpoint reject that connection with `INVALID_CONFIG`. Pass `{ signal }` (type `DecideOptions`) as the second argument to cancel a call. Successful calls emit a `systemone` debug log with latency, attempt count, model and input/output token counts.

## Set up with `cds add systemone`

After installation, `cds add systemone` configures the production kind in your application. It is a facet of CAP's `cds add` command and needs `@sap/cds-dk`, as every `cds add` does. Run it in the root of the application (`npx cds add systemone` if `@sap/cds-dk` is a local dependency):

```sh
cds add systemone                                          # systemone-laya in the production profile
cds add systemone --kind systemone-typesafe               # also a token placeholder
cds add systemone --kind systemone-laya --with-fixtures   # also example fixtures for the mock
cds add systemone --kind systemone-typesafe --for hybrid  # another profile
```

| Option | Meaning |
| --- | --- |
| `--kind <kind>` | The kind for the target profile. Default `systemone-laya`. Any installed kind, including a provider package's (see [docs/providers.md](docs/providers.md)), except `systemone-defaults` and the mock. An unknown or refused kind fails and lists the selectable kinds |
| `--for <profile>` | CAP's option. The target profile. Default `production` |
| `--force` | CAP's option. Replaces a different kind in the target profile and an existing fixture file. It never replaces a token |
| `--with-fixtures` | Writes an example `test/data/systemone.json` for the mock |

With `P` the target profile, it writes:

| File | Change |
| --- | --- |
| `package.json` | `cds.requires.systemone["[P]"].kind` is the kind. Other keys and the indentation stay as they are |
| `.cdsrc-private.json` | Only for a kind with `requiresToken`: an empty `credentials.token` under `requires.systemone["[P]"]`, unless a token is set there |
| `.gitignore` | The line `.cdsrc-private.json`, when that file is written or exists and the line is missing |
| `test/data/systemone.json` | Only with `--with-fixtures`: two rules, a fixed `choice` answer for refund messages and a simulated 503 for the text `simulate outage`. An existing file is kept unless `--force` is set |

The kind goes into a profile, so the mock stays active in `development` and `test` (see [Local development](#local-development)). Nothing that is already set is overwritten without `--force`. The command prints one line per step, each starting with `[systemone]`, and ends with the next steps: filling in the token, setting `credentials.url` for a kind without a URL, or starting `npx cap-jev-mock` for a kind with a local URL. It warns about a base-level `kind` in `package.json`, which applies to every profile and turns off the mock in development. A second run with the same options changes nothing. Errors, such as a Java project, an unknown kind or an invalid `package.json`, print a message and write nothing.

Without `@sap/cds-dk`, write the same by hand. For `systemone-laya` in production, add this to `package.json`:

```json
{ "cds": { "requires": { "systemone": { "[production]": { "kind": "systemone-laya" } } } } }
```

For a kind with a token, also set `credentials.token` for the same profile from a secret source, for example `.cdsrc-private.json`, which stays out of Git (see [Provider configuration](#provider-configuration)).

## Local development

In the `development` and `test` profiles, an application without an explicit `kind` gets the `systemone-mock` kind. It answers in-process, deterministically and without a server, a token or network access, so `cds watch`, `cds serve` and `cds.test` work out of the box.

- Fixtures in `test/data/systemone.json` give fixed answers or simulated failures for matching input. `cds add systemone --with-fixtures` writes an example file.
- The settings `latencyMs` and `fail` simulate slow and failing providers for error-handling tests.
- To use a real endpoint in development, set a `kind`, for example `CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya`. An explicit kind always wins.
- The mock refuses the `production` profile unless `allowInProduction` is `true`.
- To exercise the HTTP path (retries, timeouts, tokens, `systemone-laya`, `systemone-cloudflare`) without Laya, run the HTTP mock server: `npx cap-jev-mock`, then `CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya npm start`. It gives the same answers as the in-process mock over HTTP. See [HTTP mock server](docs/local-development.md#http-mock-server).

[docs/local-development.md](docs/local-development.md) has the activation table, the settings, the fixture format and the HTTP mock server.

## Provider configuration

Select a provider kind under `cds.requires.systemone` with its full name; `cds add systemone` writes this for a profile (see [Set up with `cds add systemone`](#set-up-with-cds-add-systemone)). Settings sit at service level, except credentials, which sit under `credentials`. If an application sets no `kind`, the plugin uses `systemone-mock` in the `development` and `test` profiles and `systemone-generic` in production. The generic kind has no URL, so a production installation without a kind cannot send data and fails with `INVALID_CONFIG` when it connects. See [Local development](#local-development).

| Kind | Endpoint | `modelId` | `requiresToken` | `limits` |
| --- | --- | --- | --- | --- |
| `systemone-generic` | None; set `credentials.url` to the full POST URL | None | `false` | Protocol minimums only |
| `systemone-mock` | None; answers in-process, without network access. The default in `development` and `test`; refuses `production` unless `allowInProduction` is `true` | None | `false` | Protocol minimums only |
| `systemone-typesafe` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `true` | `choiceOptions`: 255; `scoreCriteria`: 2 to 10 |
| `systemone-cloudflare` | Built from `credentials.accountId`, unless `credentials.url` is set | `clef` | `true` | `questions`: 64 |
| `systemone-subq` | `https://api.subq.ai/v1/systemone` | `subq-snap-preview` | `true` | `questions`: 16; `choiceOptions`: 255; `scoreCriteria`: 2 to 10 |
| `systemone-laya` | `http://127.0.0.1:8000/v1/systemone` | None | `false` | `choiceOptions`: 100 |

`systemone-defaults` is the shared parent of these kinds (the package's service class and `timeoutMs: 10000`). Do not select it.

### Settings

| Setting | Type | Meaning |
| --- | --- | --- |
| `modelId` | string | Model name. Sent as `model` in the request body; omitted when unset. Do not use `model`: CAP reads it as the CDS model of a service, so the plugin logs an error and the connection fails |
| `timeoutMs` | integer, 1 to 2,147,483,647 | Time limit for the whole call, including retries. Default 10,000 |
| `requiresToken` | boolean | When `true`, connecting fails with `INVALID_CONFIG` unless a `credentials.token` is set, or a `credentials.destination` that supplies an `Authorization` header |
| `limits` | object | Request limits checked before anything is sent (see below) |
| `credentials` | object | Secrets and the endpoint (see below) |

`limits` keys, all positive integers:

| Key | Meaning |
| --- | --- |
| `questions` | Maximum number of questions per request |
| `choiceOptions` | Maximum number of criteria in a `choice` question |
| `scoreCriteria.min`, `scoreCriteria.max` | Allowed number of criteria in a `score` question |

The protocol minimums always apply: one question, one choice option and one score criterion. A request that breaks a limit fails with `INVALID_REQUEST`.

`credentials` keys, all strings:

| Key | Meaning |
| --- | --- |
| `url` | Full POST URL of the endpoint |
| `token` | Bearer token |
| `accountId` | Account ID; used by `systemone-cloudflare` to build the URL |
| `destination` | Name of a BTP Destination service entry (see below) |

Settings are deep-merged over the kind's settings, so an application overrides single values. This keeps the TypeSafe model, token requirement and score limits and raises the choice limit:

```json
{ "cds": { "requires": { "systemone": { "kind": "systemone-typesafe", "limits": { "choiceOptions": 300 } } } } }
```

Settings are validated when the service is created. These fail with `INVALID_CONFIG`: `model`; `token`, `url`, `accountId` or `destination` at service level instead of under `credentials`; an unknown `credentials` key; a malformed `modelId`, `requiresToken`, `limits` or `timeoutMs`; and a missing token when the kind requires one. An unknown service-level key only logs a warning. Settings are snapshotted when the service is created; restart the application to apply changes.

For a local or other Jev-compatible server, use the generic kind with an explicit endpoint:

```json
{ "cds": { "requires": { "systemone": { "kind": "systemone-generic", "credentials": { "url": "http://127.0.0.1:8000/v1/systemone" } } } } }
```

CAP profiles can select different kinds:

```json
{ "cds": { "requires": { "systemone": { "kind": "systemone-typesafe", "[development]": { "kind": "systemone-laya" } } } } }
```

Keep tokens and account IDs out of committed files. CAP can inject them from these sources:

| Environment | Secret source |
| --- | --- |
| Local | `.cdsrc-private.json` or `cds bind` |
| Cloud Foundry | User-provided service named `systemone` |
| Kyma/Kubernetes | `servicebinding.io` Secret via `SERVICE_BINDING_ROOT` |
| Any | `CDS_CONFIG` JSON or `CDS_REQUIRES_SYSTEMONE_CREDENTIALS_TOKEN` |

`systemone-cloudflare` needs `accountId` and a separate account-owned token with only **Workers AI – Read** and **Workers AI – Edit** permissions. A token is sent only over HTTPS or to `127.0.0.1`, `localhost`, or `::1` over HTTP. The Cloudflare adapter requires `success: true` and unwraps `result`.

`systemone-subq` talks to SubQ Snap, which is in public preview: `modelId` (`subq-snap-preview`) will change when SubQ releases the model, and an application can override it. A request without credits fails with `HTTP_ERROR` and status 402. SubQ stores decisions according to its [data retention](https://docs.subq.ai/using-the-api/data-retention/) policy. The kind selects a small subclass that reads SubQ's error type (`detail.error_type`) into `providerCode`. Images in a request are not supported.

### Destinations

On SAP BTP, you can set `credentials.destination` to the name of a Destination service entry instead of supplying `url` and `token`. Install the optional peer package `@sap-cloud-sdk/connectivity` in the CAP application. Set the destination URL to the full POST endpoint and use a `NoAuthentication` destination with a `URL.headers.Authorization` property containing the bearer header. The plugin resolves the destination with `getDestination()` when the service is created and for each call; it uses the SDK's cache. The token transport rule also applies to destination headers. When `requiresToken` is `true`, the destination must supply an `Authorization` header (or a `token` must be set), or the connection fails with `INVALID_CONFIG`. This integration reads the destination URL and static headers; other destination authentication flows are outside its scope.

```json
{ "cds": { "requires": { "systemone": { "kind": "systemone-generic", "credentials": { "destination": "systemone-api" } } } } }
```

## Errors

Responses must include a model identifier, one correctly typed answer per question, and usage counts. Failures throw `SystemOneError` with a `code` of type `SystemOneErrorCode`:

| Code | Cause |
| --- | --- |
| `INVALID_CONFIG` | Invalid settings (such as `model`, a secret outside `credentials`, an unknown `credentials` key, or a malformed limit or timeout), a missing token when the kind requires one, or a missing or invalid endpoint, reported by `cds.connect.to('systemone')`; also a destination that cannot be resolved for a call |
| `INVALID_REQUEST` | The request does not match the question schema or the provider's limits; nothing is sent |
| `INVALID_RESPONSE` | The response is malformed JSON or does not match the questions |
| `HTTP_ERROR` | The endpoint returned an error status; `status` and, when available, `providerCode` are set |
| `PROVIDER_ERROR` | The provider reported a failure in a successful HTTP response; `systemone-cloudflare` returned `success: false` |
| `NETWORK_ERROR` | The connection or response body failed after all retries, or a retry would not fit into the remaining call deadline |
| `TIMEOUT` | The call exceeded `timeoutMs` |
| `ABORTED` | The caller's `signal` cancelled the call |

`providerCode` is a safe machine-readable provider error code. Network and parse errors retain their original `cause`; HTTP errors omit the response object.

HTTP 429, 502, 503, 504 and 529, and network failures (including interrupted response bodies), are retried at most twice, honoring `Retry-After` or using jittered backoff. If the retry delay does not fit into the remaining call deadline, the failure is returned immediately: an HTTP failure as `HTTP_ERROR` with its status and provider code, a network failure as `NETWORK_ERROR` with its cause. Complete malformed JSON responses fail with `INVALID_RESPONSE` without retrying. Caller cancellation through the `signal` option throws `ABORTED`. Request state and credentials are never logged by this package.

## Protecting actions that call a provider

`cap-jev` serves no service of its own. An application action that calls `decide()` spends provider quota, so protect it in the application with `@requires` or `@restrict`. The [example application](examples/cap-app) uses `@requires: 'authenticated-user'` on its service.

## Adding a provider

You can add a provider at three levels:

- A Jev-compatible server that needs only a URL, limits or a token flag: define a kind in your `package.json` that extends `systemone-generic`.
- A provider with its own protocol: write a subclass of `SystemOneService` in your application and point a kind's `impl` at it.
- A provider shared between applications: ship the kind and the subclass in a provider package. Its kind is selectable with `cds add systemone --kind <kind>`.

[docs/providers.md](docs/providers.md) shows each level, the subclass hooks and the rules for subclasses. The subclass hooks are experimental (see [Stability](#stability)).

A provider package tests its kind with one call of `cap-jev/testing` (experimental): `testProviderKind({ kind, encode })` registers the checks every kind must pass as `node:test` tests. See [Testing a provider package](docs/providers.md#testing-a-provider-package).

## Stability

| Area | Status |
| --- | --- |
| `cds.connect.to('systemone')`, `decide()` and its options (`DecideOptions`) | Stable |
| The request, question and answer types | Stable |
| `SystemOneError` and its codes | Stable |
| The kind names (except `systemone-subq`, see below) and the settings, including the `systemone-mock` kind and its settings (`MockSettings`) | Stable |
| The kind `systemone-subq`, its settings and its subclass `cap-jev/providers/subq` (`SubqService`), while SubQ's model is in preview | Experimental |
| The subclass hooks: `setup`, `call`, `endpoint`, `unwrap`, `errorCode`, and the static `settingsKeys` and `credentialKeys` | Experimental until the first npm publication |
| The HTTP mock server: `cap-jev/mock-server` (`startMockServer`, `MockServerOptions`, `MockServer`) and the `cap-jev-mock` command line | Experimental until the first npm publication |
| The `cds add systemone` facet and its options (`--kind` and `--with-fixtures`; `--for` and `--force` are CAP's) | Experimental until the first npm publication |
| The provider test kit: `cap-jev/testing` (`testProviderKind`, `ProviderKindTestOptions`) | Experimental |

`MockSettings` is exported as a type; `MockServerOptions` and `MockServer` come from `cap-jev/mock-server`. `SystemOneTransport` is internal and not exported.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm run build
npm test
npm run coverage
npm pack --dry-run
npm run release:check
```

Tests use Node's built-in test runner and need no external API key; HTTP tests run against local servers. `npm test` builds the package and runs `tests/*.test.cjs` and the test of the example provider package. To run one file: `node --test tests/transport.test.cjs`. `@sap/cds-dk` is a development dependency (`^10`); the `cds add` tests run its real command line.

`npm run coverage` runs the same tests with Node's built-in coverage of `dist/` and fails when the total falls below 98 % of lines, 96 % of branches or 98 % of functions (the thresholds are in the script in `package.json`). CI runs it instead of `npm test` in one job only, Node 24 with CAP 10; all other jobs run `npm test`. A child process is counted when it exits on its own, so the `cds add` facet and the CAP apps of the tests are included. Not counted: a process that a signal stops, so the run-until-stopped part of the `cap-jev-mock` command line (`dist/mock-server-cli.js`) looks weaker than it is; `cds-plugin.js`, which is outside `dist/`; and the CAP side of the test kit (`cap-jev/testing`), which runs from a string in a child process. Those parts are tested in child processes (see below).

- CAP-level tests create temporary CAP apps with `tests/helpers/app.cjs`. The apps use the repository's `cap-jev` and `@sap/cds`, so one copy of each is loaded.
- `tests/mock.test.cjs`, `tests/mock-engine.test.cjs` and `tests/mock-fixtures.test.cjs` test the mock provider: activation in each profile, production refusal, fixtures, simulated failures and latency, and the answer engine. `tests/mock.test.ts` checks the `MockSettings` types.
- `tests/mock-core.test.cjs` tests the mock core that `MockService` and the server share: option checks, fixture loading and the order of `fail`, rules and engine.
- `tests/mock-server.test.cjs` tests the HTTP mock server with plain `fetch`: the request and failure tables, the Cloudflare format, the token, latency and disconnects, the options, and loading without `@sap/cds`. `tests/mock-server-cap.test.cjs` runs temporary CAP apps in the production profile against it, with the generic and Cloudflare kinds. `tests/mock-server-cli.test.cjs` runs the `cap-jev-mock` command line in child processes. `tests/mock-server.test.ts` checks the `MockServerOptions` types.
- `tests/add-core.test.cjs` tests the planner of the `cds add systemone` facet (`dist/add-core.js`): the options, the files and messages for each existing configuration, the refused kinds, indentation, a second run that writes nothing, the example fixtures, and loading without `@sap/cds`.
- `tests/cds-add.test.cjs` runs the real `cds add systemone` of `@sap/cds-dk` in temporary apps: the default run, `--kind`, `--for`, `--force`, `--with-fixtures`, an unknown kind, a Java project, a second run, `cds add --help`, a provider package's kind, and the configured app connecting in development (mock) and production (HTTP mock server). `tests/plugin.test.cjs` checks in child processes with a stubbed `cds.add` that `cds-plugin.js` registers the facet for `cds add` and `cds help` only, and never throws.
- `tests/testing.test.cjs` runs the provider test kit (`cap-jev/testing`) against the built-in token kinds and Cloudflare, checks that a provider package with a wrong `unwrap` fails it with the name of the failing check, that the kit works in an existing app (`appDir`), that requiring the kit loads no `@sap/cds`, and that `cds-plugin.js` does not load the kit. `examples/provider-package/test/provider.test.cjs` runs the kit for `systemone-acme`; `npm test` runs it too.
- `tests/release-scripts.test.cjs` tests the release scripts `scripts/release-check.cjs` and `scripts/release-notes.cjs` in temporary directories.
- Because the mock is the default in `development` and `test`, a test that needs a real or fake HTTP endpoint selects a kind explicitly. The HTTP mock server can serve as that endpoint, so a test needs no fake server of its own.
- `tests/example-app.test.cjs` and `tests/example-app-failure.test.cjs` run `examples/cap-app` with `cds.test` on the mock, without a fake server.
- `tests/cap-integration.test.cjs` installs the packed package in a copy of the example app, using the npm cache when available and the registry otherwise. It makes its server calls in the production profile and one call in development on the mock, checks that the installed `cap-jev-mock` command runs, and runs `cds add systemone` from the installed package.
- `npm run typecheck` also checks the types in `tests/*.test.ts`: answer inference, choice labels, exports and the subclass hooks.
- `npm run build` emits CommonJS JavaScript and declarations in `dist/`.

To test against CAP 9, run `npm install --no-save @sap/cds@^9 @sap/cds-dk@^9` and then `npm test`. Run `npm install` afterwards to restore CAP 10. With npm 12 or later, which blocks install scripts, `@sap/cds-dk` 9 leaves `better-sqlite3` without its native binding; run `npx --no-install prebuild-install` in `node_modules/better-sqlite3`, or the example-app tests hang.

`npm run release:check` checks that the version in `package.json` matches `package-lock.json`, the example app's `cap-jev` range, the release archive URLs and archive file names in both READMEs and a heading in `CHANGELOG.md`. It also checks that the `@sap/cds` peer range in `package.json` and in `examples/provider-package/package.json` names exactly the CAP majors in the `cds` matrix of `.github/workflows/ci.yml` (`^9 || ^10` for `cds: [9, 10]`), so the supported and the tested CAP versions cannot differ. `npm run release:check -- --tag v<x.y.z>` also checks the tag. It fails on a machine path (such as a home or temporary directory of a developer) in any tracked text file; `npm run release:check -- --archive <file.tgz>` runs only that check on a packed archive, as the release workflow does.

[CI](https://github.com/hendrik77/cap-jev/actions/workflows/ci.yml) runs lint, typecheck (CAP 10 only), tests (including the build) and `npm pack --dry-run` on Node.js 22, 24 and 26 with CAP 9 and CAP 10 (and `@sap/cds-dk` 9 and 10, matching CAP), for pushes to branches and for pull requests. Pushing a tag `v<x.y.z>` runs the [release workflow](.github/workflows/release.yml), which runs CI on the tagged commit, checks the release with `npm run release:check` and creates the GitHub release with the `npm pack` archive and the changelog section as notes.

Design decisions are recorded in [docs/decisions/](docs/decisions/).

## Protocol references

- [TypeSafe System One API](https://docs.typesafe.ai/api)
- [SubQ Decisions API](https://docs.subq.ai/endpoints/decisions-api/)
- [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/)
- [Laya HTTP server](https://github.com/WhoIsMrSentry/laya-system-one#self-hosting-http-server-jev-compatible)
- [CAP plugin packages](https://cap.cloud.sap/docs/node.js/cds-plugins)
