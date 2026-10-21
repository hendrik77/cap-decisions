# Plan: HTTP mock server and automated releases (0.7.0), and the road to 1.0.0

Written on 2026-10-21 against `main` at v0.6.0 (`f0416a3`).

`cap-jev` still has no users: it is development-only and unpublished on npm. Changes need no migration code, deprecation period or compatibility shims.

The reasoning lives in two draft ADRs:

- [ADR 0003: HTTP mock server in the same package](../decisions/0003-http-mock-server.md), accepted when 0.7.0 is merged.
- [ADR 0004: Tag-triggered release workflow](../decisions/0004-tag-triggered-releases.md), accepted when 0.7.0 is merged.

## Contents

- [Starting point](#starting-point)
- [How the work is done](#how-the-work-is-done)
- [0.7.0: HTTP mock server and automated releases](#070-http-mock-server-and-automated-releases)
- [0.7.1: no absolute paths](#071-no-absolute-paths)
- [0.8.0: `cds add systemone`](#080-cds-add-systemone)
- [0.9.x: hardening for 1.0.0](#09x-hardening-for-100)
- [1.0.0: npm publication](#100-npm-publication)
- [Later](#later)
- [Progress](#progress)
- [Blocked tests](#blocked-tests)

## Starting point

- The in-process mock (`systemone-mock`, ADR 0002) answers without HTTP. The HTTP path (transport retries, timeouts, `Retry-After`, destinations, the Cloudflare envelope) is tested only against ad-hoc fake servers inside the tests (`tests/helpers/fake-server.cjs`, `tests/cap-integration.test.cjs`). Developers who want to try `systemone-laya` or a client outside CAP need a running Laya server.
- The mock's engine (`src/providers/mock-engine.ts`) and fixture rules (`src/providers/mock-fixtures.ts`) are pure and import no CAP code. The orchestration (settings checks, fixture loading, `fail`, rule order) sits in `MockService` (`src/providers/mock.ts`), next to CAP-specific code (`cds.root`, `cds.env.profiles`, `cds.log`).
- Releases follow six manual steps in `AGENTS.md`. Steps 2 (version in six places) and 6 (GitHub release with the archive) are error-prone and were done by hand for every release up to 0.6.0. The release titles have the form `<version>: <title>`; `CHANGELOG.md` headings carry only the version.
- `validateRequest` ignores unknown top-level keys, so a request with `model` (sent when a kind sets `modelId`) passes it.

## How the work is done

As for 0.5.0 and 0.6.0 (see [the completed plan](completed/provider-kinds-and-mock.md#how-the-work-is-done)), with these changes:

- **Worktree.** The release branch `release-0.7.0` is checked out in its own worktree (`.claude/worktrees/release-0.7.0`), so `main` stays untouched until the merge.
- **Subagents** (Sonnet) take the tasks marked *agent*, one at a time in the worktree. The main session reviews each result, runs the full suite and commits.
- **Red, then green.** Tests first; they must fail for the expected reason. A test that still fails after five attempts is marked `{ todo: 'BLOCKED: <reason>' }` and listed under [Blocked tests](#blocked-tests).
- **Patch releases.** Problems found after 0.7.0 is released go into 0.7.1 and so on, before 0.8.0 starts.
- **Every release updates all Markdown files** that describe the changed behaviour: `README.md`, `CHANGELOG.md`, `AGENTS.md`, `docs/*.md`, `examples/*/README.md`, the ADRs and this plan.

The definition of done from the completed plan applies, plus: the mock server imports no CAP code, and the release workflow has no write permission outside the release job.

## 0.7.0: HTTP mock server and automated releases

Goals:

1. `npx cap-jev-mock` starts a local Jev-compatible server that answers like the in-process mock, so the HTTP path, `systemone-laya` and clients outside CAP work without Laya, a token or network access.
2. Pushing a tag `v<x.y.z>` creates the GitHub release with the archive and the changelog section; a script checks that the version is consistent everywhere before the release is made.

### Target behaviour: mock server

Command line (`bin` `cap-jev-mock`, built from `src/mock-server-cli.ts`):

```sh
npx cap-jev-mock [--port 8000] [--host 127.0.0.1] [--path /v1/systemone] [--fixtures test/data/systemone.json]
                 [--strategy keywords|seeded] [--latency-ms 0] [--fail CODE [--status N] [--provider-code CODE]]
                 [--token TOKEN] [--format jev|cloudflare] [--quiet] [--help] [--version]
```

- The defaults make it a drop-in for `systemone-laya` (`http://127.0.0.1:8000/v1/systemone`): `npx cap-jev-mock` and `CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya npm start` work together.
- `--port 0` picks a free port. The server prints one line with its URL when it listens, and one line per request unless `--quiet` is set.
- `--fixtures` is relative to the current directory. A missing default file is fine; a missing configured file fails at startup.
- `--token` (or `CAP_JEV_MOCK_TOKEN`) requires `Authorization: Bearer <token>`, for kinds with `requiresToken`.
- `--host` other than a loopback address prints a warning that the server is reachable from the network.
- Invalid options exit with code 2 and a message on stderr. `SIGINT` and `SIGTERM` close the server and exit with 0.

Programmatic API (`cap-jev/mock-server`, experimental like the subclass hooks):

```ts
import { startMockServer } from 'cap-jev/mock-server';
const server = await startMockServer({ port: 0, rules: [/* fixture rules */], token: 'secret' });
server.url; // http://127.0.0.1:<port>/v1/systemone
await server.close();
```

`MockServerOptions`: `port`, `host`, `path`, `fixtures` (file) or `rules` (array, not both), `root` (base for `fixtures`, default `process.cwd()`), `strategy`, `latencyMs`, `fail`, `token`, `format`, `log` (a function, default none).

HTTP behaviour:

| Request | Response |
| --- | --- |
| `POST <path>` with a valid Jev request | 200 with the same answer the in-process mock gives for that request, fixtures and settings |
| Other path | 404 `{ "error": { "type": "not_found_error" } }` |
| Other method on `<path>` | 405 with `Allow: POST` |
| Body larger than 1 MiB | 413 `{ "error": { "type": "request_too_large" } }` |
| Invalid JSON, or a request `validateRequest` rejects | 400 `{ "error": { "type": "invalid_request_error", "message": "…" } }` |
| `--token` set, header missing or wrong | 401 `{ "error": { "type": "authentication_error" } }` |
| A fixture `answer` that does not fit its question | 500 `{ "error": { "type": "mock_fixture_error", "message": "…" } }` |

`model` in the request is accepted and ignored. Simulated failures (`fail` or a fixture rule with `fail`) happen on the HTTP level, so the client's own transport produces the error code:

| `fail` | Server does | `cap-jev` client sees |
| --- | --- | --- |
| `HTTP_ERROR` with `status` | Answers with that status and `{ "error": { "type": <providerCode or "mock_error"> } }` | `HTTP_ERROR` with `status` and `providerCode`; 429, 502, 503, 504 and 529 are retried first |
| `NETWORK_ERROR` | Destroys the connection without a response | `NETWORK_ERROR` after retries |
| `TIMEOUT` | Never answers; the connection stays open until the client gives up | `TIMEOUT` |
| `INVALID_RESPONSE` | 200 with a body that is not JSON | `INVALID_RESPONSE` |
| `PROVIDER_ERROR` | `jev`: 500 with `{ "error": { "type": <providerCode or "provider_error"> } }`. `cloudflare`: 200 with `{ "success": false, "errors": [{ "code": <providerCode> }], "result": null }` | `jev`: `HTTP_ERROR` 500 (Jev has no provider-level error); `cloudflare`: `PROVIDER_ERROR` |

`--format cloudflare` wraps every answer in `{ "success": true, "errors": [], "result": … }`, so `systemone-cloudflare` with `credentials.url` pointing at the server can be tried locally. In that format, error bodies use the Cloudflare envelope too, `{ "success": false, "errors": [{ "code": <type>, "message": … }], "result": null }`, so `CloudflareService` finds the code; the error types are the same.

`latencyMs` delays each answer; a client that disconnects ends the wait.

### Target behaviour: release automation

- `scripts/release-check.cjs` (`npm run release:check [-- --tag v<x.y.z>]`) checks for the version in `package.json`:
  - `package-lock.json` (`version` and `packages[""].version`) has it;
  - the `cap-jev` range in `examples/cap-app/package.json` is `^<version>`;
  - every release archive URL in `README.md` and `examples/cap-app/README.md` is `…/download/v<version>/cap-jev-<version>.tgz`, and there is at least one;
  - `CHANGELOG.md` has a heading `## <version>` or `## <version>: <title>`;
  - with `--tag`, the tag is `v<version>`.

  It prints every failed check and exits with 1, or prints one line and exits with 0.
- `scripts/release-notes.cjs <version>` prints the release title (`<version>: <title>`, or `<version>` without a title) and writes the changelog section's body to a file given as `--notes <file>`.
- `.github/workflows/release.yml` runs on pushed tags `v*.*.*`:
  1. job `ci`: calls `ci.yml` (which gets `workflow_call`), so the full matrix runs on the tagged commit;
  2. job `release` (needs `ci`, `permissions: contents: write`, `concurrency` per tag): checkout, Node 24, `npm ci`, `npm run release:check -- --tag $GITHUB_REF_NAME`, `npm pack`, `node scripts/release-notes.cjs`, `gh release create <tag> cap-jev-<version>.tgz --verify-tag --title … --notes-file …`.
  An existing release makes the job fail; nothing is overwritten. No `npm publish` before 1.0.0.
- `CHANGELOG.md` headings get titles, matching the existing GitHub releases: `## 0.6.0: Local-first mock provider` and so on.
- `AGENTS.md` release steps: step 3 adds `npm run release:check`; step 6 becomes "pushing the tag creates the release; check the workflow run and the release". A failed workflow is fixed and re-run, or the release is created by hand as before.

### Tasks

#### R1 Shared mock core (*agent*, refactor under existing tests, plus new unit tests red-green)

File: `src/providers/mock-core.ts` (no CAP imports). Move from `MockService`:

1. `parseMockOptions(settings)`: checks `strategy`, `latencyMs`, `fixtures` and `fail`, returns normalized options; errors as today (`INVALID_CONFIG`, same messages).
2. `loadFixtures(root, source, configured)`: reads and parses the rule file as today.
3. `mockDecision(request, { strategy, rules, fail, source })`: returns the `DecisionResult` or throws the rule's `SystemOneError` (global `fail` first, then rules per question, then the engine).
4. `MockService` keeps `allowInProduction`, the production check, `cds.root`, the warning and the latency against `timeoutMs` and `signal`, and calls the core.
5. Tests first (`tests/mock-core.test.cjs`): option errors, `loadFixtures` with a missing default file, a missing configured file and invalid JSON, `mockDecision` order (global fail before rules before engine) and equality with `mockResult` for unmatched questions. All existing mock tests stay green unchanged.

#### R2 Mock server (*agent*, red-green)

File: `src/mock-server.ts`, export `./mock-server` in `package.json`, types `MockServerOptions` and `MockServer`.

1. `startMockServer(options)` on `node:http`, with the request table and failure table above; it uses `validateRequest` and `mockDecision` from R1. `close()` also ends open connections, including those held by `TIMEOUT`.
2. Tests first (`tests/mock-server.test.cjs`, plain `fetch`): the request table row by row; determinism (same answer as `mockDecision` for the same request and rules); `--format cloudflare` envelope; token; latency and client disconnect; `fixtures` and `rules` are exclusive; the module loads without `@sap/cds` (check `require.cache` after requiring `dist/mock-server.js` in a child process).
3. Tests first (`tests/mock-server-cap.test.cjs`, temporary CAP apps in the production profile with `systemone-generic` and the server's URL): an answer; `HTTP_ERROR` 503 with `providerCode` and the retry count; `NETWORK_ERROR`; `TIMEOUT` with a small `timeoutMs`; `INVALID_RESPONSE`; `systemone-cloudflare` with a token through `--format cloudflare`, including `PROVIDER_ERROR`; a kind with `requiresToken` and a wrong token gives `HTTP_ERROR` 401.
4. Types (`tests/mock-server.test.ts`): `MockServerOptions` accepts the documented options and rejects `rules` together with `fixtures`.

#### R3 Command line (*agent*, red-green)

File: `src/mock-server-cli.ts` (shebang, `node:util` `parseArgs`), `bin` `cap-jev-mock` in `package.json`.

1. Options as above; `--help` and `--version` print and exit with 0; invalid options exit with 2.
2. Tests first (`tests/mock-server-cli.test.cjs`, child processes): `--port 0` prints the URL and answers; `--fixtures` relative to the working directory; a missing configured file exits with 2; `--fail HTTP_ERROR` without `--status` exits with 2; `--token` and `CAP_JEV_MOCK_TOKEN`; `--quiet`; non-loopback warning; `SIGTERM` exits with 0; `--version` prints the package version.
3. `tests/cap-integration.test.cjs`: after installing the packed archive, `node_modules/.bin/cap-jev-mock --version` prints the version (checks `bin` and the shebang in the archive).

#### R4 Release scripts (*agent*, red-green)

Files: `scripts/release-check.cjs`, `scripts/release-notes.cjs` (CommonJS, exported functions plus a CLI, `--root` for tests), `npm run release:check`, ESLint config for `scripts/`.

1. Tests first (`tests/release-scripts.test.cjs`, temporary directories): each check fails alone with a named message; a consistent tree passes; `--tag` mismatch; notes for a titled and an untitled heading, for the last section in the file, and for a missing version.
2. Add titles to the existing `CHANGELOG.md` headings; `npm run release:check` passes on the repository.

#### R5 Release workflow (*main*)

1. `ci.yml` gets `workflow_call`; `release.yml` as above.
2. Verified by the 0.7.0 release itself: the tag push must create the release with the archive and notes. If it fails, fix it in 0.7.1, and create the 0.7.0 release by hand.

#### R6 Documentation (*agent* draft, *main* review)

1. `docs/local-development.md`: a section "HTTP mock server" with the command, the options, the two tables and the use with `systemone-laya` and `systemone-cloudflare`.
2. `README.md`: local development mentions the server; the stability table lists `cap-jev/mock-server` and the command line (experimental, like the hooks); the development section lists the new tests and `npm run release:check`.
3. `examples/cap-app/README.md`: "Use a real Jev server" adds the mock server as the first option.
4. `AGENTS.md`: structure (`src/mock-server*.ts`, `src/providers/mock-core.ts`, `scripts/`), testing notes, release steps.
5. `CHANGELOG.md` 0.7.0; ADR 0002 references ADR 0003 for its deferred option A.

#### R7 Release 0.7.0 (*main*)

1. Accept ADRs 0003 and 0004; version 0.7.0 everywhere `release:check` checks; update this plan's progress.
2. Full checks, CAP 9 run, `npm pack --dry-run` (contains `dist/mock-server*.js`, no `scripts/`).
3. Pull request, green CI, merge commit, tag `v0.7.0`, push the tag; the workflow creates the release.
4. Smoke test: install the archive in a fresh app; `npx cap-jev-mock --port 0` answers; the app with `systemone-laya` and the server's URL answers in production.

## 0.7.1: no absolute paths

Reported on 2026-10-21: an absolute path from the developer's machine in an example README. A search of the tracked files, the git history and the release notes on `release-0.7.0` found none, so the source still has to be found (a rendered page, the release archive, an untracked file).

#### P1 Find and replace absolute paths (*agent*, red-green)

1. Tests first: `scripts/release-check.cjs` gets a check that no tracked text file (`git ls-files`, without `package-lock.json`) contains a machine path: `/Users/<name>/`, `/home/<name>/`, `/private/tmp/`, `/var/folders/`, or `C:\Users\`. It fails naming the file and line. `tests/release-scripts.test.cjs` covers each pattern and the clean repository.
2. Replace every hit with a path relative to the file (links) or to the project root (commands), and check the unpacked release archive (`npm pack`, then search its files) the same way.
3. `AGENTS.md`: paths in documentation and code are relative; absolute paths are not committed.

## 0.8.0: `cds add systemone`

A detailed plan follows when 0.7.x is done. Scope:

- A facet for `cds add systemone`, registered from `cds-plugin.js` through `cds.add?.register?.()` and loaded only for `cds add`, so normal starts stay unaffected and `cds-plugin.js` still never throws.
- Writes `cds.requires.systemone` with a production `kind` (option `--kind`, default `systemone-laya`), keeps the mock in development, and writes a `.cdsrc-private.json` placeholder for a token when the kind needs one. It never overwrites existing settings and adds `.cdsrc-private.json` to `.gitignore`.
- Optionally (`--with-fixtures`) an example `test/data/systemone.json`.
- Tests on CAP 9 and 10 in temporary apps; first a probe of CAP's `cds add` plugin interface on both versions, because it is thinly documented.
- Release task: review and update all Markdown files (README, CHANGELOG, AGENTS, guides, example READMEs, ADRs, plans) for 0.8.0.

## 0.9.x: hardening for 1.0.0

- Reviews: a full code review at high effort, a security review (transport, destinations, mock server, release workflow), and a documentation review of every Markdown file against the code.
- Tests: coverage report (`node --test --experimental-test-coverage`) with a target per file, and tests for the gaps found; a test run against a real Laya server, by hand and documented.
- Decide the hook API that becomes stable in 1.0.0 (`setup`, `call`, `endpoint`, `unwrap`, `errorCode`, `settingsKeys`, `credentialKeys`) and the mock server API, as an ADR.
- A provider test kit (`cap-jev/testing`) that provider packages run against their kind, used by `examples/provider-package`.

## 1.0.0: npm publication

- Publish `cap-jev` on npm (the name is free as of 2026-10-21) with provenance from the release workflow (`npm publish --provenance`, `id-token: write`, an npm token as a repository secret).
- The install instructions switch to `npm add cap-jev`; the release archives stay attached to GitHub releases.
- The stability table marks the hooks stable; semantic versioning applies from here.

## Later

- A Laya `docker compose` setup as the "real model on the developer's machine" option, documented only, without CI.
- Separate provider packages (ADR 0001, option D), when a provider needs heavy dependencies.
- The mock refusing `credentials.url` without a `kind` in development, if the warning proves insufficient.

## Progress

| Task | Status |
| --- | --- |
| R1–R7 | Released in 0.7.0 |
| P1 (0.7.1) | Open |

Found during the work and fixed before release: in a fresh clone, npm links the workspace's `cap-jev-mock` before the first build and cannot mark it executable, so `npx cap-jev-mock` failed with "Permission denied"; `npm run build` now sets the mode (0.7.0).

## Blocked tests

None.
