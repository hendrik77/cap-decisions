# 8. Rename to `cap-decisions`

**Date:** 2026-10-28
**Status:** Proposed

## Context

The package started as `cap-jev`, a CAP client for TypeSafe's Jev model behind the System One API. Its names followed: the required service `systemone`, the kinds `systemone-<provider>`, the facet `cds add systemone`, the classes `SystemOneService` and `SystemOneError`.

By 0.9.2 the package serves several decision models of several providers: TypeSafe Jev, a self-hosted Laya, Cloudflare Clef and SubQ Snap, plus any server that speaks the same protocol and any provider package with its own kind. Three things make the old names a poor fit:

- **The industry term.** The models are called decision models, and the providers call their endpoints decision APIs (SubQ's is the "Decisions API"). "Jev" and "System One" are the name of one model and one product.
- **Several providers.** A Cloudflare or SubQ user configures a kind called `systemone-cloudflare` or `systemone-subq` and imports `SystemOneService`, which suggests a dependency on TypeSafe that does not exist. The package also reads as affiliated with TypeSafe, which it is not.
- **The vocabulary of SAP users.** CAP developers know "decisions" from SAP's own tools, such as the decisions of SAP Build Process Automation. `cds.connect.to('decisions')` and `cds add decisions` say what the service does without knowing the model behind it.

The package is not published on npm and has no known users outside its maintainer. [ADR 0006](0006-public-api-for-1.0.md) fixes the public names for 1.0.0, so a rename is cheap now and expensive after 1.0.0.

## Options considered

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** Keep `cap-jev` | No work; the names keep pointing at one model and one product, and 1.0.0 freezes them | Rejected |
| **B.** Rename to `cap-decisions` in 0.10.0, without aliases | One breaking minor release before 1.0.0; old configurations are detected and reported, not supported | **Selected** |
| **C.** Rename with aliases: also read `cds.requires.systemone`, keep `systemone-<x>` kinds and `SystemOne…` exports as deprecated names | No break for existing apps, but two names for everything in the code, the docs and the 1.0.0 API, for a package without users | Rejected |
| **D.** Another name, such as `cap-decision-models` or `cap-system-one` | `cap-decision-models` is longer without saying more; `cap-system-one` keeps the product name | Rejected |

## Decision

1. **The package** is `cap-decisions`, version 0.10.0, with the bin `cap-decisions-mock` and the entry points `cap-decisions/mock-server`, `cap-decisions/testing` and `cap-decisions/providers/*`. The release archive is `cap-decisions-<version>.tgz`, and the repository becomes `github.com/hendrik77/cap-decisions`.
2. **The configuration**: the service `decisions` (`cds.requires.decisions`, `cds.connect.to('decisions')`), the facet `cds add decisions`, the kinds `decisions-<provider>`, the environment variables `CDS_REQUIRES_DECISIONS_*` and `CAP_DECISIONS_MOCK_TOKEN`, the log channel `decisions` and the mock's default fixture file `test/data/decisions.json`.
3. **The TypeScript names**: `DecisionsService`, `DecisionsError`, `DecisionsErrorCode`, `DecisionsSettings`, `DecisionsCredentials`. `DecisionsError` carries the brand `Symbol.for('cap-decisions.DecisionsError')`.
4. **What stays**: the wire format, called the Jev protocol: the request and response schema, the question types `noul`, `choice` and `score`, and the default path `/v1/systemone` of the mock server, which matches TypeSafe's and SubQ's endpoints. The names `DecisionRequest`, `DecisionResult`, `DecisionOptions`, `DecideOptions`, `decide()` and the error codes were already neutral and stay. "Jev" and "System One" remain in the documentation where they mean the protocol, the model or TypeSafe's product.
5. **No aliases.** The old names are not read. `cds-plugin.js` logs an error on the `decisions` channel when `cds.requires.systemone` is set, pointing to the 0.10.0 entry of the changelog, so an old configuration does not silently fall back to the defaults.
6. **History stays.** ADRs 0001 to 0007, the completed plans and the changelog entries up to 0.9.2 keep the names of their time; only links that the rename would break are fixed.

## Consequences

- Applications on `cap-jev` 0.9.x migrate by hand, following the table in the 0.10.0 changelog entry. The package has no known users, so the README has no migration section.
- Provider packages built against `cap-jev` update their peer dependency to `"cap-decisions": ">=0.10.0"`, their imports, their base class and their kind names. Because the brand symbol changed, a `cap-jev` copy and a `cap-decisions` copy in one app do not recognise each other's errors with `instanceof`; such a mix is not supported.
- The maintainer renames the GitHub repository; GitHub redirects the old URLs, including the archives of the `cap-jev` releases. The npm name `cap-decisions` is reserved with the publication method of ADR 0009 (formerly planned as ADR 0008).
- ADR 0006 lists the public names for 1.0.0; when it is accepted, it uses the new names.
