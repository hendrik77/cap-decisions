# cap-jev

`cap-jev` adds an internal System One decision service to SAP CAP Node.js 10 applications on Node.js 22 or newer. It evaluates `choice`, `score`, and `noul` questions against one text or JSON state. It works with any Jev-compatible System One HTTP endpoint that accepts the same request and response schema. The package creates no OData endpoint and produces no text.

## Install and use

The package is not yet published to npm. Until publication, build a tarball from this repository and install it in your CAP application:

```sh
npm install
npm pack
# In your CAP application:
npm install /path/to/cap-jev/cap-jev-0.3.0.tgz
```

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
console.log(result.answers.department.choice, result.answers.refund.noul);
```

For questions held in a variable, use `satisfies Questions` to keep literal question types:

```ts
import type { Questions } from 'cap-jev';
const questions = {
  refund: { type: 'noul', instructions: 'Does the customer request a refund?' },
} satisfies Questions;
const result = await systemOne.decide({ state: 'Please refund me', questions });
```

Request state, instructions, and criteria must contain plain JSON data: strings, arrays, and plain objects (including null-prototype objects), with JSON primitive values inside them. Circular references and objects such as `Map`, `Set`, `Date`, or class instances are rejected with `INVALID_REQUEST`. Shared references are allowed when they do not form a cycle. Dynamically built maps typed as `Questions` return the `Answer` union, which can be narrowed using `answer.type`.

The [example CAP application](examples/cap-app) shows a TypeScript action handler. Its CDS action belongs to the application; the plugin registers no annotations or handlers for application actions.

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

Responses must include a model identifier, one correctly typed answer per question, and usage counts. Invalid input, malformed responses, HTTP errors, and timeouts throw `SystemOneError` with `code` and, for HTTP errors, `status`. A safe machine-readable provider error code, when available, is exposed as `providerCode`. Network and parse errors retain their original `cause`; HTTP errors omit the response object. HTTP 429, 502, 503, 504 and 529, and network failures (including interrupted response bodies), are retried at most twice, honoring `Retry-After` or using jittered backoff. If the retry delay does not fit into the remaining call deadline, an HTTP failure is returned immediately as `HTTP_ERROR` with its status and provider code. Complete malformed JSON responses fail with `INVALID_RESPONSE` without retrying. Both the service and `SystemOneTransport.decide()` accept `{ signal }` as the second argument; caller cancellation throws `ABORTED`. Request state and credentials are never logged by this package.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

The test suite uses local HTTP servers and needs no external API key. The integration test installs the packed plugin in a temporary CAP application using the npm cache when available, and the registry otherwise; its test and child processes have timeouts. To run one focused test: `node --test tests/transport.test.cjs`. `npm run typecheck` also checks answer inference and narrowing in `tests/types.test.ts`. `npm run build` emits CommonJS JavaScript and declarations in `dist/`.

[CI](https://github.com/hendrik77/cap-jev/actions/workflows/ci.yml) runs lint, typecheck, tests (including the build), and package checks on Node.js 22, 24, and 26 for pushes and pull requests.

## Protocol references

- [TypeSafe System One API](https://docs.typesafe.ai/api)
- [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/)
- [Laya HTTP server](https://github.com/WhoIsMrSentry/laya-system-one#self-hosting-http-server-jev-compatible)
- [CAP plugin packages](https://cap.cloud.sap/docs/node.js/cds-plugins)
