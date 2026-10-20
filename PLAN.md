# Plan to close the review findings

This plan closes the open findings in [REVIEW.md](REVIEW.md) (commit `0353627`, version `0.2.0`). Each task names the findings it closes, the files involved, the steps, and what counts as done. Tasks are ordered by priority and dependency; tasks in the same phase are independent and can be done in separate commits.

Every task follows the repository rules in [AGENTS.md](AGENTS.md): add a test for the new behavior and a failure case, use local HTTP servers only, and keep `npm run lint`, `npm run typecheck`, `npm test`, and `npm pack --dry-run` green.

## Phase 1 — Correctness (P2)

### Task 1: Snapshot transport settings at construction

**Closes:** Finding 1.
**Files:** `src/transport.ts`, `tests/transport.test.cjs`, `tests/destination.test.cjs`.

1. In the `SystemOneTransport` constructor, copy `token`, `destination`, and `model` into private readonly fields after validation. Stop storing the `settings` object itself.
2. In `target()`, use the snapshotted `destination` and `token` instead of `this.settings.credentials`.
3. In `decide()`, use the snapshotted `model` and `token`.
4. Keep calling the destination resolver on every call so the Cloud SDK still controls caching.
5. Tests:
   - Add a token to the original settings after construction against `http://example.com`; assert that no `Authorization` header is sent.
   - Remove `credentials.destination` after constructing a destination-based transport; assert that the destination is still resolved.
   - Change `model` after construction; assert that the request body contains the original model.
   - Keep the existing HTTPS and loopback authentication tests passing.

**Done when:** None of the mutations above changes what the transport sends.

### Task 2: Reject unsupported timeouts

**Closes:** Finding 5.
**Files:** `src/transport.ts`, `tests/transport.test.cjs`, `tests/kinds.test.cjs`.

1. Add `const MAX_TIMEOUT_MS = 2_147_483_647;` (Node's timer limit, 2³¹−1).
2. Extend the constructor check to `this.timeoutMs > MAX_TIMEOUT_MS` → `INVALID_CONFIG`, and say in the message that `timeoutMs` must be at most that value.
3. Tests:
   - `2 ** 31` and `2 ** 32` throw `INVALID_CONFIG` at construction.
   - `2_147_483_647` is accepted.
   - Through CAP, `cds.connect.to('systemone')` rejects with `INVALID_CONFIG` for `timeoutMs: 2 ** 31`.
4. Mention the upper limit next to `timeoutMs` in the README.

**Done when:** No accepted `timeoutMs` triggers `TimeoutOverflowWarning` or `ERR_OUT_OF_RANGE`.

### Task 3: Retry response transfer failures

**Closes:** Finding 2.
**Files:** `src/transport.ts`, `tests/transport.test.cjs`.

1. Replace `await response.json()` with two steps:
   - `const text = await response.text()`. If this fails and the signal is not aborted, treat it like a `fetch()` failure: pause and retry while `attempt < MAX_RETRIES`, otherwise throw `NETWORK_ERROR` with the cause.
   - `JSON.parse(text)`. If this fails, throw `INVALID_RESPONSE` with the cause and do not retry.
2. Move the network retry logic into one helper used both by `fetch()` failures and by body read failures, so the two paths cannot drift apart.
3. If the signal is aborted while the body is being read, throw `TIMEOUT` or `ABORTED` through `interruption()`, as before.
4. Tests, each with a local server that sends HTTP 200, part of a JSON body, and then destroys the socket:
   - A partial body followed by a complete one succeeds after 2 requests.
   - Three partial bodies throw `NETWORK_ERROR` with a `terminated` cause after 3 requests.
   - A complete but malformed JSON body throws `INVALID_RESPONSE` after 1 request.
   - A body that stalls until the deadline throws `TIMEOUT`; a caller abort while the body is being read throws `ABORTED`.

**Done when:** A connection reset after the headers is handled like one before the headers.

### Task 4: Harden request content validation

**Closes:** Findings 4 and 7.
**Files:** `src/validation.ts`, `tests/transport.test.cjs`.

1. Replace the `content`/`json` pair with a validator that walks the value and tracks the current path in a `Set` of ancestors: add an object before visiting its children and remove it afterwards. A value already in the set is a cycle. Values that are shared but not ancestors stay valid.
2. Accept only plain objects (`Object.getPrototypeOf(value)` is `Object.prototype` or `null`) and arrays. Reject `Map`, `Set`, `Date`, class instances, and other objects.
3. Keep `record()` as it is for response validation, or give request validation its own `plainObject()` helper, so response checks don't change.
4. Throw `INVALID_REQUEST` for both cases, with messages that tell the two apart (circular vs. unsupported object).
5. Tests:
   - Reject without any network request:
     - circular object in `state`
     - circular array in `state`
     - cycle inside choice criteria
     - `Map` in `state`
     - `Set` in `instructions`
     - class instance in score criteria
   - Accept:
     - a shared but non-circular reference
     - a null-prototype object
6. Decide whether to reject `Date` or allow it, since `JSON.stringify` turns it into a string. Reject it for consistency, and document in the README that request content must be plain JSON data.

**Done when:** Every accepted request content round-trips through `JSON.stringify`/`JSON.parse` unchanged, and invalid content always fails with `SystemOneError('INVALID_REQUEST')`.

### Task 5: Fix answer typing for broad question maps

**Closes:** Finding 3.
**Files:** `src/types.ts`, new `tests/types.test-d.ts` (or a typed file under `tests/`), `package.json`, `tsconfig.json` if needed.

1. Add a distributive helper and use it in `Answers<Q>`:
   ```ts
   type AnswerFor<T> = T extends ChoiceQuestion
     ? ChoiceAnswer
     : T extends ScoreQuestion
       ? ScoreAnswer
       : T extends NoulQuestion
         ? NoulAnswer
         : never;
   export type Answers<Q extends Questions> = { [K in keyof Q]: AnswerFor<Q[K]> };
   ```
2. Add compile-time tests checked by `npm run typecheck`, without new dependencies:
   - `Answers<Questions>[string]` equals `Answer`, and narrowing on `type` gives access to `choice`, `score`, and `noul`.
   - A literal question map passed inline gives the exact answer type per key.
   - A map declared with `satisfies Questions` gives the exact answer type per key.
   - Use `// @ts-expect-error` for one wrong access (e.g. `.choice` on a noul answer), so a regression fails the typecheck.
3. Add the typed test project to the `typecheck` script, either with its own `tsconfig` or by extending `include`. Make sure it isn't emitted into `dist/` or packed.

**Done when:** `npm run typecheck` fails if `Answers<Questions>` falls back to `NoulAnswer` again.

## Phase 2 — Error reporting (P3)

### Task 6: Fail fast when Retry-After exceeds the deadline

**Closes:** Finding 6.
**Files:** `src/transport.ts`, `tests/transport.test.cjs`, `README.md`.

1. Record `const deadlineAt = Date.now() + this.timeoutMs` at the start of `decide()`.
2. Before pausing for a retriable HTTP status, compute the delay. If `delay >= deadlineAt - Date.now()`, cancel the body and throw `HTTP_ERROR` with `status` and `providerCode`. Read the provider code from the error body with `errorPayload()` instead of cancelling the body unread.
3. For network-error retries, cap the pause at the remaining time instead of `this.timeoutMs`.
4. Update the existing test `honours Retry-After and caps it at the overall deadline` (`tests/transport.test.cjs:248–254`): `Retry-After: 10` with `timeoutMs: 40` should now throw `HTTP_ERROR` 429 immediately, after 1 request and well under 40 ms. Keep the 503 / `Retry-After: 0.12` case as it is.
5. Update the README retry paragraph: when the requested `Retry-After` does not fit into the remaining time, the call fails with the HTTP error.
6. Add a CHANGELOG entry: the error code changes from `TIMEOUT` to `HTTP_ERROR` in this case.

**Done when:** Rate limiting is always visible to the caller as `HTTP_ERROR` 429 or 529, not as `TIMEOUT`.

### Task 7: Remove the Response object from HTTP error causes

**Closes:** Finding 8.
**Files:** `src/transport.ts`, `tests/transport.test.cjs`.

1. Remove `cause: response` from the `HTTP_ERROR` construction.
2. Extend the existing HTTP error test: `error.cause` is `undefined`, while `status` and `providerCode` are set as before.

**Done when:** Logging an `HTTP_ERROR` does not print response headers or the endpoint URL.

## Phase 3 — Tooling (deferred findings)

### Task 8: Make the integration test independent of the npm cache

**Closes:** Finding 9.
**Files:** `tests/cap-integration.test.cjs`.

1. Remove `--offline` from the fixture installation. Install with `--prefer-offline --no-audit --no-fund` so a warm cache stays fast and a cold one still works.
2. Pass `timeout` to every `spawnSync` and `execFileAsync` call: about 120 s for `npm install`, 30 s for `npm pack` and each CAP script.
3. Set a timeout on the test itself (`test(name, { timeout: 300_000 }, …)`).
4. If `npm install` fails, show its stderr in the assertion message so CI failures can be diagnosed.
5. Check it in a clean environment, e.g. `npm_config_cache=$(mktemp -d) npm test`.

**Done when:** The integration test passes with an empty npm cache, and a hung child process fails the test within its timeout.

### Task 9: Add a CI workflow

**Closes:** Finding 10.
**Depends on:** Task 8.
**Files:** `.github/workflows/ci.yml`, `README.md`.

1. Add a workflow that runs on `push` and `pull_request` with a matrix of Node 22, 24, and 26.
2. Steps:
   - `actions/checkout`
   - `actions/setup-node` with `cache: npm`
   - `npm ci`
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm pack --dry-run`
3. Set `permissions: contents: read` and a job `timeout-minutes`.
4. Add a CI badge or a short note to the README development section.

**Done when:** The workflow passes on all three Node versions in a pull request.

## Phase 4 — Release

### Task 10: Update documentation and close the review

**Files:** `CHANGELOG.md`, `README.md`, `REVIEW.md`, `package.json`.

1. Add a `0.2.1` (or `0.3.0`, if task 4's stricter validation and task 6's changed error code count as breaking) CHANGELOG section listing:
   - stricter request validation (plain JSON only, cycles rejected)
   - the `timeoutMs` upper limit
   - retried body transfer failures
   - fixed answer typing
   - the Retry-After behavior change
   - the removed `HTTP_ERROR` cause
2. Bump the version in `package.json`, `examples/cap-app/package.json`, and the README tarball name.
3. In `REVIEW.md`, mark each finding as resolved with the commit that closed it, as in the previous round.
4. Run the full check set on Node 22 and the current Node, and record the results in `REVIEW.md`.

## Summary

| Task | Findings | Priority | Depends on |
| --- | --- | --- | --- |
| 1. Snapshot transport settings | 1 | P2 | — |
| 2. Reject unsupported timeouts | 5 | P2 | — |
| 3. Retry response transfer failures | 2 | P2 | — |
| 4. Harden request content validation | 4, 7 | P2 | — |
| 5. Fix answer typing | 3 | P2 | — |
| 6. Fail fast on long Retry-After | 6 | P3 | 3 (shared retry helper) |
| 7. Drop Response cause | 8 | P3 | — |
| 8. Cache-independent integration test | 9 | — | — |
| 9. CI workflow | 10 | — | 8 |
| 10. Docs, version, close review | all | — | 1–9 |
