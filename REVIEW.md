# cap-jev project review

Reviewed on 2026-10-20 at commit `0353627`, version `0.2.0`.

`npm run lint`, `npm run typecheck`, all 27 tests, and `npm pack --dry-run` pass on the installed Node 26 runtime. The runtime failures below were reproduced on Node 22.23.3, and the answer-type failure was confirmed with TypeScript. The existing suite does not cover these failures.

Second pass on 2026-10-20: findings 1–5 were reconfirmed on Node 26.12.0, findings 1, 5 and the request suggestions were extended, and findings 6–8 were added. The deferred findings are now numbered 9 and 10. [PLAN.md](PLAN.md) lists the tasks to close them.

## Implementation status — 0.3.0

All ten findings are addressed by the commit introducing version 0.3.0, based on `0353627`. The original findings are retained below for context.

| Finding | Resolution | Regression coverage |
| --- | --- | --- |
| 1 | Resolved: transport snapshots endpoint, token, destination, model, provider, and timeout; the SDK still resolves destinations for each call. | Settings mutations, HTTPS/loopback authentication, and repeated destination resolution in `tests/transport.test.cjs` and `tests/destination.test.cjs`. |
| 2 | Resolved: body reads and fetch failures share the bounded network retry path; complete invalid JSON fails without retrying. | Partial response recovery, exhausted transfers with the original cause, malformed JSON, and timeout/cancellation during body reading. |
| 3 | Resolved: distributive answer mapping returns `Answer` for dynamic questions and precise types for literal questions. | `tests/types.test.ts`, included in `npm run typecheck`, checks union equality, narrowing, literal and `satisfies` inference, and invalid property accesses. |
| 4 | Resolved: request JSON validation tracks ancestors and rejects cycles with `INVALID_REQUEST`. | Circular objects, arrays, instructions, and criteria are rejected before fetch; shared references remain valid. |
| 5 | Resolved: construction and CAP initialization reject timeouts above 2,147,483,647 ms. | Both overflow values fail, the maximum is accepted, and CAP connection rejects invalid durations. |
| 6 | Resolved: HTTP retry delays are compared with the remaining deadline; delays that cannot fit preserve `HTTP_ERROR`, status, and provider code immediately. | Retry-After within budget retries; long delays for 429 and 529 fail promptly; network retries still obey one deadline. |
| 7 | Resolved: request content accepts plain/null-prototype objects and arrays; other objects fail with `INVALID_REQUEST`. | Map, Set, Date, and class instances in state, instructions, and criteria fail before fetch; valid JSON is serialized intact. |
| 8 | Resolved: `HTTP_ERROR` omits the response cause. | HTTP errors retain status/provider code and have `cause === undefined`. |
| 9 | Resolved: fixture installation uses `--prefer-offline`; every child process and the integration test have timeouts. | Full suite passes with an initially empty npm cache. |
| 10 | Implemented: `.github/workflows/ci.yml` checks Node 22, 24, and 26 on pushes and pull requests, with read-only permissions and a job timeout. | Local checks are recorded below; the first hosted GitHub Actions result is pending. |

Verification on 2026-10-20:

| Runtime | Lint | Typecheck | Build | Tests | Package dry run |
| --- | --- | --- | --- | --- | --- |
| Node 26.12.0 | Pass | Pass, including compile-time regressions | Pass | 34/34; also 34/34 with an empty npm cache | Pass; 13 intended files, no test artifacts |
| Node 22.23.3 | Pass | Pass, including compile-time regressions | Pass | 34/34 | Pass; 13 intended files, no test artifacts |

The release version is 0.3.0 because stricter request validation and the changed Retry-After error behavior affect callers. Migration details are in [CHANGELOG.md](CHANGELOG.md) and [README.md](README.md).

## Resolved runtime findings

### 1. [P2] Mutable settings bypass the token transport check

**Location:** `src/transport.ts:139–176, 240` (`SystemOneTransport` constructor and `decide`).

The constructor retains the caller's settings object and validates the endpoint using the token present at construction. Each call then reads the token from that mutable object without repeating the transport check.

**Reproduction:** Construct a transport with `timeoutMs: 1000` and `credentials.url: "http://example.com"`, without a token. Then assign `settings.credentials.token = "test-token"` and call `decide()`. The request sends `Authorization: Bearer test-token` to the HTTP endpoint instead of rejecting with `INVALID_CONFIG`.

The same applies to `destination` and `model`, which `target()` and `decide()` also read from the live object (`src/transport.ts:185, 233`). Removing `credentials.destination` after constructing a destination-based transport leaves `this.url` undefined; `fetch(undefined)` then fails and, after retries, surfaces as a misleading `NETWORK_ERROR`.

**Reproduction:** Construct a transport with `timeoutMs: 1000` and `credentials.url: "http://example.com"`, without a token. Then assign `settings.credentials.token = "test-token"` and call `decide()`. The request sends `Authorization: Bearer test-token` to the HTTP endpoint instead of rejecting with `INVALID_CONFIG`. (Reconfirmed on Node 26.12.0.)

**Requested change:** Snapshot the validated `token`, `destination`, `model`, and endpoint at construction, and read only the snapshot afterwards. Preserve destination resolution on each call so the SDK continues to control caching.

**Acceptance:** A test mutates the original settings (adding a token, removing or adding a destination, changing the model) after construction and proves that the transport behaves as configured at construction and that no token is sent to a non-loopback HTTP endpoint. HTTPS and loopback HTTP authentication must continue to work.

### 2. [P2] Connection resets during response reading are not retried

**Location:** `src/transport.ts:276–281` (`response.json()` error handling).

Only failures from `fetch()` enter the network retry path. Once headers have arrived, an interrupted response body is classified as invalid JSON and fails immediately, even though the retry policy includes network errors.

**Reproduction:** A local server returns HTTP 200, writes a partial JSON body, and destroys the response socket. `decide()` makes one request and throws `INVALID_RESPONSE` with a `TypeError: terminated` cause. A second request that would have succeeded is never made.

**Requested change:** Distinguish response transfer failures from JSON syntax failures and retry the former within the existing attempt limit and overall deadline. Preserve the underlying cause and release failed response bodies. A straightforward split: read the body with `response.text()` and treat a failure there as a network error, then parse with `JSON.parse` and treat a failure there as `INVALID_RESPONSE`.

**Acceptance:** Tests cover a partial response followed by a successful retry, exhausted response transfer failures returning `NETWORK_ERROR`, malformed complete JSON returning `INVALID_RESPONSE` without retry, and cancellation or timeout during response reading.

### 3. [P2] Dynamic question maps have incorrect answer types

**Location:** `src/types.ts:44–45` (`Answers<Q>`).

For `Answers<Questions>`, the indexed type is the `Question` union. The conditional does not distribute over that union, so every answer resolves to `NoulAnswer`. This affects callers that use `Questions` or `DecisionRequest` for dynamically built maps, even though those maps can contain choice and score questions.

**Reproduction:** Declare `const questions: Questions`, call `decide({ state, questions })`, and narrow an answer with `answer.type === 'choice'`. TypeScript reports that `"noul"` and `"choice"` have no overlap; accessing `answer.choice` then fails because the narrowed type is `never`.

**Requested change:** Use a distributive helper to map each question type to its answer type, for example `type AnswerFor<T> = T extends ChoiceQuestion ? ChoiceAnswer : T extends ScoreQuestion ? ScoreAnswer : T extends NoulQuestion ? NoulAnswer : never`. Broad question maps should return the `Answer` union, while literal question maps should retain their precise answer types.

**Acceptance:** Compile-time coverage verifies choice, score, and noul narrowing for `Answers<Questions>`, plus precise inference for literal maps and maps declared with `satisfies Questions`.

### 4. [P2] Circular input escapes validation as RangeError

**Location:** `src/validation.ts:7–15` (`content` and `json`).

The recursive JSON validator has no cycle detection. Circular state, instructions, or criteria can overflow the stack instead of producing the documented `SystemOneError('INVALID_REQUEST')`.

**Reproduction:** Set `state.self = state` and pass that object to `decide()`. Validation throws a native `RangeError` without a System One error code.

**Requested change:** Detect cycles during JSON validation and reject them with `INVALID_REQUEST`. Allow shared references that do not form a cycle, since they can be serialized as JSON. Fix together with finding 7, which touches the same validator.

**Acceptance:** Tests cover circular objects and arrays in request content, confirm that no network request is sent, and preserve acceptance of valid content with shared references.

### 5. [P3] Timeout validation accepts values the runtime rejects

**Location:** `src/transport.ts:178–180, 235` (timeout validation and `AbortSignal.timeout`).

The constructor accepts any positive safe integer, but the runtime timer API supports a smaller range. Invalid durations therefore survive startup validation and fail at the first decision call.

**Reproduction:** Configure `timeoutMs: 2 ** 32` with a valid endpoint. Construction succeeds, then `decide()` throws a native `RangeError` with code `ERR_OUT_OF_RANGE` instead of `SystemOneError('INVALID_CONFIG')`.

**Worse case:** `AbortSignal.timeout()` accepts values up to 2³²−1, but Node's timers cap delays at 2³¹−1 ms. Above that, Node emits `TimeoutOverflowWarning` and sets the timeout to 1 ms. With `timeoutMs` between `2 ** 31` and `2 ** 32 - 1`, construction succeeds and every `decide()` call immediately fails with `TIMEOUT`. Verified on Node 26.12.0: `AbortSignal.timeout(2 ** 31)` is aborted within 50 ms. `pause()` uses `setTimeout` with the same limit.

**Requested change:** Reject `timeoutMs > 2_147_483_647` during construction with `INVALID_CONFIG`.

**Acceptance:** `2 ** 31` and `2 ** 32` fail construction and CAP connection with `INVALID_CONFIG`; `2_147_483_647` is accepted; normal durations retain the overall deadline behavior.

### 6. [P3] Retry-After beyond the deadline masks rate limiting as a timeout

**Location:** `src/transport.ts:254–261` (retry pause).

The retry pause is capped at the full `timeoutMs`, not at the time remaining before the deadline. When a provider answers 429 with a `Retry-After` that exceeds the remaining budget, the call sleeps until the deadline fires and throws `TIMEOUT`. The caller never sees the 429 and cannot distinguish rate limiting from a slow provider.

**Reproduction:** A local server answers 429 with `Retry-After: 60`; `timeoutMs` is 200. `decide()` waits about 200 ms and throws `TIMEOUT` instead of `HTTP_ERROR` with `status: 429`.

**Requested change:** Track the deadline as a timestamp. If the computed retry delay does not fit in the remaining time, release the body and throw `HTTP_ERROR` with the response status and provider code immediately instead of waiting.

**Acceptance:** A test with a `Retry-After` beyond the deadline receives `HTTP_ERROR` 429 without waiting for the deadline; a `Retry-After` within the deadline still retries. Update the existing "caps it at the overall deadline" test accordingly.

### 7. [P3] Non-plain objects are accepted and silently lose data

**Location:** `src/validation.ts:3–4, 15` (`record` and `json`).

`record()` accepts any non-array object. For `Map`, `Set`, and class instances, `Object.values()` returns no or only some properties, so validation passes, yet `JSON.stringify` sends `{}` or a different shape. State placed in a `Map` reaches the provider empty and the model decides on missing data without any error.

**Reproduction:** Call `decide({ state: { items: new Map([["a", 1]]) }, questions })`. Validation passes and the request body contains `"items":{}`.

**Requested change:** In request content validation, accept only plain objects (prototype `Object.prototype` or `null`) and arrays. Reject other objects with `INVALID_REQUEST`. Implement together with the cycle detection from finding 4.

**Acceptance:** Tests reject `Map`, `Set`, and class instances in state, instructions, and criteria without a network request, and continue to accept plain and null-prototype objects.

### 8. [P3] HTTP errors carry the Response object as cause

**Location:** `src/transport.ts:270–274`.

`HTTP_ERROR` sets `cause: response`. The body has already been consumed or cancelled, so the object adds no information beyond `status` and `providerCode`. When CAP or the application logs the error, the inspected `Response` prints the endpoint URL and all response headers, which may include cookies or provider-internal headers.

**Requested change:** Omit the cause for `HTTP_ERROR`; `status` and `providerCode` already identify the failure.

**Acceptance:** A test asserts that an `HTTP_ERROR` has no `Response` cause and still exposes `status` and `providerCode`.

## Formerly deferred tooling findings

These findings were excluded from the previous implementation brief. Both now have implementations, with hosted CI execution still pending as noted above.

### 9. Integration test depends on a warm npm cache and has no timeout

**Location:** `tests/cap-integration.test.cjs:39–47, 72–105`.

The fixture installation uses `npm install --offline`, so a fresh CI environment without cached dependencies can fail before testing the plugin. The test and its child processes also have no explicit timeout.

**Suggested follow-up:** Make fixture dependency installation work in a fresh environment and bound the test and child-process execution times.

### 10. No CI workflow

The repository has local lint, typecheck, test, and packaging commands but no CI workflow to enforce them.

**Suggested follow-up:** Add a GitHub Actions workflow that runs the checks on supported Node versions, including Node 22 and 24. Address the integration test's cache dependency before relying on a fresh CI runner.
