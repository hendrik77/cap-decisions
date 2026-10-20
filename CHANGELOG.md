# Changelog

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
