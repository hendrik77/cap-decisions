# Changelog

## 0.2.0

### Breaking changes

- The package no longer supplies a TypeSafe endpoint URL. Configure `cds.requires.systemone.credentials.url` before connecting. This prevents an unconfigured app from sending state to an external service.
- The package no longer supplies a default model. Set `model` explicitly if the endpoint needs one.

Further 0.2.0 migration notes will be added as the review implementation proceeds.
