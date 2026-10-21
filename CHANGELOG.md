# Changelog

This changelog starts with 0.5.0. Earlier versions are described in the [GitHub releases](https://github.com/hendrik77/cap-jev/releases) up to v0.4.3.

## 0.7.1: No machine paths

### Breaking changes

None.

### Added

- `npm run release:check` fails when a tracked text file contains a path from a developer's machine: a home directory (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>`) or a temporary directory (`/private/tmp/`, `/private/var/`, `/var/folders/`). It names the file and line.
- `npm run release:check -- --archive <file.tgz>` extracts a packed archive and applies the same check to its files. The release workflow runs it after `npm pack`.

### Fixed

- No committed file or file in the release archive contained a machine path, so nothing had to be replaced. The checks keep it that way.

## 0.7.0: HTTP mock server and automated releases

### Breaking changes

None.

### Added

- An HTTP mock server, `startMockServer`, on `node:http`. It answers like a Jev server and gives the same answer as the in-process mock for the same request, fixtures and settings. It accepts and ignores `model`, and answers 404, 405, 413, 400, 401 and 500 (`mock_fixture_error`) as the guide describes. It imports no CAP code. It is experimental until the first npm publication.
- Failures simulated on the HTTP level, so the client's own transport produces the error code: a status code with the retry statuses 429, 502, 503, 504 and 529, a closed connection, no answer, an invalid body, and the provider error. `latencyMs` delays each answer.
- The `cap-jev-mock` command line (`npx cap-jev-mock`) with the options `--port`, `--host`, `--path`, `--fixtures`, `--strategy`, `--latency-ms`, `--fail`, `--status`, `--provider-code`, `--token` (or `CAP_JEV_MOCK_TOKEN`), `--format`, `--quiet`, `--help` and `--version`. The defaults match `systemone-laya`, so `npx cap-jev-mock` and `CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya npm start` work together. Invalid options exit with code 2, a failed listen with code 1. The server listens on the loopback address by default and warns on any other host.
- The `cap-jev/mock-server` export with `startMockServer` and the types `MockServerOptions` and `MockServer`.
- `--format cloudflare` (option `format`), which wraps answers and errors in the Cloudflare envelope, so `systemone-cloudflare` can be tried locally with `credentials.url`.
- An optional bearer token for the server, for kinds with `requiresToken`.
- `npm run release:check` (`scripts/release-check.cjs`), which checks that the version in `package.json` appears in `package-lock.json`, the example app's `cap-jev` range, the release archive URLs of both READMEs and the changelog headings, and with `--tag` that the tag is `v<version>`.
- `scripts/release-notes.cjs`, which prints the release title and extracts the changelog section as release notes.
- The release workflow `.github/workflows/release.yml`: pushing a tag `v<x.y.z>` runs CI on the tagged commit, then checks the release and creates the GitHub release with the archive and the changelog section as notes. Only the release job has write permission.
- Guide section "HTTP mock server" in `docs/local-development.md`: the command, the options, the request and failure tables, `systemone-laya`, `systemone-cloudflare`, fixtures and the programmatic API.
- Architecture decision records `docs/decisions/0003-http-mock-server.md` and `docs/decisions/0004-tag-triggered-releases.md`.

### Changed

- `MockService` uses a shared mock core (`src/providers/mock-core.ts`) for the settings checks, fixture loading and the decision order. Its behaviour is unchanged, and the core has no CAP imports.
- CI runs on pushes to branches and on pull requests, and as a reusable workflow, but no longer on pushes of tags. The release workflow calls it for the tagged commit.
- Changelog headings carry the release title, `## <x.y.z>: <title>`, which becomes the title of the GitHub release. The release steps in `AGENTS.md` add `npm run release:check` and let the tag push create the release.
- New tests cover the mock core, the mock server (the request and failure tables, the Cloudflare format, the token, latency and disconnects, the options, loading without `@sap/cds`), the server against temporary CAP apps in the production profile, the command line in child processes, the `MockServerOptions` types, the release scripts, and the installed `cap-jev-mock` command in `tests/cap-integration.test.cjs`.

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
