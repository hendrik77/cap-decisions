# 5. `cds add systemone` facet in the plugin

**Date:** 2026-10-21
**Status:** Proposed

## Context

An application that installs `cap-jev` gets the mock in `development` and `test` and the generic kind, without a URL, in production. To go to production it has to write `"[production]": { "kind": "<kind>" }` into `cds.requires.systemone` by hand, add a token through `.cdsrc-private.json` or the platform, and keep that file out of Git. The README describes this, but every step is manual, and the most common mistake is a base-level `kind`, which turns the mock off in development (see [When the mock is active](../local-development.md#when-the-mock-is-active)).

CAP's command line has a plugin interface for `cds add` in `@sap/cds-dk` ([`cds add` plugin API](https://cap.cloud.sap/docs/tools/apis/cds-add)). A probe on 2026-10-21 against `@sap/cds-dk` 9.9.6 with CAP 9.9.4 and `@sap/cds-dk` 10.1.0 with CAP 10.1.1 found the same interface on both:

- `cds.add` exists only when the command line of `@sap/cds-dk` runs; under `cds-serve`, `cds.test` and plain Node it is `undefined`.
- For `cds add`, the command line sets `cds.cli.command` to `add` and loads the plugins (`cds-plugin.js`) before it parses the options, so a facet registered there contributes its own options and appears in `cds add --help`.
- A facet is a class that extends `cds.add.Plugin` and is registered with `cds.add.register(name, class)`. `options()` returns `{ name: { type, help, short? } }`. `run()` reads `cds.cli.options` (including the global `--for` and `--force`).
- `cds add` runs in the `development` profile. `cds.env.requires.kinds` contains the kinds of all installed plugins, but `cds.env.requires.systemone` shows the mock, not what the application configured.
- `cds.add.merge(...).into(file)` keeps existing values; it cannot report what it kept.
- `.cdsrc-private.json` is loaded in every profile and honours profile sections such as `[production]`. CAP's own `.gitignore` template lists it.

## Options considered

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** Documentation only | No new code; the manual steps and the base-level `kind` mistake stay | Rejected |
| **B.** An own command, such as `npx cap-jev init` | Works without `@sap/cds-dk`, but is a second command line outside CAP's conventions (`--for`, `--force`, `cds add --help`) | Rejected |
| **C.** A `systemone` facet registered from `cds-plugin.js` through `cds.add.register` | The CAP way to set up a plugin; one command next to `cds add hana` or `cds add xsuaa`; no new dependency at runtime | **Selected** |

## Decision

1. **`cds add systemone`** is a facet in `cap-jev`. `cds-plugin.js` registers it only when `cds.cli.command` is `add` and `cds.add.register` is a function. Registration is wrapped so that `cds-plugin.js` never throws; other commands and the runtime never load the facet code.
2. **A pure planner** (`src/add-core.ts`, no CAP imports, no file access) takes the parsed files and options and returns the files to write and the messages to print. The facet (`src/add.ts`) reads and writes the files. The planner reads the application's own `package.json`, never the resolved `cds.env.requires.systemone`.
3. **The production kind goes into a profile.** The facet writes `cds.requires.systemone["[production]"].kind`, so the mock stays active in `development` and `test`. `--kind` selects the kind (default `systemone-laya`); `--for <profile>` selects another profile. The kind must be one of the installed kinds; `systemone-defaults` and the mock are refused.
4. **Nothing existing is overwritten without `--force`**, and existing credentials never are. A kind that needs a token gets an empty `credentials.token` placeholder in `.cdsrc-private.json` in the same profile; an empty token counts as missing, so connecting fails with `INVALID_CONFIG` until a real one is set. `.cdsrc-private.json` is added to `.gitignore`.
5. **`--with-fixtures`** writes an example `test/data/systemone.json`.
6. **Tests use the real command line.** `@sap/cds-dk` becomes a development dependency. CI installs the `@sap/cds-dk` major that matches the CAP major.
7. The facet and its options are **experimental** until 1.0.0.

## Consequences

- Setting up production is `npm add cap-jev` (or the release archive), then `cds add systemone --kind <kind>`, then the token.
- `cds add systemone` needs `@sap/cds-dk`, as every `cds add` does. Without it, the manual configuration in the README still works.
- `cds-plugin.js` gains a second job; its rule that it never throws now covers the registration.
- The development dependency on `@sap/cds-dk` makes `npm ci` larger; the published package is unchanged.
- After npm publication, `cds add systemone -p cap-jev` installs the package and runs the facet in one step.

## References

- [Plan](../plans/cds-add-systemone.md), tasks F1–F4
- [ADR 0001: Provider kinds as CAP service subclasses](0001-provider-kinds-as-cap-service-subclasses.md), [ADR 0002: In-process mock provider](0002-in-process-mock-provider.md)
- CAP: [`cds add` plugin API](https://cap.cloud.sap/docs/tools/apis/cds-add), [profiles](https://cap.cloud.sap/docs/node.js/cds-env#profiles)
