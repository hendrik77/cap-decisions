# Changelog

This changelog starts with 0.5.0. Earlier versions are described in the [GitHub releases](https://github.com/hendrik77/cap-jev/releases) up to v0.4.3.

## 0.6.0: Local-first mock provider

### Breaking changes

None for applications that set an explicit `kind`: they are unaffected, because an explicit kind always wins over the mock. See "Changed" for applications that set no `kind`.

### Added

- A `systemone-mock` kind (`cap-jev/providers/mock`) that answers in-process, without a server, a token or network access. The plugin selects it by default in the `development` and `test` profiles, so `cds watch`, `cds serve` and `cds.test` work out of the box. Production keeps `systemone-generic`.
- Deterministic answers: the seed is a hash of the state and the question ID. The `strategy` setting is `keywords` (default; word overlap between the state and each choice label and its criteria text) or `seeded`.
- Fixtures: ordered rules in `test/data/systemone.json`, or in the file named by `fixtures`, that give fixed answers or simulated failures for matching input.
- Simulated latency and failures: the `latencyMs` and `fail` settings. `latencyMs` honours `timeoutMs` (`TIMEOUT`) and the caller's `signal` (`ABORTED`).
- Production refusal: the mock fails with `INVALID_CONFIG` in the `production` profile unless `allowInProduction` is `true`.
- A startup warning from the mock that says answers are simulated and that a `kind` selects a real endpoint in development.
- The `MockSettings` type.
- Guide `docs/local-development.md`: the mock, fixtures, simulated failures, the activation table, and when to use Laya or a real provider.
- Architecture decision record `docs/decisions/0002-in-process-mock-provider.md`.

### Changed

- An application that sets no `kind` gets the mock in `development` and `test` instead of `systemone-generic`. Production is unchanged. An application that sets only `credentials.url` without a `kind` also gets the mock in development; set a `kind` to use a real endpoint there.
- A network failure whose retry delay does not fit into the remaining call deadline now fails at once with `NETWORK_ERROR` and its cause, as HTTP failures already did, instead of waiting until the deadline and failing with `TIMEOUT`. No request starts at the deadline any more.
- The example app uses the mock in development and `systemone-laya` in production.
- The example app's tests run without a fake server and cover the mock, a fixture rule and a simulated failure.
- The integration test runs its server calls in the production profile, and adds one call in development on the mock.
- Each transport test uses its own URL path, so a late request from an earlier test cannot reach it.

## 0.5.1: Install instructions for npm 12

### Fixed

- The install instructions failed with npm 12, which refuses tarball URLs by default (`allow-remote`). The README now shows two ways that work: allowing URLs listed in `package.json` through the project's `.npmrc`, or downloading the archive and installing the file.
- The example app's README told readers to install the release archive inside the repository, where the app is an npm workspace that uses the local `cap-jev`. It now describes the workspace setup and the release archive for copies outside the repository.

## 0.5.0: Provider kinds as CAP service subclasses

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
