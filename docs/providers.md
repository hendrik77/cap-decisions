# Adding a provider

A provider is a CAP service kind. The rule is: data in kinds, behaviour in `impl`.

- A kind holds facts about a provider: URL, `modelId`, `requiresToken`, `limits`.
- An `impl` is a subclass of `SystemOneService`. You need one only when the provider's protocol differs from the Jev protocol.

This guide has three levels. Use the lowest level that works.

| Level | Use it when | Where the code lives |
| --- | --- | --- |
| 1. App kind | The server speaks the Jev protocol and you only need a URL, limits or a token flag | Your application's `package.json` |
| 2. App-local subclass | The protocol differs, for example a response envelope or a different URL scheme | A file in your application |
| 3. Provider package | Several applications use the provider, or another party maintains it | A separate npm package |

The subclass hooks used by levels 2 and 3 are experimental until the first npm publication. See [Stability](../README.md#stability). The design is explained in [ADR 0001](decisions/0001-provider-kinds-as-cap-service-subclasses.md).

## Level 1: an app kind

Define a kind that extends `systemone-generic` in your application's `package.json`, and select it:

```json
{
  "cds": {
    "requires": {
      "kinds": {
        "systemone-internal": {
          "kind": "systemone-generic",
          "requiresToken": true,
          "limits": { "choiceOptions": 50 },
          "credentials": { "url": "https://jev.internal.example/v1/systemone" }
        }
      },
      "systemone": { "kind": "systemone-internal" }
    }
  }
}
```

The kind can set `modelId`, `timeoutMs`, `requiresToken`, `limits` and a default `credentials.url`. Keep tokens out of this file; see [Provider configuration](../README.md#provider-configuration) in the README.

## Level 2: an app-local subclass

Write a subclass in your application and point `impl` at it. This example reads a response that wraps the Jev result in `{ "envelope": ... }`:

```json
{
  "cds": {
    "requires": {
      "systemone": {
        "kind": "systemone-generic",
        "impl": "srv/acme-systemone.js",
        "credentials": { "url": "https://acme.example/v1/jev" }
      }
    }
  }
}
```

```js
// srv/acme-systemone.js
const { SystemOneService, SystemOneError } = require('cap-jev');

class AcmeSystemOne extends SystemOneService {
  endpoint(credentials) {
    return credentials.url;
  }

  unwrap(payload) {
    if (!payload || typeof payload !== 'object' || !('envelope' in payload)) {
      throw new SystemOneError('INVALID_RESPONSE', 'Acme response is missing envelope');
    }
    return payload.envelope;
  }
}

module.exports = AcmeSystemOne;
```

`tests/extension.test.cjs` runs this subclass against a local server. In TypeScript, write `protected override endpoint(...)` and import the types `SystemOneCredentials` and `SystemOneSettings` from `cap-jev`.

## Level 3: a provider package

[`examples/provider-package`](../examples/provider-package) is a minimal provider package, `cap-jev-provider-acme`. It has these parts:

- **A kind in its `package.json`.** The kind extends `systemone-defaults` and sets `impl` to the package itself. CAP loads the package's `main` file, which exports the subclass.
- **`srv/acme-service.js`.** The subclass. It overrides `endpoint` and `unwrap`, and declares `static credentialKeys = ['region']`.
- **`cds-plugin.js`.** CAP discovers a package's configuration through this file. In the example it holds only a comment.
- **Peer dependencies on `cap-jev` and `@sap/cds`.** The application's single copies are used. A second copy breaks `instanceof` checks and CAP events.

```json
{
  "name": "cap-jev-provider-acme",
  "main": "srv/acme-service.js",
  "peerDependencies": {
    "cap-jev": ">=0.5.0",
    "@sap/cds": ">=9"
  },
  "cds": {
    "requires": {
      "kinds": {
        "systemone-acme": {
          "kind": "systemone-defaults",
          "impl": "cap-jev-provider-acme",
          "requiresToken": true,
          "limits": { "choiceOptions": 20 }
        }
      }
    }
  }
}
```

An application installs `cap-jev` and the provider package, then selects the kind:

```json
{
  "cds": {
    "requires": {
      "systemone": { "kind": "systemone-acme", "credentials": { "region": "eu" } }
    }
  }
}
```

The kind requires a token, so supply `credentials.token` from a secret source such as `.cdsrc-private.json` or a service binding (see [Provider configuration](../README.md#provider-configuration)). The `region` credential works because the subclass lists it in `static credentialKeys`. Without that, the connection fails with `INVALID_CONFIG`.

## Hooks reference

`SystemOneService` validates the request before it calls `call()` and validates the result after `call()` returns. A hook never has to check the shape of the Jev request or answer itself. The hooks are `protected` in TypeScript.

| Hook | Signature | Default | Override when |
| --- | --- | --- | --- |
| `setup` | `setup(settings: SystemOneSettings): Promise<void>` | Creates the HTTP transport and checks the destination. Fails with `INVALID_CONFIG` for a missing token, a missing or invalid endpoint, or a destination that cannot be resolved | The provider does not use HTTP, or needs extra startup work. If you do not call `super.setup()`, no transport exists and the default `call()` cannot be used |
| `call` | `call(request: DecisionRequest, options: DecideOptions): Promise<{ result: unknown; attempts: number }>` | Sends the request over HTTP with retries and a deadline, and returns the unwrapped payload | The flow is not a single HTTP POST. Honour `options.signal` and `settings.timeoutMs` |
| `endpoint` | `endpoint(credentials: SystemOneCredentials): string \| undefined` | `credentials.url` | The URL is built from other credentials. Throw `INVALID_CONFIG` if it cannot be built. Not called when `credentials.destination` is set |
| `unwrap` | `unwrap(payload: unknown): unknown` | Returns `payload` | The Jev result sits inside an envelope. It receives the parsed JSON of a successful HTTP response. Throw `PROVIDER_ERROR` or `INVALID_RESPONSE` for failures. A thrown error is not retried |
| `errorCode` | `errorCode(payload: unknown): string \| number \| undefined` | Returns `undefined`, so the transport reads `error.type` from the error body | The provider reports its error code elsewhere. It receives the parsed JSON of an HTTP error body. The result becomes `providerCode` only if it is a safe integer or a string of up to 100 letters, digits and `_.:-` |
| `settingsKeys` | `static settingsKeys: readonly string[]` | `[]` | The subclass adds service-level settings. Listed keys produce no warning. Read them from `this.settings` |
| `credentialKeys` | `static credentialKeys: readonly string[]` | `[]` | The subclass adds credentials. Listed keys under `credentials` are accepted if their values are strings. Unlisted keys fail with `INVALID_CONFIG` |

[`src/providers/cloudflare.ts`](../src/providers/cloudflare.ts) is the built-in example: it overrides `endpoint`, `unwrap` and `errorCode`.

## Rules for subclasses

- When you override `init()`, call `await super.init()`. The base class validates settings, runs `setup()` and registers the `decide` handler there.
- Do not reassign `this.on`. Register handlers with it as usual.
- Declare extra settings in `static settingsKeys` and extra credentials in `static credentialKeys`. Everything else is logged as unknown or rejected.
- Throw `SystemOneError` with one of the documented codes (see [Errors](../README.md#errors) in the README): `INVALID_CONFIG` for settings, `INVALID_RESPONSE` for a malformed answer, `PROVIDER_ERROR` for a failure the provider reports, `HTTP_ERROR` with `status` for an HTTP failure.
- Never log request data (`state`, `questions`) or credentials.
- Import `SystemOneService` and `SystemOneError` from `cap-jev`, not from files inside its `dist` folder.

## When to make a separate package

A provider belongs in its own package when one of these is true ([ADR 0001](decisions/0001-provider-kinds-as-cap-service-subclasses.md), decision 6):

- Another party maintains it.
- It needs its own release cycle.
- It is a different capability, not another way to reach a decision provider.

A provider that only needs a vendor SDK stays in `cap-jev`, with the SDK as an optional peer dependency, as `@sap-cloud-sdk/connectivity` already is.
