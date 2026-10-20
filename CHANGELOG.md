# Changelog

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
