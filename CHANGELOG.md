# Changelog

## 0.2.0

### Breaking changes

- The package no longer supplies a TypeSafe endpoint URL. Configure `cds.requires.systemone.credentials.url` before connecting. This prevents an unconfigured app from sending state to an external service.
- The package no longer supplies a default model. Set `model` explicitly if the endpoint needs one.
- `timeoutMs` now covers the complete call, including retries. Increase it if an application relied on a separate timeout for each attempt.
- Invalid configuration now fails during `cds.connect.to('systemone')`. Handle startup failures there instead of at the first `decide()` call.
- CommonJS `require('cap-jev')` now returns a module object. Use `require('cap-jev').SystemOneService` or `.default` where code previously treated the require result as a class.

Further 0.2.0 migration notes will be added as the review implementation proceeds.
