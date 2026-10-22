# Plan: `cds add systemone` (0.8.0)

Written on 2026-10-21 against `main` at v0.7.1 (`4da7d58`). It continues the [0.7 plan](http-mock-server-and-release-automation.md).

`cap-jev` still has no users: it is development-only and unpublished on npm. Changes need no migration code, deprecation period or compatibility shims.

The reasoning lives in [ADR 0005: `cds add systemone` facet in the plugin](../../decisions/0005-cds-add-facet.md), accepted when 0.8.0 is merged. Its context section records the probe of CAP's `cds add` interface on `@sap/cds-dk` 9 and 10.

Completed with 0.8.0; the road after it continues in [the hardening plan](../hardening-for-1.0.md).

## Contents

- [Starting point](#starting-point)
- [How the work is done](#how-the-work-is-done)
- [0.8.0: `cds add systemone`](#080-cds-add-systemone)
- [After 0.8.0](#after-080)
- [Progress](#progress)
- [Blocked tests](#blocked-tests)

## Starting point

- An application configures `cap-jev` by hand: `"[production]": { "kind": "<kind>" }` under `cds.requires.systemone`, a token in `.cdsrc-private.json` or the platform, and `.cdsrc-private.json` in `.gitignore`. The example app (`examples/cap-app/package.json`) shows the result for `systemone-laya`.
- A base-level `kind` turns the mock off in `development` and `test`; the activation table in `docs/local-development.md` explains it, but nothing prevents it.
- `cds-plugin.js` only logs an error for `cds.requires.systemone.model`. It runs for every `cds` command and must never throw.
- `@sap/cds-dk` is not a dependency; CI installs only `@sap/cds` (9 or 10).

## How the work is done

As for 0.7.0 (see [the 0.7 plan](http-mock-server-and-release-automation.md#how-the-work-is-done)):

- **Worktree.** The release branch `release-0.8.0` is checked out in its own worktree (`.claude/worktrees/release-0.7.0`, reused), so `main` stays untouched until the merge.
- **Subagents** (Sonnet) take the tasks marked *agent*, one at a time in the worktree. The main session reviews each result, runs the full suite and commits.
- **Red, then green.** Tests first; they must fail for the expected reason. A test that still fails after five attempts is marked `{ todo: 'BLOCKED: <reason>' }` and listed under [Blocked tests](#blocked-tests).
- **Patch releases.** Problems found after 0.8.0 is released go into 0.8.1 and so on, before 0.9.0 starts.
- **The release reviews and updates all Markdown files**: `README.md`, `CHANGELOG.md`, `AGENTS.md`, `docs/*.md`, `examples/*/README.md`, the ADRs and the plans, each read against the code, not only the sections the facet touches (task F3).

Definition of done, in addition to the earlier plans: `cds-plugin.js` never throws and loads no facet code outside `cds add`; the planner imports no CAP code and touches no files; the tests run the real `cds add` of `@sap/cds-dk` 9 and 10.

## 0.8.0: `cds add systemone`

Goal: `cds add systemone` sets up an application for production without turning off the mock in development, and without putting a secret into a committed file.

### Target behaviour

```sh
npm install <cap-jev archive or package>
cds add systemone                                # systemone-laya in production
cds add systemone --kind systemone-typesafe      # plus a token placeholder
cds add systemone --kind systemone-laya --with-fixtures
cds add systemone --kind systemone-typesafe --for hybrid
```

| Option | Meaning |
| --- | --- |
| `--kind <kind>` | The kind to use in the target profile. Default `systemone-laya`. Must be an installed kind (from `cds.env.requires.kinds`: the plugin's kinds and those of provider packages). Refused: `systemone-defaults`, and any kind whose resolved `impl` is the mock (`cap-jev/providers/mock`). An unknown or refused kind fails and lists the selectable kinds |
| `--for <profile>` | CAP's global option. The target profile; default `production` |
| `--force` | CAP's global option. Replaces a different kind in the target profile and an existing fixture file. Never replaces credential values |
| `--with-fixtures` | Writes the example `test/data/systemone.json` |

Files, with `P` the target profile:

| File | Change |
| --- | --- |
| `package.json` | `cds.requires.systemone["[P]"].kind = <kind>`. Creates the `cds` section as needed. Other keys and the file's indentation stay as they are |
| `.cdsrc-private.json` | Only when the resolved kind has `requiresToken: true`: `requires.systemone["[P]"].credentials.token = ""` if no token is set there yet. Created if missing |
| `.gitignore` | When `.cdsrc-private.json` is written or exists: the line `.cdsrc-private.json` is appended unless a line equal to `.cdsrc-private.json` or `/.cdsrc-private.json` is present. Created if missing. Globs are not evaluated |
| `test/data/systemone.json` | Only with `--with-fixtures`: two rules, one fixed answer and one simulated failure, that the mock's fixture parser accepts. Kept if it exists, unless `--force` |

Existing configuration, read from the application's own `package.json` (never from `cds.env.requires.systemone`, which shows the mock because `cds add` runs in `development`):

| Found | Result |
| --- | --- |
| Nothing | Writes the kind |
| The same kind in `[P]` | No change; prints that it is already configured |
| A different kind in `[P]` | No change, prints the kept kind and that `--force` replaces it; with `--force`, writes the new kind |
| A base-level `cds.requires.systemone.kind` | No change to it. Prints that it applies to every profile and turns off the mock in `development` and `test`, and how to move it into a profile. The kind in `[P]` is still written as above |
| A `credentials.token` in `.cdsrc-private.json` `[P]` | Kept, also with `--force` |

Messages go to stdout, one line each, prefixed `[systemone]`, and end with the next steps: fill in the token (with the file name) when a placeholder was written, set `credentials.url` when the kind has no URL (as for `systemone-generic`), and how to try it locally (`npx cap-jev-mock` with `CDS_ENV=<P>` for kinds with a URL on `127.0.0.1`). An error (Java project, unknown or refused kind, unreadable or invalid `package.json`, `.cdsrc-private.json` or `.gitignore`) is thrown as a string, which `cds add` prints without a stack trace, and nothing is written.

A second run with the same options changes nothing.

### Tasks

#### F1 Planner (*agent*, red-green)

File: `src/add-core.ts` (no CAP imports, no `node:fs`). Not exported in `package.json`.

1. `planSystemOne(input)` with `input = { packageJsonText, cdsrcPrivateText, gitignore, fixturesExist, kinds, options: { kind?, for?, force?, withFixtures? } }`: the three file inputs are the raw texts or `undefined` for a missing file, `kinds` is `cds.env.requires.kinds`. Returns `{ writes: [{ file, content }], messages: string[] }`; `content` is the full new file text (JSON with the original indentation, detected from the input text, and a final newline). Throws `Error` with the user message for every error in the target behaviour.
2. `resolveKind(kinds, name)`: follows `kind` references (with a cycle guard) and deep-merges the settings, as CAP does, to read `requiresToken`, `impl` and `credentials.url`.
3. `exampleFixtures()`: the rule file content.
4. Tests first (`tests/add-core.test.cjs`, against `dist/add-core.js`): every row of the option, file and existing-configuration tables; the refused kinds and the message listing the selectable kinds; a provider-package kind (`kind: 'systemone-generic'` plus own settings) with and without `requiresToken`; indentation of 2, 4 and tabs is kept; a second plan on the result writes nothing; the example fixtures load with `parseFixtures` from `dist/providers/mock-fixtures.js` and the failure rule produces its error through `mockDecision`; the module loads without `@sap/cds` (check `require.cache` in a child process).

#### F2 Facet and registration (*agent*, red-green)

Files: `src/add.ts` (the facet class, `extends cds.add.Plugin`, CommonJS `export =`), `cds-plugin.js`, `package.json` (`@sap/cds-dk` `^10` as a development dependency), `.github/workflows/ci.yml` (the CAP 9 step installs `@sap/cds@^9 @sap/cds-dk@^9`).

1. Facet: `static help()` returns a one-line description; `options()` returns `kind` (string) and `with-fixtures` (boolean) with help texts; `run()` refuses Java projects (`cds.add.readProject().isJava`), reads the four inputs relative to `cds.root`, calls `planSystemOne` with `cds.env.requires.kinds` and `cds.cli.options`, writes the files (creating `test/data`), and prints the messages. A local minimal type for `cds.add` and `cds.cli`, since `@cap-js/cds-types` has none.
2. `cds-plugin.js`: when `cds.cli?.command` is `add` or `help` (`cds add --help` runs as `help`) and `typeof cds.add?.register === 'function'`, register `require('./dist/add.js')` as `systemone`, inside `try`; a failure logs one error through `cds.log('systemone')` and does not throw.
3. Tests first, plugin (`tests/plugin.test.cjs`, child processes with a stubbed `cds.add` and `cds.cli`): registers under `add` and under `help`; does not register and does not load `dist/add.js` for other commands or without `cds.add`; a throwing `register` is logged, not thrown.
4. Tests first, command line (`tests/cds-add.test.cjs`, temporary apps from `tests/helpers/app.cjs`, `node <@sap/cds-dk>/bin/cds.js add systemone ...` in a child process): the default run; `--kind systemone-typesafe` writes the placeholder and `.gitignore`; `--for hybrid`; `--with-fixtures`; `--force`; an unknown kind exits non-zero, prints the message and writes nothing; a second run changes nothing; `cds add --help` lists the facet and `--kind`; after the run, the app connects in development to the mock and in production to the kind (with the HTTP mock server for `systemone-laya`, with `INVALID_CONFIG` for the empty TypeSafe token); a provider package's kind, linked as in `tests/extension.test.cjs`, is selectable.
5. `tests/cap-integration.test.cjs`: after installing the packed archive, `cds add systemone` works in the copy of the example app (checks that `dist/add.js` is in the archive).

#### F3 Documentation review for 0.8.0 (*agent* draft, *main* review)

Every Markdown file is read against the code and updated, not only for the facet:

1. `README.md`: installation continues with `cds add systemone`; the manual configuration stays as the alternative; the stability table lists the facet (experimental); the development section lists the new tests and the `@sap/cds-dk` dependency.
2. `docs/local-development.md`: the activation table mentions what `cds add systemone` writes; fixtures mention `--with-fixtures`.
3. `docs/providers.md`: a provider package's kind is selectable with `cds add systemone --kind`.
4. `examples/cap-app/README.md` and `examples/provider-package/README.md`: the setup steps, as far as they apply.
5. `AGENTS.md`: structure (`src/add.ts`, `src/add-core.ts`, the second job of `cds-plugin.js`), testing (`tests/add-core.test.cjs`, `tests/cds-add.test.cjs`, the CAP 9 command with `@sap/cds-dk@^9`).
6. `CHANGELOG.md` 0.8.0; ADR 0005 accepted; this plan's progress; links checked.

#### F4 Release 0.8.0 (*main*)

1. Version 0.8.0 everywhere `release:check` checks; full checks; CAP 9 run with `@sap/cds-dk@^9`; `npm pack --dry-run` contains `dist/add.js` and `dist/add-core.js`.
2. Pull request, green CI, merge commit, tag `v0.8.0`, push the tag; the workflow creates the release.
3. Smoke test: a fresh app from the published archive; `npx cds add systemone` writes the production kind; the app answers in development from the mock and in production through `npx cap-jev-mock`; `cds add systemone --kind systemone-typesafe` writes the placeholder and `.gitignore`.

## After 0.8.0

0.9.x (hardening) and 1.0.0 (npm publication) continue in [the hardening plan](../hardening-for-1.0.md).

## Progress

| Task | Status |
| --- | --- |
| F1–F4 | Released in 0.8.0 |

### Found during the work

- `cds add --help` runs as the command `help`, not `add`. It loads the plugins, so `cds-plugin.js` registers the facet for `help` as well; otherwise `cds add --help` would not list `systemone` and its options. Other commands still load no facet code.
- With npm 12 or later, which blocks install scripts, `npm install --no-save @sap/cds@^9 @sap/cds-dk@^9` leaves `better-sqlite3` of `@sap/cds-dk` 9 without its native binding, and the example-app tests hang. Running `npx --no-install prebuild-install` in `node_modules/better-sqlite3` fixes it. `npm install` restores CAP 10 afterwards. `AGENTS.md` and the README describe both.
- The planner takes the raw texts of `package.json` and `.cdsrc-private.json` (`packageJsonText`, `cdsrcPrivateText`), not parsed objects, because it keeps their indentation and line endings.
- The task F3 review found install commands in both READMEs that named `cap-jev-0.6.0.tgz` after downloading 0.7.1. They are corrected, `npm run release:check` now fails on an archive file name with another version, and `AGENTS.md` lists the file names among the places to update.

## Blocked tests

None.
