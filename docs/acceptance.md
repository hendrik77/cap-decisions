# Acceptance runs

Before 1.0.0, every built-in HTTP kind passes an acceptance run against its real model or server (task H10 of the [hardening plan](plans/hardening-for-1.0.md)). The maintainer runs them by hand with [`scripts/acceptance.cjs`](../scripts/acceptance.cjs) on a release archive and records the results here. The user acceptance test (H13) comes afterwards and has its own section.

The script is not part of the package. Its own tests, in [`tests/acceptance-script.test.cjs`](../tests/acceptance-script.test.cjs), run it against the HTTP mock server for all five kinds, so it is tested before it meets a real model.

## Targets

| Target | Kind | Model | What you need |
| --- | --- | --- | --- |
| TypeSafe Jev | `decisions-typesafe` | `jev-latest` | a TypeSafe API token |
| Cloudflare Clef | `decisions-cloudflare` | `clef` | the account ID and an account-owned token with only **Workers AI – Read** and **Workers AI – Edit** |
| Local Laya | `decisions-laya` | the server's | a [Laya server](https://github.com/WhoIsMrSentry/laya-system-one#self-hosting-http-server-jev-compatible) on `http://127.0.0.1:8000/v1/systemone` |
| Local Jev model | `decisions-generic` | the server's | a Jev-compatible server on the machine, and its full POST URL |
| SubQ Snap | `decisions-subq` | `subq-snap-preview` | a SubQ API key with credits; a request without credits fails with `HTTP_ERROR` 402 |

Every target also needs Node.js 22.18 or newer and network access to the npm registry, because the script installs `@sap/cds` and `@sap/cds-dk` into a fresh app.

## Running

Download the release archive, then run the script from the repository root, once per target. The token comes only from the environment variable `CAP_DECISIONS_ACCEPTANCE_TOKEN`; the script refuses a token argument, passes the token to its child processes through their environment and never prints it or writes it to a file.

```sh
curl -fLO https://github.com/hendrik77/cap-decisions/releases/download/v<version>/cap-decisions-<version>.tgz

# TypeSafe Jev
CAP_DECISIONS_ACCEPTANCE_TOKEN=<token> node scripts/acceptance.cjs --kind decisions-typesafe --archive cap-decisions-<version>.tgz

# Cloudflare Clef
CAP_DECISIONS_ACCEPTANCE_TOKEN=<token> node scripts/acceptance.cjs --kind decisions-cloudflare --account-id <account id> --archive cap-decisions-<version>.tgz

# Local Laya, with the server running on port 8000
node scripts/acceptance.cjs --kind decisions-laya --archive cap-decisions-<version>.tgz

# Local Jev model
node scripts/acceptance.cjs --kind decisions-generic --url http://127.0.0.1:<port>/<path> --archive cap-decisions-<version>.tgz

# SubQ Snap
CAP_DECISIONS_ACCEPTANCE_TOKEN=<key> node scripts/acceptance.cjs --kind decisions-subq --archive cap-decisions-<version>.tgz
```

To keep the token out of the shell history, read it first, for example with `read -s CAP_DECISIONS_ACCEPTANCE_TOKEN && export CAP_DECISIONS_ACCEPTANCE_TOKEN`. In PowerShell, set `$env:CAP_DECISIONS_ACCEPTANCE_TOKEN` and call `node` with the same options.

`--keep` keeps the temporary app and prints its path. The script exits with 0 when no check failed, 1 when one failed, and 2 for a usage error, which includes a token kind started without `CAP_DECISIONS_ACCEPTANCE_TOKEN`.

## The checks

Each check runs in its own Node.js process in the app, in the `production` profile, so the kind is the one `cds add decisions --kind <kind>` wrote and never the mock. Each prints one line, `pass`, `fail` or `skipped` with the reason, and API calls show their latency.

| Check | What it shows |
| --- | --- |
| `connect` | The kind's settings are valid, and the service connects |
| `missing token` | Without a token, a token kind fails with `INVALID_CONFIG` and sends nothing |
| `choice`, `score`, `noul` | Each question type comes back typed: the choice is one of the offered labels, the score is within the criteria, `noul` is between 0 and 1 |
| `several questions` | Three questions in one request come back under their ids |
| `limit …` | For each limit the kind sets, a request at the limit is answered, and one beyond it fails with `INVALID_REQUEST` before anything is sent |
| `wrong token` | A wrong token fails with `HTTP_ERROR` 401 or 403, and neither the error nor the output contains the token |
| `timeout` | `timeoutMs: 1` fails with `TIMEOUT` |
| `network error` | Local targets only: a URL where nothing listens fails with `NETWORK_ERROR` |
| `example handler` | The [example app](../examples/cap-app) serves `classify` in production and routes a refund message to `accounts` |

The run ends with a Markdown block: kind, archive, date, Node.js and CAP versions, the configured model and the model the server reports in its answers, the counts and a table of the checks. Paste it into the session; it is recorded below.

A failure caused by `cap-decisions` becomes a finding, fixed in a patch release, and the affected runs are repeated on it. A provider difference, such as another limit or a model that answers outside the offered labels, changes the kind's settings or is documented in the README. A run older than a change to the transport, the validation or a kind is repeated.

## Results

One table per target, with the columns Date, Archive, CAP, Node.js, Model or server, Result and Notes, filled from the Markdown block of each run.

### TypeSafe Jev

No run yet.

### Cloudflare Clef

No run yet.

### Local Laya

No run yet.

### Local Jev model

No run yet.

### SubQ Snap

No run yet.

## User acceptance test

The maintainer's own test of the release candidate (H13), after all five runs above have passed on it. Nothing is published to npm before it is signed off.

No test yet.
