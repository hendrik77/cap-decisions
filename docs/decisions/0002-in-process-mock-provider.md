# 2. In-process mock provider

**Date:** 2026-10-21
**Status:** Accepted (0.6.0)

## Context

CAP's local-first approach (DJ Adams, "Local-first dev with CAP Node.js", May 2026) runs everything locally without setup: in-memory SQLite with CSV data, mocked authentication, in-process remote-service mocks, and file-based or local messaging. Each mock implements the same interface as the real service, is selected by configuration and is never used in production. SAP's own plugins do the same: `@cap-js/audit-logging` logs to the console in development, and `@cap-js/attachments` uses a mock malware scanner in development.

`cds watch --with-mocks` does not mock `systemone`, because it is a custom kind, not a modelled remote service. Up to 0.5.x, local development needs a Laya server or a provider token.

[ADR 0001](0001-provider-kinds-as-cap-service-subclasses.md) makes each provider a kind with an `impl` subclass of `SystemOneService`, which a mock can use without network access.

On CAP 10.1.1 and 9.9.3, a plugin-level `"[development]"` default for `systemone` never overrides a `kind` that the application sets explicitly.

## Options considered

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** An HTTP mock server only | A second process for every developer; slower and harder to control in tests | Deferred: useful later for the HTTP path and non-CAP clients |
| **B.** Random answers | Unstable tests and snapshots | Rejected |
| **C.** Require Laya or a provider token for local work | Setup, network access and secrets before the first run | Rejected |
| **D.** An in-process `systemone-mock` kind, opt-in per application | Works, but every application has to configure it | Rejected in favour of E |
| **E.** An in-process `systemone-mock` kind as the plugin's development and test default | Zero setup; an explicit application kind always wins; production never resolves to the mock | **Selected** |

## Decision

1. **A `systemone-mock` kind** whose subclass (`MockService`) overrides only `setup()` and `call()`. Settings validation, request and response validation, `before`/`after` handlers and logging stay the same as for real providers, so mock answers always match the protocol.
2. **Deterministic answers.** A seed from a hash of the state and the question ID makes every answer reproducible. A keyword strategy picks the choice whose label and criteria text best match the state, for realistic demos; a `seeded` strategy uses the seed alone.
3. **Fixtures** in `test/data/systemone.json`, CAP's location for development and test data, or the file named by `fixtures`: ordered rules with fixed answers or simulated failures.
4. **Simulated latency and failures** (`latencyMs`, `fail`), honouring `timeoutMs` and the caller's signal.
5. **Default activation.** The plugin's `package.json` selects `systemone-mock` in the `development` and `test` profiles. Production keeps `systemone-generic`, which fails on connect without a URL.
6. **Production safety.** The mock refuses the `production` profile unless `allowInProduction: true` is set.

## Consequences

- `npm start` in the example works without any server, token or network, and application tests can cover their error handling through simulated failures.
- An application that sets only `credentials.url` without a `kind` gets the mock in development. The documentation and the mock's startup warning say: set a `kind` to use a real endpoint in development.
- The mock is the first subclass that does not use HTTP, which tests the hook design from ADR 0001 before the hooks become stable.

## References

- [Plan](../plans/completed/provider-kinds-and-mock.md), tasks M1–M5
- [Local-first dev with CAP Node.js](https://qmacro.org/blog/posts/2026/05/11/local-first-dev-with-cap-node-js/) and its posts on mocking data, auth, remote services and messaging
- capire: [Testing with cds.test](https://cap.cloud.sap/docs/node.js/cds-test), [cds.env profiles](https://cap.cloud.sap/docs/node.js/cds-env#profiles)
