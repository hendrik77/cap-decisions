# cap-jev-provider-acme

A minimal provider package for [cap-jev](../../README.md). It shows how a package adds a `systemone-<provider>` kind with its own `SystemOneService` subclass. The package is private and only used by the tests.

Acme wraps the Jev answer in `{ "data": <result> }` and addresses its API by region. The package contributes:

- the kind `systemone-acme` in the `cds` section of `package.json` (`impl` points at this package, token required, at most 20 choice options),
- `srv/acme-service.js`, a subclass that overrides `endpoint`, `unwrap` and `init`,
- `cds-plugin.js`, so that CAP discovers the package configuration.

## Use in an application

```json
{
  "dependencies": { "cap-jev": "^0.5.0", "cap-jev-provider-acme": "^1.0.0" },
  "cds": {
    "requires": {
      "systemone": { "kind": "systemone-acme", "credentials": { "region": "eu", "token": "…" } }
    }
  }
}
```

## Rules for provider packages

- Declare `cap-jev` and `@sap/cds` as peer dependencies, so that the application's single copies are used. A second copy breaks `instanceof` checks and CAP events.
- When overriding `init()`, call `await super.init()`.
- Do not reassign `this.on`; register handlers with it as usual.
- Declare extra service settings in `static settingsKeys` and extra credentials in `static credentialKeys`. Everything else is rejected or logged as unknown.
