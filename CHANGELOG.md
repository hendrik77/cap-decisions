# Changelog

This changelog starts with 0.5.0. Earlier versions are described in the [GitHub releases](https://github.com/hendrik77/cap-jev/releases) up to v0.4.3.

## 0.5.0

### Breaking changes

`cap-jev` is not published and has no users yet, so there is no migration guide.

- **Kind names.** The kinds are `systemone-defaults`, `systemone-generic`, `systemone-typesafe`, `systemone-cloudflare` and `systemone-laya`. The `systemone` kind is removed; use `systemone-generic`. Applications select a kind by its full name. Short names such as `typesafe` resolve only through an undocumented CAP lookup and are not documented or tested.
- **`model` is now `modelId`.** CAP reads `model` as the CDS model of a service. Setting `model` fails the connection and logs an error that names `modelId`.
- **The `provider` setting is removed.** Request `limits` and `requiresToken` are now kind settings.
- **Exports.** `SystemOneTransport`, `DestinationResolver`, `ResolvedDestination`, `DecisionOptions` and `SystemOneProvider` are no longer exported. `DecideOptions` is added as the type of the options of `decide()`.

### Fixed

- `cds.connect.to('systemone')` failed with `MODEL_NOT_FOUND` for `systemone-typesafe` and `systemone-cloudflare`, because CAP read the `model` setting as a CDS model.
- After a network failure, a retry could start at the call deadline when the retry pause used up the remaining time. No attempt starts after the deadline now.
- Every provider kind resolved to the generic provider, because the service and the base kind were both named `systemone` and CAP merged the base kind over the selected one. Provider limits and settings now apply.

### Added

- Configurable request limits: `limits.questions`, `limits.choiceOptions` and `limits.scoreCriteria.min` and `.max` are kind settings that an application can override. A request that breaks a limit fails with `INVALID_REQUEST`.
- Settings validation. Misplaced secrets at service level, unknown `credentials` keys, a malformed `modelId`, `requiresToken`, `limits` or `timeoutMs`, and a missing token when `requiresToken` is set fail with `INVALID_CONFIG`. Unknown service-level keys log a warning.
- Subclass hooks on `SystemOneService`: `setup`, `call`, `endpoint`, `unwrap`, `errorCode`, and the static `settingsKeys` and `credentialKeys`. The hooks are experimental until the first npm publication.
- Support for `@sap/cds` 9 as well as 10 (peer range `>=9`). CI runs Node.js 22, 24 and 26 against CAP 9 and CAP 10.
- `cds-plugin.js` logs an error that names `modelId` when `model` is configured. It does not throw.
- The example app requires an authenticated user (`@requires: 'authenticated-user'`) and is tested with `cds.test`.
- A provider package example, `examples/provider-package`, and a test for an app-local subclass.
- Guide `docs/providers.md`: adding a provider.
- Architecture decision record `docs/decisions/0001-provider-kinds-as-cap-service-subclasses.md`.

### Changed

- Cloudflare is a subclass of `SystemOneService` (`cap-jev/providers/cloudflare`) instead of a provider check in the transport. Its request and response handling is unchanged.
- The HTTP transport is internal and contains no provider names.
- Tests use temporary CAP apps and `cds.test`; one test installs the packed package.
- The README describes the kinds, settings, error codes, stability and development workflow for 0.5.0. `AGENTS.md` describes the provider rule, decision records, plans and release steps.
