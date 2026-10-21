# Plan: hardening for 1.0.0 (0.9.x), and npm publication

Written on 2026-10-21 against `main` at v0.8.0 (`718296f`). It continues the [0.8 plan](completed/cds-add-systemone.md).

`cap-jev` still has no users: it is development-only and unpublished on npm. Until 1.0.0, changes need no migration code, deprecation period or compatibility shims. From 1.0.0, semantic versioning applies to everything this plan declares stable.

## Contents

- [Starting point](#starting-point)
- [How the work is done](#how-the-work-is-done)
- [0.9.0: stable surface, provider test kit, coverage](#090-stable-surface-provider-test-kit-coverage)
- [0.9.1: reviews](#091-reviews)
- [0.9.2: release candidate](#092-release-candidate)
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
- The peer range is `@sap/cds >=9`, so a future CAP 11 counts as supported without being tested.
- The npm name `cap-jev` is free (checked 2026-10-21). `package.json` has `repository`, `keywords`, `author`, `files` and `engines`; it has no `homepage` or `bugs`. The README links to `docs/`, which is not in the package.
- No real Laya server is reachable from the development machine of this plan; a run against Laya needs the maintainer.

## How the work is done

As for 0.8.0 (see [the 0.8 plan](completed/cds-add-systemone.md#how-the-work-is-done)):

- **Worktree.** Each release branch `release-0.9.<n>` is checked out in the worktree `.claude/worktrees/release-0.7.0` (reused), so `main` stays untouched until the merge.
- **Subagents** (Sonnet) take the tasks marked *agent*, one at a time in the worktree. The main session reviews each result, runs the full suite on CAP 10 and CAP 9 and commits. Tasks marked *main* are done by the main session, tasks marked *user* need the maintainer.
- **Red, then green.** Tests first; they must fail for the expected reason. A test that still fails after five attempts is marked `{ todo: 'BLOCKED: <reason>' }` and listed under [Blocked tests](#blocked-tests).
- **Review findings are fixed red-green too**: each finding that changes behaviour gets a failing test first. A finding that is not fixed is recorded in the findings table with the reason.
- **Patch releases.** Problems found after a release go into the next 0.9.x patch before the next task group starts.
- **Every release reviews and updates all Markdown files**: `README.md`, `CHANGELOG.md`, `AGENTS.md`, `docs/*.md`, `examples/*/README.md`, the ADRs and the plans, read against the code.

Definition of done, in addition to the earlier plans: every public name is listed in ADR 0006 as stable, experimental or internal; `npm run coverage` passes its thresholds in CI; every high and medium security finding is fixed or explicitly accepted by the maintainer.

## 0.9.0: stable surface, provider test kit, coverage

Goal: the public surface of 1.0.0 is complete and written down, provider packages can test their kind, and coverage is measured in CI.

### H1 The 1.0.0 public API (*main*, ADR 0006)

ADR `docs/decisions/0006-public-api-for-1.0.md` lists every public name and decides its status for 1.0.0: **stable** (semantic versioning applies), **experimental** (may change in a minor release, marked in the README) or **internal** (not exported, may change at any time).

1. Inventory, from the code, not from the docs: the `exports` of `package.json` and every name each entry exports, including types; `cds-plugin.js` and its behaviour; the kinds and their settings; `SystemOneError` codes; the subclass hooks and static keys; `startMockServer` options and `MockServer`; the `cap-jev-mock` options, environment variable `CAP_JEV_MOCK_TOKEN`, output lines and exit codes; the fixture file format and its default path; the `cds add systemone` options, the files it writes and its message prefix; the log channel `systemone` and its debug fields.
2. Decisions to make in the ADR, each with options and a recommendation:
   - whether the subclass hooks become stable in 1.0.0, or stay experimental until a second provider package uses them;
   - what is breaking: for example a new error code, a new required setting, a new kind default, a changed CLI exit code, a changed `cds add` message;
   - the peer range: `>=9` (CAP 11 counts as supported untested) or `^9 || ^10` (CAP 11 needs a minor release of `cap-jev`);
   - the Node range (`>=22`) and when an end-of-life Node version is dropped;
   - whether `cap-jev/testing` (H2) is stable or experimental in 1.0.0.
3. Proposed while 0.9.x runs; accepted when 1.0.0 is merged. The maintainer reviews the recommendations before 0.9.0 is released.

### H2 Provider test kit `cap-jev/testing` (*agent*, red-green; ADR 0007)

A provider package runs one function in its own `node:test` file and gets the checks that every kind must pass, without copying `cap-jev`'s tests.

1. ADR `docs/decisions/0007-provider-test-kit.md`: options (copy tests, a fake-server helper only, a conformance suite with a wire-format adapter) and the decision. The kit uses no test framework of its own: it registers `node:test` tests.
2. API (refined by the ADR): `testProviderKind({ kind, appDir?, settings?, encode, encodeError? })`.
   - `kind`: the kind under test; `appDir`: a CAP app that has the provider package installed (default: a temporary app with the package at `process.cwd()` linked in).
   - `encode(response, request)`: turns a Jev response into the provider's wire format (identity for Jev-compatible servers, the envelope for Cloudflare). `encodeError(code, status)`: the provider's error body.
   - The kit starts a local server, points the kind at it through `credentials.url`, and checks: connecting validates the settings; `choice`, `score` and `noul` answers come back typed; the kind's `limits` reject a request before anything is sent; a missing token fails with `INVALID_CONFIG` when `requiresToken` is set; the token is sent as a bearer header; status codes and provider errors map to `HTTP_ERROR`, `PROVIDER_ERROR`, `INVALID_RESPONSE`, `NETWORK_ERROR` and `TIMEOUT`; retries happen for the retryable statuses.
3. Tests first: `tests/testing.test.cjs` runs the kit against `systemone-generic`, `systemone-laya`, `systemone-typesafe` (with a token) and `systemone-cloudflare` (with the envelope adapter), and checks that a deliberately broken provider (wrong `unwrap`) fails the kit with a readable message. `examples/provider-package` gets its own test file that runs the kit for `systemone-acme`, and `npm test` runs it.
4. `exports` gets `./testing`; the module does not load `@sap/cds` until a test runs, and it is not loaded by the plugin at runtime.

### H3 Coverage in CI (*agent*, red-green for the gaps)

1. `npm run coverage`: build, then `node --test --experimental-test-coverage --test-coverage-include='dist/**' --test-coverage-lines=<l> --test-coverage-branches=<b> --test-coverage-functions=<f> tests/*.test.cjs`. Thresholds start at the measured totals rounded down (97 / 93 / 96) and are raised as gaps close; the target for 1.0.0 is 98 / 95 / 98.
2. CI runs `npm run coverage` in one job (Node 24, CAP 10) instead of `npm test`, so the suite still runs once per job.
3. Gap tests, first for `transport.js` (functions 83 %: the interruption and pause helpers, the destination error path), then `mock-server.js`, `providers/cloudflare.js`, `providers/mock.js` and `index.js` branches. A line that cannot be reached is removed, not excluded.
4. The command-line files stay tested in child processes. The README and `AGENTS.md` say that `coverage` does not count child processes, and which files that affects.

### H4 Release 0.9.0 (*main*)

The release steps of `AGENTS.md`, the Markdown review, and a smoke test: a fresh provider package from the published archive runs `testProviderKind` and passes.

## 0.9.1: reviews

Goal: the code, the security properties and the documentation are reviewed once in full, and the findings are fixed before the surface freezes.

### H5 Code review (*main*)

The `code-review` skill at high effort over the whole source (`src/`, `cds-plugin.js`, `scripts/`, `.github/workflows/`), not only a diff. Each finding goes into the findings table below with severity, decision and the task that fixes it.

### H6 Security review (*main*, findings fixed by *agent*)

The `security-review` skill plus a checklist. Each item gets a recorded outcome (fine as is, fixed, or accepted with a reason):

1. Transport: redirects (`fetch` follows them; is the bearer token sent to the new location, and is the HTTPS-or-loopback rule re-checked?); the response size (read whole; add a limit?); the deadline covering body reading; error messages and logs never containing the token or the request state.
2. Destinations: header handling, the token rule for destination URLs, caching.
3. Mock server: loopback default, token comparison, body limit, behaviour on slow clients, `close()`.
4. `cds add systemone`: only the four documented files are written, below `cds.root`; the profile name cannot form a path; a symlinked `.gitignore` or `.cdsrc-private.json`.
5. `cds-plugin.js`: runs for every `cds` command; never throws; loads no facet code outside `add` and `help`.
6. Release workflow and dependencies: permissions per job, pinned action versions, `npm audit` of the published dependency tree (it has none at runtime besides the peers) and of the development tree, the tag trigger.

### H7 Documentation review (*agent* draft, *main* review)

Every Markdown file against the code, plus: JSDoc on every stable export (H1); the README read as it will appear on npmjs.com, where `docs/` links must work (relative links resolve to the repository only if npm rewrites them; check, otherwise use absolute links to the repository for files outside the package).

### H8 Fixes and release 0.9.1 (*agent* per finding, *main* release)

Each accepted finding is fixed red-green in its own commit. The release follows `AGENTS.md`.

### Findings

| # | Source | Finding | Severity | Decision | Fixed in |
| --- | --- | --- | --- | --- | --- |
| | | Filled in by H5 to H7 | | | |

## 0.9.2: release candidate

Goal: everything that 1.0.0 needs is in place and verified, except the publication itself.

### H9 Run against a real Laya server (*user*, prepared by *agent*)

1. *agent*: `docs/verification.md` with a script (in the document, not in the package) that runs the example app in production against `systemone-laya` and checks all three question types, the `choiceOptions` limit of 100, a timeout with a small `timeoutMs`, and the error for a stopped server. It prints one line per check.
2. *user*: run it against Laya and record the date, the Laya version and the output in the document.
3. Differences between Laya and the mock server become findings for 0.9.3, or a documented difference.

### H10 Publication readiness (*agent*, *main*)

1. `package.json`: `homepage` and `bugs`; check `files`, `exports`, `bin`, `engines`, the peer range from H1.
2. The release workflow runs `npm publish --dry-run` after `npm pack`, so the publication step is exercised on every release before 1.0.0.
3. Decide the publication method in ADR `docs/decisions/0008-npm-publication.md`: npm trusted publishing from GitHub Actions (OIDC, no long-lived token, provenance automatic) or an npm token secret with `npm publish --provenance`. Recommended: trusted publishing.
4. *user*: create the npm account or organisation, reserve the name with the chosen method, and configure the trusted publisher (repository, workflow file `release.yml`).

### H11 Release 0.9.2 (*main*)

The release steps, the Markdown review, the smoke tests of 0.7.0 to 0.9.0 again from the published archive, and `npm publish --dry-run` in the workflow log.

## 1.0.0: npm publication

- ADRs 0006, 0007 and 0008 accepted; the README's stability table matches ADR 0006; semantic versioning applies from here.
- The release workflow publishes with the method from H10, with provenance; the release archives stay attached to GitHub releases.
- The install instructions switch to `npm add cap-jev`, or `cds add systemone -p cap-jev`, which installs and configures in one step; `release:check` checks the npm instructions instead of the archive URLs.
- Smoke test: `npm add cap-jev` in a fresh app, `cds add systemone`, development on the mock, production through `npx cap-jev-mock`, and `npm view cap-jev` shows the provenance.

## Later

- A Laya `docker compose` setup as the "real model on the developer's machine" option, documented only, without CI.
- Separate provider packages (ADR 0001, option D), when a provider needs heavy dependencies.
- The mock refusing `credentials.url` without a `kind` in development, if the warning proves insufficient.
- `cds add systemone` for `.cdsrc.json` projects and for credentials beyond the token (such as Cloudflare's `accountId`), if needed.
- Coverage of child processes (`NODE_V8_COVERAGE` merged with `c8`), if the command-line files need it.

## Progress

| Task | Status |
| --- | --- |
| H1–H4 | Open |
| H5–H8 | Open |
| H9–H11 | Open |

## Blocked tests

None.
