# Plan: provider kinds (0.5.0) and local-first mock (0.6.0)

Written on 2026-10-20 and revised on 2026-10-21 against `main` at v0.4.3 (`bbb5a19`). The revision adopts the review of the CAP plugin report (`cap-plugin-report.md`, 20.10.2026) and the learnings from Mike Zaschka's plugins.

`cap-jev` has no users yet: it is development-only and unpublished on npm. Configuration and API changes need no migration code, deprecation period or compatibility shims.

The reasoning lives in two draft ADRs:

- [ADR 0001: Provider kinds as CAP service subclasses](../../decisions/0001-provider-kinds-as-cap-service-subclasses.md), accepted when 0.5.0 is merged.
- [ADR 0002: In-process mock provider](../../decisions/0002-in-process-mock-provider.md), accepted when 0.6.0 is merged.

Completed with 0.6.0; this file was moved here from `PLAN.md` in the repository root.

## Contents

- [Starting point](#starting-point)
- [How the work is done](#how-the-work-is-done)
- [0.5.0: provider kinds as CAP service subclasses](#050-provider-kinds-as-cap-service-subclasses)
- [0.6.0: local-first mock provider](#060-local-first-mock-provider)
- [Later](#later)
- [Findings and where they are handled](#findings-and-where-they-are-handled)
- [Blocked tests](#blocked-tests)

## Starting point

Two defects make the provider kinds unusable through CAP. Both were reproduced on CAP 10.1.1 and 9.9.3 with the v0.4.2 package installed in a copy of `examples/cap-app`. Neither is covered by the current tests.

| App configuration | Result |
| --- | --- |
| `"systemone": { "kind": "systemone-typesafe" }` | `cds.connect.to('systemone')` fails with `MODEL_NOT_FOUND: Couldn't find a CDS model for 'jev-latest'` |
| `"systemone": { "kind": "systemone-cloudflare" }` | Fails the same way for `'clef'` |
| `"systemone": { "kind": "systemone-laya" }` | Connects, but as `provider: generic`: Laya limits are not applied |

1. **`model` clashes with CAP.** CAP reads `cds.requires.<service>.model` as the CDS model to load for that service.
2. **The service and the base kind share the name `systemone`.** For a service whose name equals a kind name, CAP merges that kind over the selected kind (`@sap/cds/lib/env/cds-env.js:276-289`). Every provider kind is overridden with `provider: "generic"`.

`tests/kinds.test.cjs` inspects `cds.env.requires.kinds` and constructs `SystemOneTransport` directly; nothing connects through CAP with a kind selected by an application. Provider behaviour is spread over about ten `provider === …` checks in `src/transport.ts` and `src/validation.ts`.

Verified facts this plan relies on (CAP 10.1.1 and 9.9.3 behave identically):

- A kind's own `impl` replaces the inherited one; an application can set `impl` to a file of its own.
- After renaming the base kinds, provider settings resolve correctly in all profiles.
- A plugin-level `"[development]"` default for `systemone` never overrides a `kind` the application sets explicitly.
- npm workspaces that include the package root (`"."`) let `examples/cap-app` resolve the local `cap-jev`, with one `@sap/cds` copy.
- `@cap-js/cds-test` 1.0.2 requires `@sap/cds >=9.8` and supports Node's test runner. `@cap-js/cds-types` 0.20 supports `@sap/cds >=9`.

## How the work is done

**Branches and releases.** Each version is developed on `release-<version>`. When its quality is good (all checks green locally and in CI, docs updated), it goes through a pull request with a merge commit into `main`; the merge commit is tagged `v<version>` and released on GitHub with the `npm pack` archive. Fixes found after a release go into `0.5.1`, `0.5.2` and so on, the same way, before 0.6.0 starts.

**Changelog.** `CHANGELOG.md` restarts with 0.5.0. Earlier versions are described in the GitHub releases up to v0.4.3.

**Red, then green.** For every task with behaviour:

1. Write the tests first and run them: they must fail for the expected reason (not a syntax or import error).
2. Write the code until the tests pass.
3. Run the whole suite (`npm run lint`, `npm run typecheck`, `npm test`).

**Five attempts.** A test that still fails after five fix attempts is marked with `{ todo: 'BLOCKED: <reason>' }` (Node test runner) and listed under [Blocked tests](#blocked-tests); work continues. Blocked tests are resolved before the version is released, or the release notes name them.

**Subagents.** Well-defined development tasks (marked *agent*) go to a subagent. Tasks run one at a time on the release branch, because they share `src/` and `dist/`. The main session reviews each result, runs the full suite and commits. Tasks marked *main* are done directly.

**Definition of done for a version** (from the report, section 11.13, adapted):

- `cds-plugin.js` only registers or logs; it never throws.
- Defaults, kinds and profiles are in the `cds` section of `package.json`.
- No imports from `@sap/cds/lib/...`, no patching of CAP classes, no `console`.
- `@sap/cds` is an open-range peer (`>=9`); other runtime packages are optional peers.
- Tests use the workspace apps or temporary apps that resolve the local package; CI covers Node 22/24/26 × CAP 9/10.
- `files`, README, CHANGELOG and LICENSE are consistent; `npm pack --dry-run` contains no tests or examples.

## 0.5.0: provider kinds as CAP service subclasses

### Target configuration

The plugin's `package.json`:

```json
{
  "cds": {
    "requires": {
      "systemone": { "kind": "systemone-generic" },
      "kinds": {
        "systemone-defaults": { "impl": "cap-jev", "timeoutMs": 10000 },
        "systemone-generic": { "kind": "systemone-defaults" },
        "systemone-typesafe": {
          "kind": "systemone-defaults",
          "modelId": "jev-latest",
          "requiresToken": true,
          "limits": { "choiceOptions": 255, "scoreCriteria": { "min": 2, "max": 10 } },
          "credentials": { "url": "https://api.typesafe.ai/v1/systemone" }
        },
        "systemone-cloudflare": {
          "kind": "systemone-defaults",
          "impl": "cap-jev/providers/cloudflare",
          "modelId": "clef",
          "requiresToken": true,
          "limits": { "questions": 64 }
        },
        "systemone-laya": {
          "kind": "systemone-defaults",
          "limits": { "choiceOptions": 100 },
          "credentials": { "url": "http://127.0.0.1:8000/v1/systemone" }
        }
      }
    }
  }
}
```

Applications select a kind by its full name, the documented `kind` chaining (capire `node.js/cds-env`, "Prototype-Chained Along .kind References"):

```json
{ "cds": { "requires": { "systemone": { "kind": "systemone-typesafe", "[development]": { "kind": "systemone-laya" } } } } }
```

Short names (`kind: "typesafe"`) and `"systemone": true` happen to resolve through an undocumented CAP lookup. They are neither documented nor tested.

Rule: **data in kinds, behaviour in `impl`.** Endpoints, model IDs, token requirements and limits are kind settings. Only providers whose protocol differs get a subclass.

### Target code structure

```text
src/
  index.ts              SystemOneService (base class, hooks), public exports
  transport.ts          internal: HTTP, retries, deadline, cancellation, destinations
  validation.ts         settings, request and response validation
  types.ts
  providers/
    cloudflare.ts       CloudflareService extends SystemOneService
```

```ts
export class SystemOneService extends cds.Service {
  // init(): validateSettings → setup(settings) → register the decide handler
  // decide handler: validateRequest(data, limits) → call() → validateResult() → debug log
  protected setup(settings: SystemOneSettings): Promise<void>;                 // default: create transport, check destination
  protected call(request: DecisionRequest, options: DecideOptions): Promise<{ result: unknown; attempts: number }>; // default: HTTP
  protected endpoint(credentials: SystemOneCredentials): string | undefined;   // default: credentials.url
  protected unwrap(payload: unknown): unknown;                                 // default: payload
  protected errorCode(payload: unknown): string | number | undefined;          // default: error.type
}
```

Public exports: `SystemOneService` (named and default), `SystemOneError`, and the types `SystemOneErrorCode`, `SystemOneSettings`, `SystemOneCredentials`, `ProviderLimits`, `DecideOptions`, the question, answer, request and result types. `SystemOneTransport`, `DestinationResolver`, `ResolvedDestination`, `DecisionOptions` and `SystemOneProvider` are no longer exported. Tests import the transport from `dist/transport`.

### Tasks

#### T0 Plan, ADRs, changelog (*main*)

- Update this plan, draft ADR 0001 and ADR 0002 in `docs/decisions/`, restart `CHANGELOG.md` with an unreleased 0.5.0 section.
- Done when: committed on `release-0.5.0`.

#### T1 Workspaces, CAP 9 range, test helper, CI matrix (*agent*)

No new behaviour; the suite stays green.

1. `package.json`: version `0.5.0`; `peerDependencies["@sap/cds"]` `>=9`; `workspaces: [".", "examples/cap-app"]`; devDependency `@cap-js/cds-test` `^1.0.2`.
2. `examples/cap-app/package.json`: `@sap/cds` `>=9`, `cap-jev` `^0.5.0`.
3. `tests/helpers/app.cjs`: `createApp(packageJson, files?)` creates a temporary CAP app whose `node_modules/cap-jev` and `node_modules/@sap/cds` are symlinks to the repository root and its `@sap/cds`, and `runInApp(dir, script, { env })` runs a script there in a child process with a timeout and returns its parsed JSON output. Temporary apps are removed after each test.
4. `tests/cap-integration.test.cjs`: copy `examples/cap-app` without `node_modules`; it remains the only test that installs the packed tarball.
5. `.github/workflows/ci.yml`: matrix Node 22/24/26 × CAP 9/10. For CAP 9, run `npm install --no-save @sap/cds@^9` after `npm ci`. Run typecheck only for CAP 10. Set `CDS_TEST_ENV_CHECK: y`.
6. Done when: `npm ci`, lint, typecheck, `npm test` and `npm pack --dry-run` pass on CAP 10, and `npm test` passes after installing CAP 9 locally.

#### T2 Settings and request validation (*agent*, red-green)

Files: `src/types.ts`, `src/validation.ts`, new `tests/validation.test.cjs`, `tests/types.test.ts`.

1. Types: `ProviderLimits { questions?; choiceOptions?; scoreCriteria?: { min?; max? } }`; `SystemOneSettings { modelId?; timeoutMs?; requiresToken?; limits?; credentials? }`; remove `SystemOneProvider` and `provider`.
2. `validateRequest(input, limits = {})`: the existing structural checks, plus the limits. Protocol minimums stay built in (one question, one choice option, one score criterion).
3. `validateSettings(settings): string[]`:
   - `INVALID_CONFIG` for: `model` (message names `modelId`); secrets at service level (`token`, `url`, `accountId`, `destination`); unknown keys under `credentials` (allowlist `url`, `token`, `accountId`, `destination`); non-string `modelId`; non-boolean `requiresToken`; malformed `limits`; invalid `timeoutMs` (positive integer up to 2,147,483,647).
   - Returns warnings for unknown service-level keys. Known keys: `kind`, `impl`, `modelId`, `timeoutMs`, `requiresToken`, `limits`, `credentials`, plus any key CAP adds itself (record them from a real `cds.connect.to` in a test). Subclasses can extend the list through a static `settingsKeys` array.
4. Until T3, the transport maps its old `provider` setting to limits so the suite stays green.
5. Tests first (`tests/validation.test.cjs`):
   - Limits: TypeSafe-like limits accept 255 choice options and reject 256, accept score criteria 2 and 10 and reject 1 and 11; `choiceOptions: 100` accepts 100 and rejects 101; `questions: 64` accepts 64 and rejects 65; no limits applies only the protocol minimums.
   - Each `INVALID_CONFIG` case above; warnings for an unknown key; no warning for the known keys.
   - Types: `SystemOneSettings` accepts `modelId`, `requiresToken`, `limits` and rejects `provider` and `model` (`@ts-expect-error`).

#### T3 Base service, internal transport, Cloudflare subclass, kinds (*agent*, red-green)

Files: `src/index.ts`, `src/transport.ts`, new `src/providers/cloudflare.ts`, `package.json` (kinds, `exports["./providers/cloudflare"]`), tests.

1. Transport: `new SystemOneTransport(settings, { hooks, destinationResolver })`; `post(request, { signal }) → { payload, attempts }`. Keeps HTTP, retries, `Retry-After`, the call deadline, cancellation, destinations, the token transport rule, `requiresToken` (a token, or a destination with `Authorization`), and sends `modelId` as `model`. Contains no provider names and no request or response validation. Remove the 0.3.0 legacy guards.
2. Base service as in the target code structure. `init()` runs `validateSettings` (warnings via `cds.log('systemone').warn`), then `setup()`, then registers `decide`. The handler validates the request with `settings.limits`, calls `call()`, validates the result, logs the debug line, returns the result.
3. `CloudflareService`: `endpoint()` uses an explicit URL, or builds it from an encoded `accountId`, or throws `INVALID_CONFIG`; `unwrap()` requires `success: true` (`PROVIDER_ERROR` with `providerCode` otherwise) and `result` (`INVALID_RESPONSE` otherwise); `errorCode()` reads `errors[0].code`.
4. Kinds in `package.json` as in the target configuration.
5. Tests first:
   - **Resolution** (`tests/kinds.test.cjs`, rewritten with the T1 helper): each kind by full name resolves the expected `impl`, `modelId`, `requiresToken`, `limits` and URL; an app without `systemone` resolves the generic kind; `[development]` switches kinds with `CDS_ENV=development` while production keeps the base kind; app settings deep-merge over kind settings (`limits.choiceOptions` overridden, `scoreCriteria` kept); regression: TypeSafe and Cloudflare connect when credentials are present, with their own settings.
   - **Connection** (`tests/service.test.cjs`, through `cds.connect.to` in temporary apps): TypeSafe without a token and Cloudflare without a token or `accountId` fail with `INVALID_CONFIG`; Laya and generic connect without a token; a token with non-loopback HTTP fails; a destination with `Authorization` satisfies `requiresToken`, one without fails; an app without `systemone` configuration fails in production with `INVALID_CONFIG` (no URL).
   - **Decision flow:** limits reject before any fetch; `modelId` appears as `model` in the body and is omitted when unset; `before`/`after` handlers and cancellation work; the debug log contains no request data.
   - **Subclass contract:** a subclass overriding `call()` is validated by the base class (an invalid result gives `INVALID_RESPONSE`; an invalid request never reaches `call()`); a subclass overriding `endpoint` and `unwrap` is used for HTTP.
   - **Cloudflare** (`tests/cloudflare.test.cjs`): encoded `accountId` URL, explicit URL wins, `success: false`, missing `result`, `errors[0].code` on HTTP errors.
   - **Transport** (`tests/transport.test.cjs`, `tests/destination.test.cjs`): keep all retry, deadline, cancellation, destination and token tests against `dist/transport`; move response-validation cases to `tests/validation.test.cjs` or the service tests.
   - **Types:** a subclass overriding the hooks compiles; wrong hook signatures fail; `SystemOneTransport` is not importable from `cap-jev`.

#### T4 `model` check in `cds-plugin.js` (*agent*, red-green)

1. If `cds.env.requires.systemone?.model` is set, log an error via `cds.log('systemone')` that names `modelId`. Never throw: `cds-plugin.js` runs for every `cds` command, including `cds build`.
2. Tests first: in a temporary app with `model` set, loading the plugins logs the error and `cds env` style loading does not throw; without `model`, nothing is logged.

#### T5 Extension examples (*agent*, red-green)

1. `examples/provider-package/`: a minimal `cap-jev-provider-acme` with `cds-plugin.js`, a `systemone-acme` kind in its `package.json`, a subclass overriding `endpoint` and `unwrap`, `await super.init()` where `init` is overridden, and `cap-jev` and `@sap/cds` as peer dependencies. Add it to the root workspaces.
2. Tests first (`tests/extension.test.cjs`):
   - An app-local subclass (`"impl": "srv/acme-systemone.js"`) is loaded and used against a local fake server.
   - The provider package, selected with `kind: "systemone-acme"`, is used against the fake server.
   - Single instance: `require.resolve('cap-jev')` from the provider package and from the app give the same file, and the provider service is `instanceof SystemOneService`.

#### T6 Example app protection and `cds.test` (*agent*, red-green)

1. `examples/cap-app/srv/decision-service.cds`: `@requires: 'authenticated-user'` on `DecisionService`.
2. Tests first (`tests/example-app.test.cjs`, using `cds.test` on `examples/cap-app` with `CDS_TYPESCRIPT=true` and the mocked users of the development profile, against a local fake server): an anonymous call gets 401; `alice` gets `support` for a technical message; an empty message gets 400; a provider failure gets 502.
3. Adjust `tests/cap-integration.test.cjs` so programmatic calls run with a user.

#### T7 Documentation (*agent* draft, *main* review)

1. README: install URL for v0.5.0; kinds table with full names, `modelId`, `requiresToken`, `limits` and profile switching; stable entry points (the `decide` API, types, error codes) and experimental ones (the subclass hooks, until the first npm publication); a note that cap-jev serves no services, so actions that call a provider need `@requires` in the application; remove `SystemOneTransport`; short links to the guides below.
2. `docs/providers.md`: adding a provider in three levels (an app kind on `systemone-generic`; an app-local subclass; a provider package), the rules for subclasses (`await super.init()`, no reassigning `this.on`, settings through `static settingsKeys`), and the criteria for a separate package from ADR 0001.
3. `examples/cap-app/README.md`: authentication with the mocked users (`curl -u alice:`).
4. `AGENTS.md`: provider structure (data in kinds, behaviour in `impl`), ADRs in `docs/decisions/` (one decision per file, numbered, Status, Context, Options, Decision, Consequences), plans in `docs/plans/`, tests through the helper or `cds.test`, release steps.
5. `CHANGELOG.md`: complete the 0.5.0 entry.

#### T8 Release 0.5.0 (*main*)

1. Full local verification on CAP 10 and CAP 9; review the diff.
2. Accept ADR 0001 (Status, date).
3. Pull request, CI green on all six jobs, merge commit, tag `v0.5.0`, GitHub release with the archive.
4. Fix anything found in `0.5.x` releases the same way.

## 0.6.0: local-first mock provider

Goal, following the CAP local-first approach: `npm start` in `examples/cap-app` works with no server, token or network; production cannot use the mock by accident.

### Target configuration

The plugin's `package.json` makes the mock the development and test default:

```json
"systemone": { "kind": "systemone-generic", "[development]": { "kind": "systemone-mock" }, "[test]": { "kind": "systemone-mock" } },
"kinds": { "systemone-mock": { "kind": "systemone-defaults", "impl": "cap-jev/providers/mock" } }
```

Verified resolution (CAP 10.1.1 and 9.9.3):

| App configuration | development / test | production |
| --- | --- | --- |
| No `systemone` entry | mock | generic: connection fails with `INVALID_CONFIG` (no URL) |
| `kind: "systemone-typesafe"` | TypeSafe | TypeSafe |
| `"[production]": { "kind": "systemone-typesafe" }` | mock | TypeSafe |
| Only `credentials.url`, no `kind` | mock | generic with that URL |

The last row is documented: set a `kind` to use a real endpoint in development. The mock's startup warning says so.

### Tasks

#### M1 Answer engine (*agent*, red-green; can run in parallel with M2)

File: `src/providers/mock-engine.ts` (pure functions, no CAP).

1. Seed a small PRNG from a SHA-256 hash of the JSON state and the question ID.
2. `choice`: strategy `keywords` (default) scores each label by word overlap between the state and the label plus its criteria text, using the seed only to break ties; strategy `seeded` uses the seed alone.
3. `score`: a seeded distribution over the criteria indices; `score` is its expected value; `legend` maps indices to criteria text.
4. `noul`: a seeded value from 0 to 1. Probabilities sum to 1; `confidence` is the largest probability.
5. Usage estimated as about four characters per token; `model: "mock"`.
6. Tests first (`tests/mock-engine.test.cjs`): identical answers for identical input across calls; a different state or question ID changes the seed; every answer passes `validateResult` for all three types, including optional and numeric choice keys; "I was billed twice" picks `billing` with the README criteria; ties stay stable.

#### M2 Fixtures and rules (*agent*, red-green; can run in parallel with M1)

File: `src/providers/mock-fixtures.ts` (pure functions).

1. Format: an ordered list of rules, `{ "when": { "stateIncludes": "refund" | ["…"], "question": "department" }, "answer": { … } }` or `{ "when": …, "fail": "<SystemOneErrorCode>", "status": 503 }`. The first match per question wins.
2. `parseFixtures(json)` checks the structure (`INVALID_CONFIG` with the rule index); `match(rules, request, questionId)` returns the matching rule; a rule answer that does not fit its question fails with `INVALID_CONFIG` naming the rule.
3. Tests first (`tests/mock-fixtures.test.cjs`): first-match order, `question` filtering, string and array `stateIncludes`, case-insensitive matching, unmatched questions, malformed rules, mismatched answers.

#### M3 MockService and activation (*agent*, red-green)

Files: `src/providers/mock.ts`, `package.json` (kind, default profiles, `exports["./providers/mock"]`), `src/types.ts` (`MockSettings`).

1. `MockService extends SystemOneService` overrides `setup()` (no transport; reads fixtures from `test/data/systemone.json` when present, or from `fixtures` relative to `cds.root`) and `call()`. Settings: `fixtures`, `strategy`, `latencyMs`, `fail`, `allowInProduction`, declared through `static settingsKeys`.
2. Production: `setup()` throws `INVALID_CONFIG` in the `production` profile unless `allowInProduction: true`.
3. Logs one warning on connect: answers are simulated; set a `kind` to use a real endpoint in development.
4. `latencyMs` honours `timeoutMs` (`TIMEOUT`) and the caller's signal (`ABORTED`). `fail` throws the named `SystemOneError` (with `status` for `HTTP_ERROR`).
5. Tests first (`tests/mock.test.cjs`, temporary apps through the T1 helper):
   - The four activation rows above in development, test and production.
   - Production refusal and `allowInProduction`.
   - Fixture file found by default and by `fixtures`; missing file is not an error; malformed file fails on connect.
   - Each `fail` code with its fields; `latencyMs` greater than `timeoutMs` gives `TIMEOUT`; aborting during the delay gives `ABORTED`.
   - No network: with `globalThis.fetch` replaced by a function that throws, calls succeed.
   - `before`/`after` handlers and request validation apply to the mock.
   - Types: `MockSettings` are typed.

#### M4 Example app on the mock (*agent*, red-green)

1. `examples/cap-app/package.json`: `"systemone": { "[production]": { "kind": "systemone-laya" } }`; `examples/cap-app/test/data/systemone.json` with a rule routing refund messages to `billing`.
2. Tests first (`tests/example-app.test.cjs`): in development, `classify` returns `accounts` for a refund message with no fake server running; in production (`CDS_ENV=production`), it uses the fake server; `tests/cap-integration.test.cjs` runs its server calls with `CDS_ENV=production` and adds one development call that uses the mock.
3. Example README: `npm start` needs nothing else; Laya is only needed with `--production`.

#### M5 Documentation and release (*agent* draft, *main* review and release)

1. `docs/local-development.md`: the mock, fixtures, simulated failures, the activation table, and when to use Laya or a real provider; README links to it.
2. Accept ADR 0002, complete the 0.6.0 changelog entry, move this plan to `docs/plans/completed/provider-kinds-and-mock.md`, bump the version to 0.6.0 everywhere listed in `AGENTS.md`.
3. Release as in T8.

## Later

- A Jev-compatible HTTP mock server (`npx cap-jev-mock`) reusing the mock engine, for HTTP-path and non-CAP testing.
- A `cds add systemone` facet (registered with `cds.add?.register?.()`, loaded only for `cds add`) that writes the kind, the development mock and a `.cdsrc-private.json` token placeholder.
- A Laya `docker compose` setup as the "real model on the developer's machine" option.
- A provider test kit, the first npm publication, and making the subclass hooks stable.
- Automated releases (for example a tag-triggered workflow). `release-it` with conventional commits was considered and not adopted, because it would change the commit convention.

## Findings and where they are handled

| Finding | Source | Task |
| --- | --- | --- |
| `model` clashes with CAP; base kind named like the service | Own analysis | T2, T3 |
| Open `@sap/cds` range and CI for CAP 9 and 10 | Report K6, K10, 11.11 | T1 |
| Tests through workspace apps and `cds.test`; one packed test | Report K9, 10.1, 11.10 | T1, T3, T6 |
| Full kind names; short names and `true` undocumented | Report K4; capire `cds-env` | Target configuration, T7 |
| `cds-plugin.js` must not throw | Report 11.4, 10.7 | T4 |
| Example action spends provider quota: protect it | Report 8.3 (`ui5-cap-ai-features`), K5 | T6 |
| One `cap-jev` instance for provider packages | Report 10.1 | T5 |
| Stable vs experimental entry points in the README | Report 3.8 | T7 |
| `await super.init()`, no reassigning `this.on` | Report 8.3 (`cds-kafka`) | T5, T7 |
| Configuration schema does not cover `requires.<service>` | Report 3.3; capire `cds-plugins` | ADR 0001 |
| `cds.queued`/`outboxed` not applicable to a synchronous decision | Report 3.11, 11.1 | ADR 0001 |
| Plugin-level development default is CAP practice and safe | Report 9 (`audit-logging`, `attachments`); verified | 0.6.0, M3 |
| Heavy provider dependencies as optional peers, not separate packages | `cds-caching` | ADR 0001 |
| ADRs and plans kept in `docs/` | `cds-data` (`spec/internal`) | T0, M5 |
| Warn for unknown settings, fail for misplaced secrets | `cds-caching` (`detectMisplacedKeyManagement`) | T2 |
| Guides in `docs/` instead of a long README | `cds-caching` | T7, M5 |

## Progress

| Task | Status |
| --- | --- |
| T0–T8 | Released in 0.5.0; install instructions fixed in 0.5.1 (npm 12 refuses tarball URLs by default) |
| M1–M5 | Released in 0.6.0 |

Found during the work and fixed before release: a network retry could start at the call deadline (0.5.0).

## Blocked tests

None.
