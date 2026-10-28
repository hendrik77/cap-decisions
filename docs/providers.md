# Adding a provider

A provider is a CAP service kind. The rule is: data in kinds, behaviour in `impl`.

- A kind holds facts about a provider: URL, `modelId`, `requiresToken`, `limits`.
- An `impl` is a subclass of `DecisionsService`. You need one only when the provider's protocol differs from the Jev protocol.

This guide has three levels. Use the lowest level that works.

| Level | Use it when | Where the code lives |
| --- | --- | --- |
| 1. App kind | The server speaks the Jev protocol and you only need a URL, limits or a token flag | Your application's `package.json` |
| 2. App-local subclass | The protocol differs, for example a response envelope or a different URL scheme | A file in your application |
| 3. Provider package | Several applications use the provider, or another party maintains it | A separate npm package |

The subclass hooks used by levels 2 and 3 and the test kit for provider packages are experimental; [ADR 0006](decisions/0006-public-api-for-1.0.md) proposes which of them become stable in 1.0.0. See [Stability](../README.md#stability). The design is explained in [ADR 0001](decisions/0001-provider-kinds-as-cap-service-subclasses.md).

## Level 1: an app kind

Define a kind that extends `decisions-generic` in your application's `package.json`, and select it:

```json
{
  "cds": {
    "requires": {
      "kinds": {
        "decisions-internal": {
          "kind": "decisions-generic",
          "requiresToken": true,
          "limits": { "choiceOptions": 50 },
          "credentials": { "url": "https://jev.internal.example/v1/systemone" }
        }
      },
      "decisions": { "kind": "decisions-internal" }
    }
  }
}
```

The kind can set `modelId`, `timeoutMs`, `requiresToken`, `limits` and a default `credentials.url`. Keep tokens out of this file; see [Provider configuration](../README.md#provider-configuration) in the README. A kind defined this way is also selectable with `cds add decisions --kind decisions-internal`, which writes it into a profile instead of the base level.

## Level 2: an app-local subclass

Write a subclass in your application and point `impl` at it. This example reads a response that wraps the Jev result in `{ "envelope": ... }`:

```json
{
  "cds": {
    "requires": {
      "decisions": {
        "kind": "decisions-generic",
        "impl": "srv/acme-decisions.js",
        "credentials": { "url": "https://acme.example/v1/jev" }
      }
    }
  }
}
```

```js
// srv/acme-decisions.js
const { DecisionsService, DecisionsError } = require('cap-decisions');

class AcmeDecisions extends DecisionsService {
  endpoint(credentials) {
    return credentials.url;
  }

  unwrap(payload) {
    if (!payload || typeof payload !== 'object' || !('envelope' in payload)) {
      throw new DecisionsError('INVALID_RESPONSE', 'Acme response is missing envelope');
    }
    return payload.envelope;
  }
}

module.exports = AcmeDecisions;
```

`tests/extension.test.cjs` runs this subclass against a local server. In TypeScript, write `protected override endpoint(...)` and import the types `DecisionsCredentials` and `DecisionsSettings` from `cap-decisions`.

## Level 3: a provider package

[`examples/provider-package`](../examples/provider-package) is a minimal provider package, `cap-decisions-provider-acme`. It has these parts:

- **A kind in its `package.json`.** The kind extends `decisions-defaults` and sets `impl` to the package itself. CAP loads the package's `main` file, which exports the subclass.
- **`srv/acme-service.js`.** The subclass. It overrides `endpoint` and `unwrap`, overrides `init` to write a debug log before calling `super.init()`, and declares `static credentialKeys = ['region']`.
- **`cds-plugin.js`.** CAP discovers a package's configuration through this file. In the example it holds only a comment.
- **Peer dependencies on `cap-decisions` and `@sap/cds`.** The application's single copies are used. A second copy breaks `instanceof` checks and CAP events.

```json
{
  "name": "cap-decisions-provider-acme",
  "main": "srv/acme-service.js",
  "peerDependencies": {
    "cap-decisions": ">=0.10.0",
    "@sap/cds": "^9 || ^10"
  },
  "cds": {
    "requires": {
      "kinds": {
        "decisions-acme": {
          "kind": "decisions-defaults",
          "impl": "cap-decisions-provider-acme",
          "requiresToken": true,
          "limits": { "choiceOptions": 20 }
        }
      }
    }
  }
}
```

An application installs `cap-decisions` and the provider package, then selects the kind:

```json
{
  "cds": {
    "requires": {
      "decisions": { "kind": "decisions-acme", "credentials": { "region": "eu" } }
    }
  }
}
```

Instead of editing `package.json`, you can run `cds add decisions --kind decisions-acme`. The command lists the kinds of all installed packages as selectable, except `decisions-defaults` and the mock. It writes the kind into the `[production]` profile (or the profile of `--for`) and, because the kind has `requiresToken`, an empty `credentials.token` into `.cdsrc-private.json` and the `.gitignore` line (see [Set up with `cds add decisions`](../README.md#set-up-with-cds-add-decisions)). The `region` credential is not written; set it yourself.

The kind requires a token, so supply `credentials.token` from a secret source such as `.cdsrc-private.json` or a service binding (see [Provider configuration](../README.md#provider-configuration)). The `region` credential works because the subclass lists it in `static credentialKeys`. Without that, the connection fails with `INVALID_CONFIG`.

## Hooks reference

`DecisionsService` validates the request before it calls `call()` and validates the result after `call()` returns. A hook never has to check the shape of the Jev request or answer itself. The hooks are `protected` in TypeScript.

| Hook | Signature | Default | Override when |
| --- | --- | --- | --- |
| `setup` | `setup(settings: DecisionsSettings): Promise<void>` | Creates the HTTP transport and checks the destination. Fails with `INVALID_CONFIG` for a missing token, a missing or invalid endpoint, or a destination that cannot be resolved | The provider does not use HTTP, or needs extra startup work. If you do not call `super.setup()`, no transport exists and the default `call()` cannot be used |
| `call` | `call(request: DecisionRequest, options: DecideOptions): Promise<{ result: unknown; attempts: number }>` | Sends the request over HTTP with retries and a deadline, and returns the unwrapped payload | The flow is not a single HTTP POST. Honour `options.signal` and `settings.timeoutMs` |
| `endpoint` | `endpoint(credentials: DecisionsCredentials): string \| undefined` | `credentials.url` | The URL is built from other credentials. Throw `INVALID_CONFIG` if it cannot be built. Not called when `credentials.destination` is set |
| `unwrap` | `unwrap(payload: unknown): unknown` | Returns `payload` | The Jev result sits inside an envelope. It receives the parsed JSON of a successful HTTP response. Throw `PROVIDER_ERROR` or `INVALID_RESPONSE` for failures. A thrown error is not retried |
| `errorCode` | `errorCode(payload: unknown): string \| number \| undefined` | Returns `undefined`, so the transport reads `error.type` from the error body | The provider reports its error code elsewhere. It receives the parsed JSON of an HTTP error body. The result becomes `providerCode` only if it is a safe integer or a string of up to 100 letters, digits and `_.:-`; otherwise the transport falls back to `error.type` |
| `settingsKeys` | `static settingsKeys: readonly string[]` | `[]` | The subclass adds service-level settings. Listed keys produce no warning. Read them from `this.settings` |
| `credentialKeys` | `static credentialKeys: readonly string[]` | `[]` | The subclass adds credentials. Listed keys under `credentials` are accepted if their values are strings. Unlisted keys fail with `INVALID_CONFIG` |

Three built-in providers show the hooks:

- [`src/providers/cloudflare.ts`](../src/providers/cloudflare.ts) overrides `endpoint`, `unwrap` and `errorCode`.
- [`src/providers/subq.ts`](../src/providers/subq.ts) overrides only `errorCode`: SubQ speaks the Jev protocol, but reports its error type in `detail.error_type`. Its kind, `decisions-subq`, holds the URL, `modelId` and limits as data.
- [`src/providers/mock.ts`](../src/providers/mock.ts) overrides `setup` and `call` and uses no HTTP. It has no transport. It answers from fixtures and a deterministic engine, honours `options.signal` and `settings.timeoutMs` in its simulated delay, and declares its settings in `static settingsKeys`. See [Local development](local-development.md).

## Rules for subclasses

- When you override `init()`, call `await super.init()`. The base class validates settings, runs `setup()` and registers the `decide` handler there.
- Do not reassign `this.on`. Register handlers with it as usual.
- Declare extra settings in `static settingsKeys` and extra credentials in `static credentialKeys`. Everything else is logged as unknown or rejected.
- Throw `DecisionsError` with one of the documented codes (see [Errors](../README.md#errors) in the README): `INVALID_CONFIG` for settings, `INVALID_RESPONSE` for a malformed answer, `PROVIDER_ERROR` for a failure the provider reports, `HTTP_ERROR` with `status` for an HTTP failure.
- Never log request data (`state`, `questions`) or credentials.
- Import `DecisionsService` and `DecisionsError` from `cap-decisions`, not from files inside its `dist` folder.

## Testing a provider package

`cap-decisions/testing` (experimental) runs the checks that every kind must pass, so a provider package does not copy `cap-decisions`'s tests. One call registers them as `node:test` tests; the kit uses no other test framework. Put it in a test file of the package and run `node --test`:

```js
// test/provider.test.cjs
const { testProviderKind } = require('cap-decisions/testing');

testProviderKind({
  kind: 'decisions-acme',
  credentials: { region: 'eu' }, // credentials the kit does not know, listed in credentialKeys
  encode: (response) => ({ data: response }), // the Jev answer in Acme's wire format
});
```

[`examples/provider-package/test/provider.test.cjs`](../examples/provider-package/test/provider.test.cjs) is a working example, and `npm test` runs it.

The kit links the package at `packageDir` (default `process.cwd()`, so run `node --test` from the package root or pass the option) into a temporary CAP app together with the `cap-decisions` and `@sap/cds` that the package resolves, so that one copy of each is loaded. It runs CAP in a child process, starts a local HTTP server in the test process, and points the kind at it through `credentials.url`. The package must therefore have `cap-decisions` and `@sap/cds` installed, as a peer dependency is in development. With `appDir` it uses an existing app instead.

| Option | Meaning |
| --- | --- |
| `kind` | The kind under test. |
| `packageDir` | The provider package. Default `process.cwd()`. |
| `appDir` | An existing CAP app that has the package installed. Nothing is created or linked. |
| `settings` | Further settings for the kind, applied over its resolved settings (`timeoutMs`, `limits`, `modelId`). |
| `credentials` | Further credentials, such as `accountId` or `region`. The kit sets `url` and, when the kind has `requiresToken`, a test `token`, unless `token` is given. |
| `encode(response, request)` | Turns a Jev response into the provider's wire format. Default: the response itself, for a server that speaks the Jev protocol. |
| `encodeError({ code, status, message })` | Takes a `WireErrorInput` and returns a `WireError`, `{ status, body }` (both types are exported from `cap-decisions/testing`), the provider's error response carrying `code` as its machine-readable error. Default: `{ status, body: { error: { type: code } } }`. |

For a provider that reports errors in another shape, pass `encodeError`. SubQ, for instance, answers `{ "detail": { "error_type": "..." } }`:

```js
testProviderKind({
  kind: 'decisions-subq',
  encodeError: ({ code, status, message }) => ({ status, body: { detail: { error_type: code, message } } }),
});
```

The checks, each its own test:

- connecting works with the kit's settings;
- `noul`, `choice` and `score` answers come back typed, and several questions in one request come back under their ids;
- the kind's `modelId` is sent as `model`;
- each limit in the kind's `limits` (`questions`, `choiceOptions`, `scoreCriteria.min` and `max`) rejects a request beyond it with `INVALID_REQUEST` before anything is sent, and a request at the limit is sent. A limit the kind does not set is reported as skipped;
- with `requiresToken`, a missing token is `INVALID_CONFIG` and the token is sent as `Authorization: Bearer <token>`;
- an error response from `encodeError` is `HTTP_ERROR` with its `status` and `providerCode`, and the token is not in the message;
- a 503 is retried;
- a body that is not JSON, and a decision that does not match the questions, are `INVALID_RESPONSE`;
- a closed port is `NETWORK_ERROR`, and a server that does not answer is `TIMEOUT`.

The kit does not check whether the provider's real server accepts the requests, the content of the answers, `destination` credentials, or the provider's in-band error variants (such as Cloudflare's `success: false`). Test those next to the kit call with `node:test` and a local server. The design is explained in [ADR 0007](decisions/0007-provider-test-kit.md).

## When to make a separate package

A provider belongs in its own package when one of these is true ([ADR 0001](decisions/0001-provider-kinds-as-cap-service-subclasses.md), decision 6):

- Another party maintains it.
- It needs its own release cycle.
- It is a different capability, not another way to reach a decision provider.

A provider that only needs a vendor SDK stays in `cap-decisions`, with the SDK as an optional peer dependency, as `@sap-cloud-sdk/connectivity` already is.
