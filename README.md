# cap-jev

`cap-jev` adds an internal System One decision service to SAP CAP Node.js 10 applications on Node.js 22 or newer. It evaluates `choice`, `score`, and `noul` questions against one text or JSON state. It works with any Jev-compatible System One HTTP endpoint that accepts the same request and response schema. The package creates no OData endpoint and produces no text.

## Install and use

The package is not yet published to npm. Install a release archive from [GitHub releases](https://github.com/hendrik77/cap-jev/releases) in your CAP application:

```sh
npm install https://github.com/hendrik77/cap-jev/releases/download/v0.4.3/cap-jev-0.4.3.tgz
```

To use an unreleased build, run `npm install && npm pack` in this repository and install the resulting `cap-jev-<version>.tgz` file.

After npm publication, use `npm install cap-jev`.

CAP loads the package's `cds-plugin.js` and adds the `systemone` required service. Select a provider kind in your application's `package.json`, supply its secrets through a runtime configuration source, then connect from a service handler:

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

`decide()` sends an internal CAP `decide` event. Applications can register `before` and `after` handlers on the connected service. Configuration is checked when `cds.connect.to('systemone')` runs; an invalid endpoint rejects that connection with `INVALID_CONFIG`. Pass `{ signal }` as the second argument to cancel a call. Successful calls emit a `systemone` debug log with latency, attempt count, model and input/output token counts.

## Provider configuration

Select a `kind` under `cds.requires.systemone`. Non-secret settings (`provider`, `model`, `timeoutMs`) live at service level; credentials (`url`, `token`, `accountId`, `destination`) live under `credentials`. The base `systemone` kind is a generic Jev-compatible endpoint with no default URL or model, so a bare installation cannot send data. `timeoutMs` defaults to 10,000 for the whole call and must be an integer from 1 to 2,147,483,647 ms. Settings are snapshotted when the transport is constructed; restart the application to apply configuration changes.

| Kind | Endpoint and model | Credentials | Request limits |
| --- | --- | --- | --- |
| `systemone` | Supply a full POST `credentials.url`; `model` is optional | Token optional | Structural checks only |
| `systemone-typesafe` | TypeSafe System One, `jev-latest` | Token required | At most 255 choice options; 2–10 score criteria |
| `systemone-cloudflare` | Cloudflare Clef; URL built from `accountId`; model `clef` | `accountId` and token required | 1–64 questions |
| `systemone-laya` | Loopback Laya endpoint, no model | Token optional | At most 100 choice options |

For TypeSafe or Cloudflare, select the kind in committed configuration and inject the token separately:

```json
{ "cds": { "requires": { "systemone": { "kind": "systemone-typesafe" } } } }
```

```json
{ "cds": { "requires": { "systemone": { "kind": "systemone-cloudflare" } } } }
```

For a local or other Jev-compatible server, use the base kind with an explicit endpoint:

```json
{ "cds": { "requires": { "systemone": { "kind": "systemone", "credentials": { "url": "http://127.0.0.1:8000/v1/systemone" } } } } }
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

Cloudflare needs a separate account-owned token with only **Workers AI – Read** and **Workers AI – Edit** permissions. A token is sent only over HTTPS or to `127.0.0.1`, `localhost`, or `::1` over HTTP. The Cloudflare adapter requires `success: true` and unwraps `result`.

On SAP BTP, you can set `credentials.destination` to the name of a Destination service entry instead of supplying `url` and `token`. Install the optional peer package `@sap-cloud-sdk/connectivity` in the CAP application. Set the destination URL to the full POST endpoint and use a `NoAuthentication` destination with a `URL.headers.Authorization` property containing the bearer header. The plugin resolves the destination with `getDestination()` at startup and for each call; it uses the SDK's cache. The token transport rule also applies to destination headers. This integration reads the destination URL and static headers; other destination authentication flows are outside its scope.

```json
{ "cds": { "requires": { "systemone": { "kind": "systemone", "credentials": { "destination": "systemone-api" } } } } }
```

Responses must include a model identifier, one correctly typed answer per question, and usage counts. Failures throw `SystemOneError` with a `code` of type `SystemOneErrorCode`:

| Code | Cause |
| --- | --- |
| `INVALID_CONFIG` | Invalid settings, reported by `cds.connect.to('systemone')` or the transport constructor, or a destination that cannot be resolved for a call |
| `INVALID_REQUEST` | The request does not match the question schema or the provider's limits; nothing is sent |
| `INVALID_RESPONSE` | The response is malformed JSON or does not match the questions |
| `HTTP_ERROR` | The endpoint returned an error status; `status` and, when available, `providerCode` are set |
| `PROVIDER_ERROR` | Cloudflare returned `success: false` |
| `NETWORK_ERROR` | The connection or response body failed after all retries |
| `TIMEOUT` | The call exceeded `timeoutMs` |
| `ABORTED` | The caller's `signal` cancelled the call |

`providerCode` is a safe machine-readable provider error code. Network and parse errors retain their original `cause`; HTTP errors omit the response object.

HTTP 429, 502, 503, 504 and 529, and network failures (including interrupted response bodies), are retried at most twice, honoring `Retry-After` or using jittered backoff. If the retry delay does not fit into the remaining call deadline, an HTTP failure is returned immediately as `HTTP_ERROR` with its status and provider code. Complete malformed JSON responses fail with `INVALID_RESPONSE` without retrying. Both the service and `SystemOneTransport.decide()` accept `{ signal }` as the second argument (type `DecisionOptions` for the transport); caller cancellation throws `ABORTED`. Request state and credentials are never logged by this package.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

The test suite uses local HTTP servers and needs no external API key. The integration test installs the packed plugin in a temporary CAP application using the npm cache when available, and the registry otherwise; its test and child processes have timeouts. To run one focused test: `node --test tests/transport.test.cjs`. `npm run typecheck` also checks answer inference and narrowing in `tests/types.test.ts` and exact choice labels in `tests/choice-labels.test.ts`. `npm run build` emits CommonJS JavaScript and declarations in `dist/`.

[CI](https://github.com/hendrik77/cap-jev/actions/workflows/ci.yml) runs lint, typecheck, tests (including the build), and package checks on Node.js 22, 24, and 26 for pushes and pull requests.

## Protocol references

- [TypeSafe System One API](https://docs.typesafe.ai/api)
- [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/)
- [Laya HTTP server](https://github.com/WhoIsMrSentry/laya-system-one#self-hosting-http-server-jev-compatible)
- [CAP plugin packages](https://cap.cloud.sap/docs/node.js/cds-plugins)
