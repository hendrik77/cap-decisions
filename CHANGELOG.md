# Changelog

## 0.4.3

### Added

- Exported `SystemOneErrorCode`, the union of all `SystemOneError` codes, and `DecisionOptions`, the options type of `SystemOneTransport.decide()`. `SystemOneError.code` now uses the union, so comparisons with undocumented codes fail type-checking; runtime behaviour is unchanged.
- The example application handles `SystemOneError` codes as HTTP responses, rejects empty messages with 400, checks its queue map against the inferred choice labels, and has a README and `start` script. The integration test now calls its `classify` action.

### Documentation

- The README lists every error code, including `NETWORK_ERROR` and `PROVIDER_ERROR`, and describes the answer fields for each question type.
- Installation uses the release archive URL directly. Code examples no longer redeclare `result`.

## 0.4.2

### Removed

- Removed the completed review and implementation plan documents (`REVIEW.md`, `PLAN.md`) from the repository. Their findings are resolved and recorded in the 0.3.0 to 0.4.1 entries; the files remain in Git history. The published package contents are unchanged.

## 0.4.1

### Fixed

- Optional criteria keys no longer claim a guaranteed probability: for `criteria: { billing: string; technical?: string }`, `answer.probabilities.technical` is `number | undefined`. `ChoiceAnswer` takes an optional second type parameter naming the optional labels.

### Documentation

- 0.4.0 notes now list its compile-time breaking changes, and the README explains that runtime validation uses the criteria keys actually sent.

## 0.4.0

### Breaking changes

- Compile-time only: code that compares `answer.choice` with, assigns, or reads probabilities for labels not declared in the question's criteria no longer type-checks. Runtime behaviour is unchanged. Annotate with the default `ChoiceAnswer` or type the question map as `Questions` to keep `string` labels.

### Added

- Choice answers infer exact labels from each question's criteria: `answer.choice` is now a literal union such as `'billing' | 'technical'`, and `answer.probabilities` uses the same keys. This supports exhaustive handling and catches misspelled labels at compile time.
- Exported `ChoiceAnswer<Label>` allows explicit label unions; its default remains `string` for existing annotations and dynamically built question maps. Numeric criteria keys become string labels to match the JSON protocol.
- Compile-time coverage checks inference through the CAP service and transport, inline and `satisfies Questions` maps, readonly criteria, dynamic maps, numeric keys, and union criteria.

## 0.3.0

### Breaking changes

- Request content must be plain JSON data. Circular references, `Map`, `Set`, `Date`, and class instances now fail with `INVALID_REQUEST`; shared references and null-prototype objects remain supported.
- Retriable HTTP responses whose retry delay does not fit within the remaining deadline now fail immediately with `HTTP_ERROR`, preserving `status` and `providerCode`, instead of waiting for `TIMEOUT`.
- `HTTP_ERROR` no longer carries a `Response` as its cause, avoiding response headers and endpoint URLs in error inspection.

### Fixed

- Snapshot endpoint, token, destination, and model settings at construction so later configuration mutations cannot bypass transport validation. Destinations are still resolved on each call.
- Reject `timeoutMs` above Node's timer limit of 2,147,483,647 ms during construction and CAP connection.
- Retry interrupted response bodies within the existing attempt limit and call deadline, preserving the network cause. Complete malformed JSON is not retried.
- Return the full `Answer` union for dynamic `Questions` maps while preserving precise answer types for literal maps.

### Added

- Compile-time answer type regressions included in `npm run typecheck`.
- Integration test and child-process timeouts, and fixture installation that works with an empty npm cache.
- GitHub Actions checks on Node.js 22, 24, and 26.

## 0.2.0

### Breaking changes

- The package no longer selects TypeSafe by default. Select `kind: "systemone-typesafe"` for TypeSafe, or use the base `systemone` kind with `credentials.url` for another endpoint. This prevents an unconfigured app from sending state externally.
- `model` and `timeoutMs` moved from `credentials` to service level. Move custom values to `cds.requires.systemone.model` and `.timeoutMs`. The base kind omits `model`; provider presets supply theirs.
- `responseFormat` and `model: null` were removed. Select `systemone-cloudflare` for Cloudflare responses or `systemone-laya` to omit the model.
- The exported `SystemOneTransport` constructor now takes service settings with a nested `credentials` object and an explicit `timeoutMs`. Update direct transport callers accordingly.
- `timeoutMs` now covers the complete call, including retries. Increase it if an application relied on a separate timeout for each attempt.
- Invalid configuration now fails during `cds.connect.to('systemone')`. Handle startup failures there instead of at the first `decide()` call.
- CommonJS `require('cap-jev')` now returns a module object. Use `require('cap-jev').SystemOneService` or `.default` where code previously treated the require result as a class.

### Added

- Optional SAP BTP destination support through `credentials.destination` and `@sap-cloud-sdk/connectivity`. Use a `NoAuthentication` destination with `URL.headers.Authorization` for a static bearer token.
