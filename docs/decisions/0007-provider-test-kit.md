# 7. Provider test kit `cap-jev/testing`

**Date:** 2026-10-22
**Status:** Proposed

## Context

A provider package ([ADR 0001](0001-provider-kinds-as-cap-service-subclasses.md), level 3 of [Adding a provider](../providers.md)) adds a kind and, when its protocol differs, a `SystemOneService` subclass. Every such package has to show that its kind behaves like the built-in ones: the settings validate, the three question types come back typed, the kind's limits reject a request before anything is sent, a missing token fails with `INVALID_CONFIG`, errors and retries map to the documented codes. The built-in providers do this in `tests/cloudflare.test.cjs`, `tests/subq.test.cjs`, `tests/kinds.test.cjs` and `tests/extension.test.cjs`. Each of those files builds a temporary CAP app, starts a local fake server and runs a script in a child process; the helpers (`tests/helpers/app.cjs`, `tests/helpers/fake-server.cjs`) are not part of the package.

A provider package that wants the same checks today copies those files and keeps them in step by hand. `cap-jev` 1.0.0 should give it one function instead. The kit is new in 0.9.0 and no external provider package uses it yet; [ADR 0006](0006-public-api-for-1.0.md) proposes the status **experimental** for 1.0.0.

What differs between providers is only the wire format: the envelope around a successful answer (Cloudflare: `{ success, errors, result }`, Acme: `{ data }`) and the body of an error (Jev: `{ error: { type } }`, Cloudflare: `{ errors: [{ code }] }`, SubQ: `{ detail: { error_type } }`). Everything else, from the request that `cap-jev` sends to the error codes it raises, is the contract of `SystemOneService` and the same for every kind.

## Options considered

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** Copy the tests | No new code in `cap-jev`; every package owns copies of the helpers, which drift from the contract, and a new check in `cap-jev` reaches no package | Rejected |
| **B.** A fake-server helper only (`startFakeServer`, `createApp`) | Small, but each package still writes the checks, and the checks are the part that must not drift | Rejected |
| **C.** A conformance suite `testProviderKind(options)` with a wire-format adapter (`encode`, `encodeError`) | One call registers the checks of every kind; the adapter is the only provider-specific part; a check added to the kit reaches every package that updates `cap-jev` | **Selected** |

No concrete reason against C turned up. The cost is that the kit's checks become a contract that provider packages depend on, which is why the kit is experimental in 1.0.0 and why it checks behaviour of the documented API only (error codes, `status`, `providerCode`), never message texts.

## Decision

1. **Entry and registration.** `cap-jev/testing` exports `testProviderKind(options)`, which registers a `describe` named after the kind with `node:test`. The kit uses no other test framework and no runner of its own: a provider package puts one call into a `*.test.cjs` or `*.test.js` file and runs `node --test`. The module is `dist/testing.js` (`src/testing.ts`), listed in `exports` with its types. It does not load `@sap/cds` when it is required (only `node:` modules and the pure mock engine), and `cds-plugin.js` never requires it, so applications do not load it at runtime.

2. **Options.**

   | Option | Meaning |
   | --- | --- |
   | `kind` | The kind under test, such as `systemone-acme`. |
   | `packageDir` | The provider package (default `process.cwd()`). It is linked into the temporary app. When it is `cap-jev` itself, nothing is linked, and the built-in kinds are tested. |
   | `appDir` | An existing CAP app that has the provider package installed. The kit then creates no app and links nothing. |
   | `settings` | Further settings for the kind, such as `timeoutMs` or `limits`. They are applied over the kind's resolved settings. |
   | `credentials` | Further credentials, such as Cloudflare's `accountId` or Acme's `region`. The kit adds `credentials.url` (its local server) and, when the kind has `requiresToken`, a test token, unless the option gives them. |
   | `encode(response, request)` | Turns a Jev response into the provider's wire format. Default: identity, for a Jev-compatible server. Cloudflare: `{ success: true, errors: [], result: response }`. |
   | `encodeError({ code, status, message })` | Returns `{ status, body }`, the provider's error response for a machine-readable `code`. Default: `{ status, body: { error: { type: code } } }`. The `message` contains the test token, to check that it never reaches the raised error. |

3. **How the app is created.** The kit writes a temporary app: a `package.json` that depends on `cap-jev`, `@sap/cds` and the provider package (so that CAP's plugin discovery finds the package's `cds-plugin.js` and its `cds` section), and `node_modules` with three symlinks. `node_modules/cap-jev` points at the directory that `packageDir` resolves `cap-jev` to; if it resolves none, at the `cap-jev` the kit itself runs from. `node_modules/@sap/cds` points at the copy resolved from `packageDir`, falling back to the copy resolved from `cap-jev`. `node_modules/<package name>` points at `packageDir`. The kind is selected for the child process with the environment variable `cds_requires_systemone_kind`, which wins over every profile section, so a kind that the application would replace with the mock in `development` is still the one tested, and an `appDir` needs no change. The kit removes the app when the tests end.

4. **Exactly one `@sap/cds`.** The provider subclass and `cap-jev` both `require('@sap/cds')`, and CAP's event and class identity break with two copies. The symlinks point at real directories, and Node resolves the real path, so every `require('@sap/cds')` in the app, in `cap-jev` and in the provider package reaches the same copy as long as those resolve to one. The kit compares the real paths of the copy that `packageDir` resolves and of the copy that `cap-jev` resolves, and fails with a message naming both when they differ. The provider package must therefore have `cap-jev` and `@sap/cds` installed (as peer dependencies are in development); the kit does not install anything.

5. **Child processes, one local server in the test process.** CAP keeps global state (`cds.env`, `cds.services`, the loaded plugins) that cannot be unloaded, and the settings differ per check. The kit therefore starts **one child process per `testProviderKind` call** that loads CAP with `cds.plugins` and then answers line-delimited JSON commands from the test process: `info` (the kind's resolved `limits`, `requiresToken`, `modelId` and whether the kind exists) and `decide`/`connect` with the settings of one check. Each command creates a fresh service with `cds.connect.to('systemone', options)`; CAP does not cache a service created with options, so no check sees the state of another, and the full CAP wiring (kind chain, `impl` resolution, `init`) runs each time. The local HTTP server runs in the test process, so `encode` and `encodeError` are plain functions, and every check sees exactly the requests the kit's server received. A child process costs about a second; per check it would multiply that by twenty.

6. **What is checked.** Each check is its own `test`, named so that a failure says what broke.
   - The kind exists and its settings are accepted: connecting with the kit's settings works.
   - A `noul`, a `choice` and a `score` answer come back typed and with the values the server sent; several questions in one request come back under their ids. The server builds a valid answer from the request with the mock engine, so the checks do not depend on a fixed example.
   - The kind sends `modelId` as `model` when it has one.
   - Each limit in the kind's resolved `limits` (`questions`, `choiceOptions`, `scoreCriteria.min` and `max`) rejects a request one over (or one under) the limit with `INVALID_REQUEST` before anything reaches the server, and a request at the limit reaches it.
   - With `requiresToken`: a missing token fails with `INVALID_CONFIG` and sends nothing; the token goes out as `Authorization: Bearer <token>`.
   - An error response built by `encodeError` is `HTTP_ERROR` with its `status` and the `providerCode` of the sent code, and the token is not in the message.
   - A 503 is retried (the server sends `retry-after: 0`) and the retried request can succeed.
   - A body that is not JSON, and a decision that does not match the questions (wrapped by `encode`), are `INVALID_RESPONSE`.
   - A closed port is `NETWORK_ERROR`; a server that never answers, with a small `timeoutMs`, is `TIMEOUT`.
   - A check that does not apply to the kind (a limit it does not set, `requiresToken` or `modelId` it does not have) is reported as skipped with the reason, so the report shows what was not checked. A kind that is not defined in the app fails the whole block with a message that names the kind and the kinds that are defined.
   - The closed-port check keeps the kind's retries (`timeoutMs` 10 s, about one to two seconds in all); the timeout check uses `timeoutMs` 300. Both settings are the kit's, not the option's.

7. **What is not checked.** Whether the provider's real server accepts the request (that is the acceptance run against the real provider, which needs a token); the semantics of the answers; `destination` credentials and the Cloud SDK; streaming; `images`; the success envelope's error variants (Cloudflare's `success: false` is the provider package's own test, because `encode` has no way to express every provider's in-band error); `ABORTED` and caller signals (covered by `cap-jev`'s own tests of the shared transport); message texts; retries of statuses other than 503. A package with behaviour beyond the kit writes its own tests next to the kit call, with the same helpers (`node:test`, a local server).

8. **Status.** Experimental in 1.0.0, as [ADR 0006](0006-public-api-for-1.0.md) proposes. Adding checks is a minor release, because a stricter kit can fail a package that passed before; the changelog names new checks.

## Consequences

- A provider package gets the common checks with one call, a dependency on `cap-jev` and a few lines of adapter:

  ```js
  const { testProviderKind } = require('cap-jev/testing');
  testProviderKind({ kind: 'systemone-acme', credentials: { region: 'eu' }, encode: (response) => ({ data: response }) });
  ```

- `cap-jev`'s own tests run the kit against the built-in token kinds and Cloudflare (`tests/testing.test.cjs`), and `examples/provider-package` runs it for `systemone-acme`, so the kit is exercised by `npm test` on CAP 9 and CAP 10.
- A deliberately broken provider fails the kit with the name of the failing check and the expected and actual error codes (`tests/testing.test.cjs`).
- The kit adds `dist/testing.js` and `dist/testing.d.ts` to the package; nothing loads it unless a test file requires it. Its `@types/node` types (`node:test`) are only used at build time.
- The kit depends on Node's `node:test` (Node 22 and later, as the package) and on the protocol between the test process and the child, which is internal.
- Open: whether 1.0.0 should keep `encodeError`'s `message` field, and whether the kit should also offer an `acceptance` mode that runs the same requests against a real server with a real token (H10 of the plan).

## References

- [Plan](../plans/hardening-for-1.0.md), task H3
- [ADR 0001: Provider kinds as CAP service subclasses](0001-provider-kinds-as-cap-service-subclasses.md), [ADR 0006: The public API of 1.0.0](0006-public-api-for-1.0.md)
- [Adding a provider](../providers.md), [`examples/provider-package`](../../examples/provider-package)
- [Node.js test runner](https://nodejs.org/api/test.html)
