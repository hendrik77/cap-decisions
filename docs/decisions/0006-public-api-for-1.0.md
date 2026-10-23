# 6. The public API of 1.0.0

**Date:** 2026-10-22
**Status:** Proposed

## Context

From 1.0.0, `cap-jev` follows semantic versioning. Today the README's stability table marks areas as stable or experimental (see [Stability](../../README.md#stability)). That leaves open which names are covered, what counts as a breaking change, and which CAP and Node versions a release supports. Until 1.0.0 nothing is published on npm and there are no users, so the surface can still change without migration.

The inventory below is taken from the code on 2026-10-22 (`release-0.9.0`, after v0.8.0), not from the documentation.

### Inventory

| Area | Names | Where |
| --- | --- | --- |
| Main entry `cap-jev` | `SystemOneService` (also the default export), `DecideOptions`, `SystemOneError`, and the types `SystemOneErrorCode`, `JsonValue`, `Content`, `NoulQuestion`, `ChoiceQuestion`, `ScoreQuestion`, `Question`, `Questions`, `NoulAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `Answer`, `Answers`, `DecisionRequest`, `DecisionResult`, `ProviderLimits`, `SystemOneCredentials`, `SystemOneSettings`, `MockSettings` | `src/index.ts`, `src/types.ts`, `src/validation.ts` |
| Service API | `cds.connect.to('systemone')`, `decide(request, { signal })`, the `decide` event | `src/index.ts` |
| Errors | `SystemOneError` with `code`, `status`, `providerCode`, `cause`; the codes `INVALID_CONFIG`, `INVALID_REQUEST`, `INVALID_RESPONSE`, `HTTP_ERROR`, `PROVIDER_ERROR`, `NETWORK_ERROR`, `TIMEOUT`, `ABORTED` | `src/validation.ts` |
| Subclass hooks | `setup(settings)`, `call(request, options)`, `endpoint(credentials)`, `unwrap(payload)`, `errorCode(payload)`; `static settingsKeys`, `static credentialKeys`; the protected fields `settings` and `transport` | `src/index.ts` |
| Provider entries | `cap-jev/providers/cloudflare` (`CloudflareService`, also default), `cap-jev/providers/mock` (`MockService`, also default), from 0.9.0 `cap-jev/providers/subq` (`SubqService`, also default) | `src/providers/` |
| Kinds and settings | `systemone-defaults` (parent, not selectable), `systemone-generic`, `systemone-mock`, `systemone-typesafe`, `systemone-cloudflare`, `systemone-laya`, and from 0.9.0 `systemone-subq`; service-level `kind`, `impl`, `modelId`, `timeoutMs`, `requiresToken`, `limits` (`questions`, `choiceOptions`, `scoreCriteria.min`/`max`); `credentials.url`, `token`, `accountId`, `destination`; the mock's `fixtures`, `strategy`, `latencyMs`, `fail`, `allowInProduction` | `package.json` (`cds`), `src/validation.ts`, `src/providers/mock.ts` |
| Profile defaults | `systemone-mock` in `development` and `test`, `systemone-generic` in production | `package.json` (`cds`) |
| Fixtures | The file format and the default path `test/data/systemone.json` | `src/providers/mock-fixtures.ts`, `src/providers/mock-core.ts` |
| HTTP mock server | `cap-jev/mock-server`: `startMockServer(options)`, `MockServerOptions` (`port`, `host`, `path`, `fixtures` or `rules`, `root`, `strategy`, `latencyMs`, `fail`, `token`, `format`, `log`), `MockServer` (`url`, `port`, `host`, `close()`) | `src/mock-server.ts` |
| `cap-jev-mock` | The options of `--help`, the environment variable `CAP_JEV_MOCK_TOKEN`, the line `cap-jev mock server listening on <url>`, the request log lines, the exit codes 0, 1 (cannot listen, unexpected error) and 2 (usage or configuration error) | `src/mock-server-cli.ts` |
| `cds add systemone` | `--kind`, `--with-fixtures`, CAP's `--for` and `--force`; the files `package.json`, `.cdsrc-private.json`, `.gitignore`, `test/data/systemone.json` and the keys it writes; the message prefix `[systemone]` and the message texts | `src/add.ts`, `src/add-core.ts`, `cds-plugin.js` |
| Test kit | From 0.9.0 `cap-jev/testing`: `testProviderKind(options)`, `ProviderKindTestOptions`, `WireError`, `WireErrorInput`; the checks it registers ([ADR 0007](0007-provider-test-kit.md)) | `src/testing.ts` |
| Logging | The log channel `systemone`; the debug record `decision completed` with `latencyMs`, `attempts`, `model`, `usage` | `src/index.ts` |
| Package | `exports` (`.`, `./providers/cloudflare`, `./providers/mock`, from 0.9.0 `./providers/subq` and `./testing`, `./mock-server`, `./package.json`, `./cds-plugin`, `./cds-plugin.js`), `bin`, `engines` (`node >=22`), `peerDependencies` (`@sap/cds`, `@sap-cloud-sdk/connectivity`) | `package.json` |
| Not exported | `SystemOneTransport`, the validation functions, `machineCode`, `CAP_SETTINGS_KEYS`, `mock-core`, `mock-engine`, `mock-fixtures`, `add`, `add-core`, `mock-server-cli` as modules | `dist/` |

## Options considered

### Status levels

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** Everything exported is stable | Simple, but freezes hooks and tools that no external code has used yet | Rejected |
| **B.** Three levels: **stable** (semantic versioning applies), **experimental** (may change in a minor release; marked in the README and the JSDoc), **internal** (not documented as API, may change in any release) | Each name gets the level its use justifies | **Selected** |

### The subclass hooks

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** All hooks stable | Provider packages can rely on them; `setup` and `call` expose the protected `transport`, whose type is internal | Rejected |
| **B.** All hooks experimental until a second provider package uses them | Safe for `cap-jev`, but a provider package cannot pin anything, and the test kit of 0.9.0 would test an experimental contract | Rejected |
| **C.** `endpoint`, `unwrap`, `errorCode`, `settingsKeys` and `credentialKeys` stable; `setup` and `call` experimental; the protected fields `settings` and `transport` internal | The narrow hooks are used by `CloudflareService`, `examples/provider-package` and, from 0.9.0, possibly SubQ; the wide ones stay free to change with the transport | **Recommended** |

### What counts as breaking

| Change | Recommended release |
| --- | --- |
| Removing or renaming an export, a kind, a setting, a credential key, a mock-server option or a `cap-jev-mock` or `cds add` option; making an optional setting required; narrowing accepted input or widening a returned type | Major |
| Changing the profile defaults (`systemone-mock` in development and test, `systemone-generic` in production) | Major |
| Changing an exit code of `cap-jev-mock`, the `listening on <url>` line, the fixture format or its default path, or the files and keys `cds add systemone` writes | Major |
| A new error code. `SystemOneErrorCode` may grow; code that switches over it needs a default branch, which the README states | Minor |
| A new kind, setting, option or export | Minor |
| A changed fact of a provider's kind (URL, `modelId`, `limits`) because the provider changed it | Minor, with a changelog entry; keeping the old value would break against the provider anyway |
| Message texts: error messages, warnings, `cds add` messages, `cap-jev-mock` log lines other than `listening on`, the debug record | Any release; they are for people, not for parsing (`code`, `status` and `providerCode` are for code) |

### The CAP support policy

The maintainer decided on 2026-10-21: `cap-jev` supports **the last two stable CAP major versions**, today CAP 9 and CAP 10. The peer range names exactly these majors (`^9 || ^10`) and CI tests exactly these; `npm run release:check` fails if they differ. When CAP 11 is released, one release adds CAP 11 and drops CAP 9. Open is how that release is numbered after 1.0.0:

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** A major release of `cap-jev` | What semantic versioning and npm's resolver expect: `^1` never stops working on an installed CAP version. CAP majors come about once a year, so `cap-jev` majors would too | **Recommended** |
| **B.** A minor release, because the policy is announced | Fewer majors, but an application on CAP 9 that updates within `^1` gets an unsatisfied peer warning | Rejected |

Adding a new CAP major without dropping one (if CAP 11 came out while only CAP 10 were supported) is a minor release.

### The Node range

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** Keep `>=22` without a rule | A Node line that reached its end of life stays in the range untested | Rejected |
| **B.** The Node lines that are not at their end of life and that both supported CAP majors support; CI tests each of them. Dropping a line is a major release, combined with a CAP change when the dates are close | Matches the CAP rule and semantic versioning | **Recommended** |

Node 22 reaches its end of life in April 2027; under B, `cap-jev` 2.0.0 drops it, together with CAP 9 if CAP 11 is out by then.

### Tools and new parts

| Part | Recommended status in 1.0.0 | Reason |
| --- | --- | --- |
| The HTTP mock server (`cap-jev/mock-server`) and `cap-jev-mock`: options, `MockServer`, exit codes, `listening on`, the fixture format | Stable | Tests and scripts of applications depend on them; they were added in 0.7.0 and have not changed incompatibly since |
| `cds add systemone`: options and the files and keys it writes | Stable | Its result is configuration that applications commit |
| `cap-jev/testing` (0.9.0) | Experimental | New in 0.9.0, without an external provider package using it yet |
| `systemone-subq` and `cap-jev/providers/subq` (0.9.0) | Experimental | Its model `subq-snap-preview` is in public preview; its name and limits may change |
| The log channel `systemone` | Stable | Applications configure it (`cds.log.levels`) |
| `./cds-plugin` and `./cds-plugin.js` in `exports` | Internal | They exist for CAP's plugin discovery, not for `require` by applications |

## Decision

To be completed when the maintainer has reviewed the recommendations above. Until then the status is **Proposed**; 1.0.0 accepts it.

1. Three levels, stable, experimental and internal, as in option B of the status levels.
2. The CAP support policy as decided: the last two stable CAP majors, enforced by `npm run release:check`.
3. Pending review: the hooks (recommended C), what counts as breaking (the table above), the release number of a CAP drop (recommended A), the Node range (recommended B), and the status of the tools and new parts (the table above).
4. The SubQ error body `{ "detail": { "error_type", "message" } }` is read by a subclass, `cap-jev/providers/subq` (`SubqService`), whose only hook is `errorCode`. A probe in 0.9.0 (task H2) showed that the shared transport gives `HTTP_ERROR` with the status but without `providerCode` for this body. No other built-in provider is known to use the shape, so the shared transport stays without provider shapes. If the acceptance runs (H10) find the shape at another provider, the transport reads it instead and the subclass is removed before 1.0.0. The entry `cap-jev/providers/subq` is experimental, like the kind.

## Consequences

- The README's stability table is rewritten from this ADR when it is accepted, with one row per area and level; JSDoc marks experimental names with `@experimental`.
- `SystemOneErrorCode` is documented as a union that may grow.
- Each CAP major release of SAP leads to a `cap-jev` release that adds it, and, after 1.0.0, to a major release when the oldest CAP major is dropped.
- Provider packages can rely on `endpoint`, `unwrap`, `errorCode`, `settingsKeys` and `credentialKeys`; a provider that needs `setup` or `call` accepts that they may change in a minor release.

## References

- [Plan](../plans/hardening-for-1.0.md), task H1
- [ADR 0001: Provider kinds as CAP service subclasses](0001-provider-kinds-as-cap-service-subclasses.md), [ADR 0003: HTTP mock server](0003-http-mock-server.md), [ADR 0005: `cds add systemone` facet](0005-cds-add-facet.md)
- [Semantic Versioning 2.0.0](https://semver.org/), [Node.js release schedule](https://github.com/nodejs/release#release-schedule)
