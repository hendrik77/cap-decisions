# Plan: hardening for 1.0.0 (0.9.x), and npm publication

Written on 2026-10-21 against `main` at v0.8.0 (`718296f`). It continues the [0.8 plan](completed/cds-add-systemone.md).

`cap-jev` still has no users: it is development-only and unpublished on npm. Until 1.0.0, changes need no migration code, deprecation period or compatibility shims. From 1.0.0, semantic versioning applies to everything this plan declares stable.

## Contents

- [Starting point](#starting-point)
- [How the work is done](#how-the-work-is-done)
- [0.9.0: stable surface, SubQ Snap, provider test kit, coverage](#090-stable-surface-subq-snap-provider-test-kit-coverage)
- [0.9.1: reviews](#091-reviews)
- [0.9.2: release candidate and acceptance](#092-release-candidate-and-acceptance)
- [1.0.0: npm publication](#100-npm-publication)
- [Later](#later)
- [Progress](#progress)
- [Blocked tests](#blocked-tests)

## Starting point

- 468 tests pass on CAP 9 and CAP 10 (Node 22, 24 and 26 in CI).
- Coverage of `dist/` from the in-process tests (`node --test --experimental-test-coverage`, measured on 2026-10-21): 97.6 % of lines, 93.6 % of branches, 96.1 % of functions. Code that runs only in child processes (the `cap-jev-mock` command line, `cds add`, `cds-plugin.js`) is not counted, so those files look weaker than they are.

  | File | Lines | Branches | Functions |
  | --- | --- | --- | --- |
  | `add-core.js` | 99.2 | 94.6 | 100 |
  | `add.js` | 100 | 75.0 | 100 |
  | `index.js` | 100 | 88.9 | 100 |
  | `mock-server-cli.js` | 91.3 | 50.0 | 88.9 |
  | `mock-server.js` | 96.9 | 90.2 | 91.2 |
  | `providers/cloudflare.js` | 100 | 81.8 | 100 |
  | `providers/mock-core.js` | 100 | 98.1 | 100 |
  | `providers/mock-engine.js` | 100 | 100 | 100 |
  | `providers/mock-fixtures.js` | 100 | 97.7 | 100 |
  | `providers/mock.js` | 100 | 88.2 | 100 |
  | `transport.js` | 94.4 | 90.6 | 83.3 |
  | `validation.js` | 99.1 | 98.9 | 100 |

- The README's stability table marks four areas stable (the service API, the request and answer types, `SystemOneError` and its codes, the kinds and settings) and three experimental "until the first npm publication": the subclass hooks, the HTTP mock server and its command line, and the `cds add systemone` facet.
- No security review has been done. Areas without a recorded decision include: `fetch` follows redirects by default, and a response body is read whole (`response.text()`) without a size limit; the token rule (HTTPS or loopback) is checked on the configured URL.
- Provider packages have no way to test their kind against `cap-jev` except by copying its tests; `examples/provider-package` has none of its own.
- The peer range is `@sap/cds >=9`, in `package.json` and in `examples/provider-package`, so a future CAP 11 counts as supported without being tested. The maintainer decided on 2026-10-21 that `cap-jev` supports **the last two stable CAP major versions**: today CAP 9 and CAP 10; when CAP 11 is released, CAP 9 is dropped (see [H1](#h1-the-100-public-api-main-adr-0006)).
- The npm name `cap-jev` is free (checked 2026-10-21). `package.json` has `repository`, `keywords`, `author`, `files` and `engines`; it has no `homepage` or `bugs`. The README links to `docs/`, which is not in the package.
- No real model has been tested yet: every HTTP test runs against local fakes or the HTTP mock server. The maintainer decided on 2026-10-21 that 1.0.0 needs full acceptance tests, run manually with prepared support, against TypeSafe Jev, Cloudflare Clef, a local Laya server and a local Jev model, and SubQ Snap, added the same day (see [H10](#h10-acceptance-tests-against-the-real-models-user-prepared-by-agent)). None of them is reachable from the development machine of this plan, so the runs need the maintainer.

## How the work is done

As for 0.8.0 (see [the 0.8 plan](completed/cds-add-systemone.md#how-the-work-is-done)):

- **Worktree.** Each release branch `release-0.9.<n>` is checked out in the worktree `.claude/worktrees/release-0.7.0` (reused), so `main` stays untouched until the merge.
- **Subagents** (Sonnet) take the tasks marked *agent*, one at a time in the worktree. The main session reviews each result, runs the full suite on CAP 10 and CAP 9 and commits. Tasks marked *main* are done by the main session, tasks marked *user* need the maintainer.
- **Red, then green.** Tests first; they must fail for the expected reason. A test that still fails after five attempts is marked `{ todo: 'BLOCKED: <reason>' }` and listed under [Blocked tests](#blocked-tests).
- **Review findings are fixed red-green too**: each finding that changes behaviour gets a failing test first. A finding that is not fixed is recorded in the findings table with the reason.
- **Patch releases.** Problems found after a release go into the next 0.9.x patch before the next task group starts.
- **Every release reviews and updates all Markdown files**: `README.md`, `CHANGELOG.md`, `AGENTS.md`, `docs/*.md`, `examples/*/README.md`, the ADRs and the plans, read against the code.

Definition of done, in addition to the earlier plans: every public name is listed in ADR 0006 as stable, experimental or internal; `npm run coverage` passes its thresholds in CI; every high and medium security finding is fixed or explicitly accepted by the maintainer; the peer range names exactly the CAP majors that CI tests; the five acceptance runs of H10 pass on the release candidate that becomes 1.0.0.

## 0.9.0: stable surface, SubQ Snap, provider test kit, coverage

Goal: the public surface of 1.0.0 is complete and written down, SubQ Snap is a kind, provider packages can test their kind, and coverage is measured in CI.

### H1 The 1.0.0 public API (*main*, ADR 0006)

ADR `docs/decisions/0006-public-api-for-1.0.md` lists every public name and decides its status for 1.0.0: **stable** (semantic versioning applies), **experimental** (may change in a minor release, marked in the README) or **internal** (not exported, may change at any time).

1. Inventory, from the code, not from the docs: the `exports` of `package.json` and every name each entry exports, including types; `cds-plugin.js` and its behaviour; the kinds and their settings; `SystemOneError` codes; the subclass hooks and static keys; `startMockServer` options and `MockServer`; the `cap-jev-mock` options, environment variable `CAP_JEV_MOCK_TOKEN`, output lines and exit codes; the fixture file format and its default path; the `cds add systemone` options, the files it writes and its message prefix; the log channel `systemone` and its debug fields.
2. Decisions to make in the ADR, each with options and a recommendation:
   - whether the subclass hooks become stable in 1.0.0, or stay experimental until a second provider package uses them;
   - what is breaking: for example a new error code, a new required setting, a new kind default, a changed CLI exit code, a changed `cds add` message;
   - how the CAP support policy (decided, see below) is versioned: whether dropping the oldest CAP major after 1.0.0 is a major release of `cap-jev`, as semantic versioning usually treats a dropped peer version, or a minor release, because the policy is announced in advance;
   - the Node range (`>=22`) and when an end-of-life Node version is dropped;
   - whether `cap-jev/testing` (H3) is stable or experimental in 1.0.0.
3. Decided by the maintainer, recorded in the ADR and implemented in 0.9.0 (*agent*, red-green): `cap-jev` supports the last two stable CAP major versions.
   - `peerDependencies` becomes `"@sap/cds": "^9 || ^10"` in `package.json` and `examples/provider-package/package.json`.
   - `npm run release:check` fails when the CAP majors in the peer range differ from the CAP majors in the CI matrix (`.github/workflows/ci.yml`), so one cannot change without the other. Tests in `tests/release-scripts.test.cjs`.
   - When CAP 11 is released: one release adds CAP 11 to CI and the peer range and removes CAP 9 from both, together with the CAP 9 notes in the README and `AGENTS.md` (the `@sap/cds-dk@^9` step and the `better-sqlite3` workaround). Code that exists only for CAP 9 is removed in the same release. The README states the policy next to the installation.
4. Proposed while 0.9.x runs; accepted when 1.0.0 is merged. The maintainer reviews the recommendations before 0.9.0 is released.

### H2 Kind `systemone-subq` for SubQ Snap (*agent*, red-green)

The maintainer asked on 2026-10-21 for [SubQ Snap](https://subq.ai/introducing-subq-snap) ([API docs](https://docs.subq.ai/endpoints/decisions-api/), read on 2026-10-21). Its Decisions API speaks the Jev protocol: `POST https://api.subq.ai/v1/systemone`, a bearer token, `model`, `state` and `questions` with `choice`, `score` and `noul`, and answers keyed by question name. It is in public preview, with the model `subq-snap-preview`.

1. The kind, in the `cds` section of `package.json`. These are data only, with no new code for the protocol:

   ```json
   "systemone-subq": {
     "kind": "systemone-defaults",
     "modelId": "subq-snap-preview",
     "requiresToken": true,
     "limits": { "questions": 16, "choiceOptions": 255, "scoreCriteria": { "min": 2, "max": 10 } },
     "credentials": { "url": "https://api.subq.ai/v1/systemone" }
   }
   ```

2. Errors. SubQ answers `{ "detail": { "error_type": "...", "message": "..." } }`; the transport reads only `error.type`, so `providerCode` would be empty. First a probe test with this body against a local server, showing `HTTP_ERROR` without `providerCode`; then the decision, recorded in the ADR of H1:
   - (a) a subclass `cap-jev/providers/subq` whose only hook is `errorCode`, as the conventions of `AGENTS.md` ask for a provider whose protocol differs; or
   - (b) the shared transport also reading `detail.error_type`, if Laya or TypeSafe use the same shape, because shared code names no provider, only shapes.

   Recommended: (a), unless the acceptance runs of H10 show the shape elsewhere. The statuses need nothing new: 429 and 503 are already retried; 400, 401, 402, 403 and 422 become `HTTP_ERROR` with the status.

3. Tests first: `tests/kinds.test.cjs` for the settings, the limits (17 questions, 256 choice options and 11 score criteria are rejected before sending, 16, 255 and 10 are sent), the missing token, the bearer header, the model sent as `subq-snap-preview`, and the error mapping, against a local server. `cds add systemone --kind systemone-subq` gets a case in `tests/cds-add.test.cjs` (the token placeholder, no URL reminder). The kit of H3 includes the kind.
4. Docs: the kind table in the README, the protocol references, `docs/providers.md`, the CHANGELOG. The README notes that the model is in preview, so `modelId` will change when SubQ releases it, and that SubQ stores decisions according to its [data retention](https://docs.subq.ai/using-the-api/data-retention/) policy.
5. Not in 0.9.0: `images` (up to 4 per request, SubQ only). The request type has no images. Whether `cap-jev` sends them, and how a kind declares that it accepts them, is a separate decision; it is listed under [Later](#later). The ADR of H1 decides whether `systemone-subq` is stable or experimental in 1.0.0 while its model is in preview. Recommended: experimental.

### H3 Provider test kit `cap-jev/testing` (*agent*, red-green; ADR 0007)

A provider package runs one function in its own `node:test` file and gets the checks that every kind must pass, without copying `cap-jev`'s tests.

1. ADR `docs/decisions/0007-provider-test-kit.md`: options (copy tests, a fake-server helper only, a conformance suite with a wire-format adapter) and the decision. The kit uses no test framework of its own: it registers `node:test` tests.
2. API (refined by the ADR): `testProviderKind({ kind, appDir?, settings?, encode, encodeError? })`.
   - `kind`: the kind under test; `appDir`: a CAP app that has the provider package installed (default: a temporary app with the package at `process.cwd()` linked in).
   - `encode(response, request)`: turns a Jev response into the provider's wire format (identity for Jev-compatible servers, the envelope for Cloudflare). `encodeError(code, status)`: the provider's error body.
   - The kit starts a local server, points the kind at it through `credentials.url`, and checks: connecting validates the settings; `choice`, `score` and `noul` answers come back typed; the kind's `limits` reject a request before anything is sent; a missing token fails with `INVALID_CONFIG` when `requiresToken` is set; the token is sent as a bearer header; status codes and provider errors map to `HTTP_ERROR`, `PROVIDER_ERROR`, `INVALID_RESPONSE`, `NETWORK_ERROR` and `TIMEOUT`; retries happen for the retryable statuses.
3. Tests first: `tests/testing.test.cjs` runs the kit against `systemone-generic`, `systemone-laya`, `systemone-typesafe` and `systemone-subq` (with a token) and `systemone-cloudflare` (with the envelope adapter), and checks that a deliberately broken provider (wrong `unwrap`) fails the kit with a readable message. `examples/provider-package` gets its own test file that runs the kit for `systemone-acme`, and `npm test` runs it.
4. `exports` gets `./testing`; the module does not load `@sap/cds` until a test runs, and it is not loaded by the plugin at runtime.

### H4 Coverage in CI (*agent*, red-green for the gaps)

1. `npm run coverage`: build, then `node --test --experimental-test-coverage --test-coverage-include='dist/**' --test-coverage-lines=<l> --test-coverage-branches=<b> --test-coverage-functions=<f> tests/*.test.cjs`. Thresholds start at the measured totals rounded down (97 / 93 / 96) and are raised as gaps close; the target for 1.0.0 is 98 / 95 / 98.
2. CI runs `npm run coverage` in one job (Node 24, CAP 10) instead of `npm test`, so the suite still runs once per job.
3. Gap tests, first for `transport.js` (functions 83 %: the interruption and pause helpers, the destination error path), then `mock-server.js`, `providers/cloudflare.js`, `providers/mock.js` and `index.js` branches. A line that cannot be reached is removed, not excluded.
4. The command-line files stay tested in child processes. The README and `AGENTS.md` say that `coverage` does not count child processes, and which files that affects.

### H5 Release 0.9.0 (*main*)

The release steps of `AGENTS.md`, the Markdown review, and a smoke test: a fresh provider package from the published archive runs `testProviderKind` and passes.

## 0.9.1: reviews

Goal: the code, the security properties and the documentation are reviewed once in full, and the findings are fixed before the surface freezes.

### H6 Code review (*main*)

The `code-review` skill at high effort over the whole source (`src/`, `cds-plugin.js`, `scripts/`, `.github/workflows/`), not only a diff. Each finding goes into the findings table below with severity, decision and the task that fixes it.

### H7 Security review (*main*, findings fixed by *agent*)

The `security-review` skill plus a checklist. Each item gets a recorded outcome (fine as is, fixed, or accepted with a reason):

1. Transport: redirects (`fetch` follows them; is the bearer token sent to the new location, and is the HTTPS-or-loopback rule re-checked?); the response size (read whole; add a limit?); the deadline covering body reading; error messages and logs never containing the token or the request state.
2. Destinations: header handling, the token rule for destination URLs, caching.
3. Mock server: loopback default, token comparison, body limit, behaviour on slow clients, `close()`.
4. `cds add systemone`: only the four documented files are written, below `cds.root`; the profile name cannot form a path; a symlinked `.gitignore` or `.cdsrc-private.json`.
5. `cds-plugin.js`: runs for every `cds` command; never throws; loads no facet code outside `add` and `help`.
6. Release workflow and dependencies: permissions per job, pinned action versions, `npm audit` of the published dependency tree (it has none at runtime besides the peers) and of the development tree, the tag trigger.

### H8 Documentation review (*agent* draft, *main* review)

Every Markdown file against the code, plus: JSDoc on every stable export (H1); the README read as it will appear on npmjs.com, where `docs/` links must work (relative links resolve to the repository only if npm rewrites them; check, otherwise use absolute links to the repository for files outside the package).

### H9 Fixes and release 0.9.1 (*agent* per finding, *main* release)

Each accepted finding is fixed red-green in its own commit. The release follows `AGENTS.md`.

### Findings

| # | Source | Finding | Severity | Decision | Fixed in |
| --- | --- | --- | --- | --- | --- |
| F1 | H7 | `fetch` follows redirects: a 307/308 resends the POST body (the state) and custom destination headers to the new location; `authorization` is dropped only across origins | Medium | Fix: `redirect: 'manual'`, a 3xx is `HTTP_ERROR` with its status | `d53378d` |
| F2 | H7 | A token or destination header value with a control character makes `fetch` throw `Headers.append: "Bearer <token>" is an invalid header value`; the token lands in the `cause` of a retried `NETWORK_ERROR` and in logs | Medium | Fix: `INVALID_CONFIG` without the value, at construction (token) and resolution (destination headers) | `b2332f0` |
| F3 | H6, H7 | A successful response body is read whole (`response.text()`) without a size limit | Medium | Fix: 1 MiB limit, `INVALID_RESPONSE`, no retry | `31e74b9` |
| F4 | H6 | `response.body?.cancel()` on the retry path has no `.catch`: a rejected cancel escapes `post()` as a raw `TypeError` | Medium | Fix | `0c5118b` |
| F5 | H6 | An endpoint URL with userinfo (`https://user:pass@host`) passes the settings check; `fetch` refuses it per call, retried as `NETWORK_ERROR` | Low | Fix: `INVALID_CONFIG` at connect | `1ec861c` |
| F6 | H6 | An `errorCode` hook value that `machineCode` rejects drops the provider code instead of falling back to `error.type` | Low | Fix | `412130d` |
| F7 | H6 | A subclass whose `setup()` skips `super.setup()` fails at `decide` with a `TypeError` | Low | Fix: `SystemOneError` naming the missing transport | `695f815` |
| F8 | H6, H8 | The loopback hosts differ: the transport allows `127.0.0.1`, `localhost`, `[::1]`; `cap-jev-mock` treats all of `127.0.0.0/8` as loopback; `add-core` has its own list | Low | Fix: one list, `127.0.0.0/8`, `localhost`, `::1`, shared by all three | `71ba931` |
| F9 | H6 | `queued`, `outboxed` and `outbox` are accepted silently, but a queued `decide()` resolves to `undefined` | Medium | Fix: `INVALID_CONFIG` when one of them is set to a truthy value | `5606438` |
| F10 | H6 | The destination is resolved in `init`; a short outage of the destination service at start-up leaves a rejected connect promise cached until restart | Medium | Fix: a resolver that throws at start-up logs a warning and the call resolves again; a missing destination or a bad URL still fails at connect | `1b2cbbd` |
| F11 | H6 | The kit's `Child.ask` writes to the child's stdin without an `error` listener: an `EPIPE` after the CAP child died crashes the test process | Medium | Fix | `4e54817` |
| F12 | H6 | The kit links packages with `symlinkSync(..., 'dir')`, which needs admin rights on Windows | Low | Fix: `'junction'` | `707fc20` |
| F13 | H6 | `stateIncludes` matches across two state values, because the haystack joins them with a space | Low | Fix: join with a newline, which a phrase cannot span | `017ac1c` |
| F14 | H6 | An empty `CAP_JEV_MOCK_TOKEN` stops `cap-jev-mock` with "token must be a non-empty string" | Low | Fix: empty means unset | `7184b0f` |
| F15 | H6 | `fail` setting errors read "fail rule 0: …" and name fixture keys, not the `--status` option or the `code` key | Low | Fix: messages for the setting | `c399208` |
| F16 | H6 | Cloudflare `{ success: true, result: null }` falls back to the envelope (`unwrap` result `null`) and fails with a generic message | Low | Fix: `result` `null` is "missing result" in the Cloudflare provider; the `undefined` fallback of `unwrap` stays as tested | `1d16227` |
| F17 | H6 | `release:check` misses Linux temporary paths (`/tmp/…`), `/root/` and a home path at the end of a line | Low | Fix | `12cedbd` |
| F18 | H8 | `release:check` does not check the `cap-jev` range in `examples/provider-package/README.md` nor the peer range quoted in `docs/providers.md`; both were stale in 0.9.0 | Low | Fix, and add the README to the release steps | `26f98d2` |
| F19 | H6 | CI runs the full matrix twice for a push to a branch with an open pull request | Low | Fix: `push` only for `main` | `ed9e798` |
| F20 | H8 | No JSDoc on the stable exports; experimental names lack `@experimental` (ADR 0006 asks for it) | Medium | Fix | `4e66295` |
| F21 | H8 | Small stale texts: ADR 0006 counts the README stability rows; `docs/providers.md` omits that the example overrides `init`; the exported entries `cap-jev/providers/*` and the kit types `WireError`, `WireErrorInput` are named nowhere in the guides | Low | Fix | `0a7653b` |
| F22 | H6 | A 2xx response whose body breaks is retried, although the server processed the decision | Low | Accepted: a decision has no side effect besides billing, the same as a retried 503; tested behaviour | — |
| F23 | H6 | Jev-format mock server sends a `PROVIDER_ERROR` rule as HTTP 500 (`HTTP_ERROR` at the client), `MockService` raises `PROVIDER_ERROR` | Low | Accepted: a Jev server reports errors through the status, so the HTTP mock shows what a real client sees; documented | — |
| F24 | H6 | The CI step conditions name CAP majors (`matrix.cds == 9`) that `release:check` does not compare | Low | Accepted for now: the CAP 11 release changes them together (H1 step 3); `AGENTS.md` says so | `ed9e798` (`AGENTS.md`) |
| F25 | H6 | Copies of the `record` guard in seven modules; three abortable sleeps; settings checked twice (validation and transport); state lower-cased per question in the mock | Low | Accepted: no behaviour change, and the transport is used without `validateSettings` by tests and the kit | — |
| F26 | H6 | The mock server knows Cloudflare's envelope (`format: 'cloudflare'`); `add-core` names `systemone-laya` as default | Low | Accepted: a development tool that imitates provider wire formats, documented; the default kind is a product decision | — |
| F27 | H7 | `npm audit`: 6 findings (2 critical, 4 high), all inside the development dependency `@sap/cds-dk` (handlebars, braces, micromatch); the runtime tree has none | Low | Accepted: not in the package, no fix without downgrading `@sap/cds-dk` | — |
| F28 | H7 | Actions are pinned to major tags, not commit SHAs | Low | Accepted until H11: pinned by SHA when the publish job gets `id-token: write` | H11 |
| F29 | H7 | `cds add systemone` follows a symlinked `.gitignore` or `.cdsrc-private.json` | Low | Accepted: the developer controls the project, as with every editor and `git` itself | — |
| F30 | H8 | The README's relative links to `docs/` and `examples/` point outside the package | Low | Accepted: npmjs.com resolves them against the GitHub `repository`; checked in the 1.0.0 smoke test | 1.0.0 |

The fixes are grouped into tasks for H9, done in this order: A transport and service hooks, B service settings and destinations, C mock, mock server and kit, D release check and CI, E documentation and JSDoc. The last column names the commit once a fix is in. The H7 checklist items not listed here were found fine as they are: the mock server binds to loopback by default, compares a SHA-256 digest of the token with `timingSafeEqual` and limits bodies to 1 MiB; `cds add systemone` writes only its four files below `cds.root` and checks the profile name against `[A-Za-z0-9_-]+`; `cds-plugin.js` catches every error of the facet registration; the workflows have `contents: read` by default and `contents: write` only for the release job, and use `$GITHUB_REF_NAME` through the environment, not through expression interpolation in scripts. The `security-review` skill reviews a diff, and the branch had none, so the checklist was worked through by hand.

## 0.9.2: release candidate and acceptance

Goal: everything that 1.0.0 needs is in place and verified against the real models, except the publication itself.

### H10 Acceptance tests against the real models (*user*, prepared by *agent*)

Before 1.0.0, each of the five targets passes a full acceptance run. The maintainer runs it by hand, with a prepared script, a checklist and the main session analysing the output.

| Target | Kind | Model | The maintainer provides |
| --- | --- | --- | --- |
| TypeSafe Jev | `systemone-typesafe` | `jev-latest` | a TypeSafe API token |
| Cloudflare Clef | `systemone-cloudflare` | `clef` | `accountId` and a token with only Workers AI Read and Edit |
| Local Laya | `systemone-laya` | the server's | a Laya server on `127.0.0.1:8000` |
| Local Jev model | `systemone-generic` with `credentials.url` | the server's | a Jev-compatible server running on the machine |
| SubQ Snap | `systemone-subq` (H2) | `subq-snap-preview` | a SubQ API key with credits (a request without credits fails with 402) |

1. *agent*, red-green: `scripts/acceptance.cjs` (not in the package). `node scripts/acceptance.cjs --kind <kind> --archive <cap-jev-x.y.z.tgz> [--url <url>]` creates a fresh app, installs the archive, runs `cds add systemone --kind <kind>`, takes the token from the environment variable `CAP_JEV_ACCEPTANCE_TOKEN` (never from an argument, never printed) and runs the checks in the production profile:
   - connecting validates the settings; a missing token fails with `INVALID_CONFIG` (token kinds);
   - `choice`, `score` and `noul` answers come back typed: the choice is one of the offered labels, the score is in range, `noul` has its fields;
   - several questions in one request;
   - a request at each limit of the kind is accepted (Laya: 100 choice options; TypeSafe: 255 choice options, 2 and 10 score criteria; Cloudflare: 64 questions; SubQ: 16 questions, 255 choice options, 2 and 10 score criteria), and one over the limit is rejected before anything is sent;
   - a wrong token fails with `HTTP_ERROR` (401 or 403), and neither the error message nor the log contains the token (token kinds);
   - `timeoutMs: 1` fails with `TIMEOUT`;
   - a URL with nothing listening fails with `NETWORK_ERROR` (local targets);
   - the example app's handler end to end: a refund ticket is routed;
   - the latency of each call.

   It prints one line per check (`pass`, `fail` or `skipped` with the reason) and ends with a Markdown result block. Its own tests in `tests/acceptance-script.test.cjs` run it against `cap-jev-mock` for all five kinds (`--format cloudflare` for Cloudflare, `--token` for the token kinds), so the script is tested before anyone runs it against a real model.

2. *agent*: `docs/acceptance.md`: the prerequisites per target (accounts, tokens and their permissions, how to start Laya and a local Jev server), the commands, what each check shows, and one result table per target: date, `cap-jev` archive, CAP and Node versions, model or server version, result, notes.
3. *user*: run all five against the 0.9.2 archive and paste the output into the session; the main session records it in `docs/acceptance.md`.
4. A failure caused by `cap-jev` becomes a finding, fixed red-green in 0.9.3, and the affected runs are repeated on 0.9.3. A provider difference (another limit, another error format, a model that answers outside the offered labels) changes the kind's settings or is documented in the README. Runs that are older than a change to the transport, the validation or a kind are repeated.
5. 1.0.0 is released only when all five runs pass on the release candidate that becomes 1.0.0. If a target is unavailable, 1.0.0 waits.

### H11 Publication readiness (*agent*, *main*)

1. `package.json`: `homepage` and `bugs`; check `files`, `exports`, `bin`, `engines`, the peer range from H1.
2. The release workflow runs `npm publish --dry-run` after `npm pack`, so the publication step is exercised on every release before 1.0.0.
3. Decide the publication method in ADR `docs/decisions/0008-npm-publication.md`: npm trusted publishing from GitHub Actions (OIDC, no long-lived token, provenance automatic) or an npm token secret with `npm publish --provenance`. Recommended: trusted publishing.
4. *user*: create the npm account or organisation, reserve the name with the chosen method, and configure the trusted publisher (repository, workflow file `release.yml`).

### H12 Release 0.9.2 (*main*)

The release steps, the Markdown review, the smoke tests of 0.7.0 to 0.9.0 again from the published archive, and `npm publish --dry-run` in the workflow log. Then the acceptance runs of H10 on the published 0.9.2 archive.

## 1.0.0: npm publication

- All five acceptance runs in `docs/acceptance.md` pass on the release candidate that becomes 1.0.0 (H10).
- ADRs 0006, 0007 and 0008 accepted; the README's stability table matches ADR 0006; semantic versioning applies from here.
- The release workflow publishes with the method from H11, with provenance; the release archives stay attached to GitHub releases.
- The install instructions switch to `npm add cap-jev`, or `cds add systemone -p cap-jev`, which installs and configures in one step; `release:check` checks the npm instructions instead of the archive URLs.
- Smoke test: `npm add cap-jev` in a fresh app, `cds add systemone`, development on the mock, production through `npx cap-jev-mock`, and `npm view cap-jev` shows the provenance.

## Later

- A Laya `docker compose` setup as the "real model on the developer's machine" option, documented only, without CI.
- Repeating the acceptance runs of H10 for every minor release after 1.0.0.
- Images in a request (`images`, which SubQ Snap accepts; see H2): a request field, a kind setting that says whether the provider accepts them, and limits for their number and size.
- Separate provider packages (ADR 0001, option D), when a provider needs heavy dependencies.
- The mock refusing `credentials.url` without a `kind` in development, if the warning proves insufficient.
- `cds add systemone` for `.cdsrc.json` projects and for credentials beyond the token (such as Cloudflare's `accountId`), if needed.
- Coverage of child processes (`NODE_V8_COVERAGE` merged with `c8`), if the command-line files need it.

## Progress

| Task | Status |
| --- | --- |
| H1 | ADR 0006 proposed, waiting for the maintainer's review; CAP support policy implemented (`^9 \|\| ^10`, checked by `release:check`) |
| H2 | Done: `systemone-subq` and `cap-jev/providers/subq` (`errorCode` only), 500 tests |
| H3 | Done: `cap-jev/testing` (`testProviderKind`), ADR 0007 proposed; run for the five built-in HTTP kinds and `systemone-acme` |
| H4 | Done: `npm run coverage` at 98 / 96 / 98 (reached 99.0 / 96.2 / 98.1), run in the Node 24 / CAP 10 job; 649 tests. Child processes that exit on their own are counted after all; only signal-stopped ones, `cds-plugin.js` and the kit's CAP side are not |
| H5 | Released 0.9.0 on 2026-10-22 (PR #10, merge `60e4fbe`, tag `v0.9.0`, release workflow run 39747500064). Smoke test from the published archive: the provider package runs the kit (14 pass, 4 skipped, 0 fail); `cds add systemone --kind systemone-subq` writes the profile kind and the token placeholder; development answers from the mock; production with the empty token fails with `INVALID_CONFIG`. ADR 0006 was not yet reviewed by the maintainer before the release, as step 4 of H1 asked; the review moves to 0.9.1 |
| H6–H8 | Done on 2026-10-23: 30 findings (F1–F30), 21 to fix, 9 accepted |
| H9 | Done: F1–F21 fixed red-green, one commit each; 678 tests (657 pass, 21 skipped, 0 fail) on CAP 10.1.1 and CAP 9.9.4; coverage 99.0 / 96.3 / 98.1 |
| Release 0.9.1 | Released on 2026-10-23 (PR #11, merge `f1f010d`, tag `v0.9.1`, release workflow run 39947217412). Smoke test from the published archive: the provider package runs the kit (14 pass, 4 skipped, 0 fail); `cds add systemone --kind systemone-subq` works; development answers from the mock; production with the empty token fails with `INVALID_CONFIG`. ADR 0006 and ADR 0007 still wait for the maintainer's review |
| H10–H12 | Open |

## Blocked tests

None.
