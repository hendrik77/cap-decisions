# 1. Provider kinds as CAP service subclasses

**Date:** 2026-10-21
**Status:** Accepted (0.5.0)

## Context

`cap-jev` connects SAP CAP applications to System One decision providers: TypeSafe, Cloudflare, Laya, and any Jev-compatible endpoint. More providers are expected.

Up to 0.4.3, the provider kinds do not work through CAP:

- `cds.connect.to('systemone')` fails with `MODEL_NOT_FOUND` for `systemone-typesafe` and `systemone-cloudflare`, because CAP reads `cds.requires.<service>.model` as the CDS model to load.
- Every provider kind resolves to `provider: "generic"`. The service and the base kind are both named `systemone`, and for a service whose name equals a kind name, CAP merges that kind over the selected kind (`@sap/cds/lib/env/cds-env.js:276-289`, CAP 10.1.1 and 9.9.3).

Provider behaviour is spread over about ten `provider === …` checks in the transport and the validation, against a fixed list of four providers.

The package has no users yet, so its configuration and API can change freely until the first npm publication.

CAP's own services follow one pattern: a base service class, and one kind per implementation whose `impl` names a subclass.

- Messaging: `local-messaging` uses `MessagingService`; `file-based-messaging` and `redis-messaging` are subclasses of it, all inside `@sap/cds`.
- `@cap-js/audit-logging` has one kind per target (console in development, REST in production) and exports its base class for extension. `@cap-js/attachments` has one kind per storage backend.
- Database kinds point to separate packages (`sqlite` → `@cap-js/sqlite`, `hana` → `@cap-js/hana`) because they bring native drivers.
- No CAP kind is named after its service: there is no `db`, `messaging` or `auth` kind.

Community plugins show the same split. `cds-caching` (Mike Zaschka) is one package with many storage backends selected by configuration, each backend library an optional peer dependency. `cds-data` splits packages by capability, not by adapter, and keeps its adapters inside the engine package.

## Options considered

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** Mark the base kind `$root: true` and keep the name `systemone` | Works on CAP 9.9.3 and 10.1.1, but `$root` is undocumented, absent from CAP's changelog and unused by CAP's own kinds | Rejected |
| **B.** Rename the service instead of the kind | Changes `cds.connect.to('systemone')` in every application for no benefit over renaming the kind | Rejected |
| **C.** A `provider` setting with a provider registry and `registerProvider()` | A second plugin mechanism next to CAP's `impl`; third-party providers would have to register with the same `cap-jev` instance | Rejected |
| **D.** Separate packages per provider now (core plus `cap-jev-provider-*`), in separate repositories or one workspace | No current provider needs it; each package adds a release, CI and a peer dependency, and users install two packages. The provider code is the same in either layout | Deferred: possible later without changing the design |
| **E.** Providers defined only by configuration | Cannot express protocol differences such as Cloudflare's envelope or a mock | Kept for the simple cases only |
| **F.** Kinds with provider data, plus `impl` subclasses for behaviour, in one package | Follows CAP's own pattern; no provider names in shared code | **Selected** |

## Decision

1. **Kind names.** The base kinds are `systemone-defaults` (shared `impl` and `timeoutMs`) and `systemone-generic`. Every provider kind is `systemone-<provider>`. No kind shares the service's name. Applications use the full names, the documented `kind` chaining; the short names that CAP happens to resolve (`kind: "typesafe"`) and `"systemone": true` are neither documented nor tested.
2. **`modelId`.** The model setting is `modelId`. The transport still sends it as `model`, as the Jev protocol requires. `cds-plugin.js` logs an error that names `modelId` when `model` is set; it does not throw, because it runs for every `cds` command.
3. **Data in kinds, behaviour in `impl`.**
   - Provider facts are kind settings: `modelId`, `requiresToken`, `limits` (`questions`, `choiceOptions`, `scoreCriteria`) and the default `credentials.url`.
   - Provider behaviour lives in subclasses of `SystemOneService`, selected through each kind's `impl`. The base class owns settings validation, request and response validation, the `decide` event and logging. Subclasses override `setup`, `call`, `endpoint`, `unwrap` or `errorCode`.
   - Cloudflare is the only built-in subclass in 0.5.0.
4. **One package.** All current providers ship in `cap-jev`. Extension works through kinds and subclasses, documented with an app-local example and a provider package example, both tested in CI.
5. **Internal transport.** `SystemOneTransport` is no longer exported. The public extension point is the service class.
6. **Separate packages only when needed.** A provider moves into its own package when another party maintains it, when it needs its own release cycle, or when it is a different capability. A provider that only needs a vendor SDK stays in `cap-jev` with the SDK as an optional peer dependency, as `@sap-cloud-sdk/connectivity` already is.
7. **Settings checks.** Misplaced secrets (`token`, `url`, `accountId`, `destination` at service level), unknown `credentials` keys and `model` fail with `INVALID_CONFIG`. Unknown service-level keys only produce a warning, because CAP adds keys of its own.

## Consequences

- The shared code contains no provider names. Adding a provider is a kind entry, plus a subclass only when its protocol differs.
- The configuration and public API change in 0.5.0: new kind names, `modelId`, no `provider`, no exported transport. This is acceptable because nobody uses the package yet.
- The subclass hooks become a public contract with the first npm publication. Until then they are documented as experimental.
- A provider package must use the application's single `cap-jev` and `@sap/cds` copies (peer dependencies), or `instanceof` and CAP events break.
- A real local model (model hosting with its own runtime, weights and release cycle) would be a separate project; `cap-jev` only needs a kind pointing at it.

### Not applicable

- **Configuration schema.** CAP's schema contribution points are `buildTaskType`, `databaseType` and new top-level `cds` keys (capire `node.js/cds-plugins`). There is none for `cds.requires.<service>`, and a service's settings belong there. `SystemOneSettings` is the typed reference instead.
- **`cds.queued` and `outboxed`.** CAP queues outgoing messages until the transaction commits. A decision is a synchronous call whose result the caller needs, so it is not queued.

## References

- [PLAN.md](../../PLAN.md), tasks T0–T8
- capire: [CDS Plugin Packages](https://cap.cloud.sap/docs/node.js/cds-plugins), [cds.env](https://cap.cloud.sap/docs/node.js/cds-env)
- [`@cap-js/audit-logging`](https://github.com/cap-js/audit-logging), [`@cap-js/attachments`](https://github.com/cap-js/attachments), [`cap-js/cds-dbs`](https://github.com/cap-js/cds-dbs)
- [`cds-caching`](https://github.com/mikezaschka/cds-caching), [`cds-data` ADR 0003](https://github.com/mikezaschka/cds-data/blob/main/spec/internal/decisions/0003-split-plugin-into-replication-and-federation.md)
