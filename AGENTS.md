# Repository Guidelines

This repository contains the `cap-jev` TypeScript CAP plugin. Keep these conventions current as the package grows.

## Project Structure & Module Organization

- `src/`: plugin source. `index.ts` holds `SystemOneService` and the public exports, `transport.ts` is the internal HTTP transport, `validation.ts` and `types.ts` hold validation and types.
- `src/mock-server.ts`: `startMockServer`, the HTTP mock server on `node:http`, exported as `cap-jev/mock-server`. `src/mock-server-cli.ts`: its command line, the `bin` `cap-jev-mock`. Neither imports CAP code.
- `src/providers/`: provider subclasses of `SystemOneService`, one file per provider (currently `cloudflare.ts`, `mock.ts` and `subq.ts`). Each is exported through `exports` in `package.json`. The mock's pure helpers sit next to it: `mock-engine.ts` (the deterministic answer engine), `mock-fixtures.ts` (parsing and matching of fixture rules) and `mock-core.ts` (settings checks, fixture loading and the decision order, shared by `MockService` and the HTTP mock server). They import no CAP code and are not exported.
- `src/testing.ts`: the provider test kit `testProviderKind`, exported as `cap-jev/testing` (experimental). It registers `node:test` tests, runs CAP in a child process in a temporary app and a local HTTP server in the test process. It must not load `@sap/cds` when required, and `cds-plugin.js` and the other modules never require it. See `docs/decisions/0007-provider-test-kit.md`.
- `src/add.ts`: the `cds add systemone` facet (a class extending `cds.add.Plugin` of `@sap/cds-dk`, CommonJS `export =`); it reads and writes the files. `src/add-core.ts`: its pure planner (`planSystemOne`, `resolveKind`, `exampleFixtures`); it imports no CAP code, touches no files. Neither file is in `exports`.
- `scripts/`: the release scripts `release-check.cjs` and `release-notes.cjs` (CommonJS). They are not part of the package.
- `.github/workflows/`: `ci.yml` (also reusable through `workflow_call`) and `release.yml` (runs on pushed `v*.*.*` tags).
- `tests/`: Node test files. `tests/helpers/` holds the temporary-app helper (`app.cjs`) and the local fake server (`fake-server.cjs`).
- `examples/cap-app/`: the sample CAP app; it runs on the mock in development, and its fixture rules are in `examples/cap-app/test/data/systemone.json`. `examples/provider-package/`: a minimal provider package. Both are npm workspaces.
- `docs/`: guides (`providers.md`, `local-development.md`), architecture decision records in `docs/decisions/`, and plans in `docs/plans/`.
- `dist/` is generated and excluded from Git. `cds-plugin.js` must remain at the package root for CAP discovery, and it must never throw. Besides the `model` check it registers the facet (`cds.add.register('systemone', ...)`) only when `cds.cli.command` is `add` or `help` (`cds add --help` runs as `help`) and `cds.add` exists, so other commands never load `dist/add.js`.

## Build, Test, and Development Commands

Use `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, and `npm run coverage`; all are documented in the root README. `npm run coverage` builds, then runs the same test files as `npm test` with Node's coverage of `dist/**` and thresholds for lines, branches and functions (currently 98, 96 and 98 percent); the command fails when a total is below its threshold. Raise a threshold in `package.json` when a change lifts the total, never lower one to make a change pass; the 1.0.0 target is 98 / 95 / 98 at least. `npm run format` applies Prettier to `src`, `tests`, and the example handlers. `npm pack --dry-run` checks the publishable contents. `npm run release:check` checks that the version is consistent everywhere (see Releases). The plugin itself has no server; run it through a CAP application such as `examples/cap-app`. For its HTTP path, `npx cap-jev-mock` starts a local mock of a Jev server.

## Coding Style & Naming Conventions

TypeScript uses the strict `tsconfig.json` configuration and two-space indentation. JavaScript test files use CommonJS and two-space indentation. Keep source and test file names descriptive; avoid unrelated formatting changes.

## Paths

Paths in documentation and code are relative: links relative to the file, commands relative to the project root. Absolute paths, such as a path from a developer's machine, are not committed. `npm run release:check` enforces this: it fails on a path under a home, temporary or user directory (macOS, Linux or Windows) in any tracked text file, and the release workflow runs the same check on the packed archive (`npm run release:check -- --archive <file.tgz>`).

## Providers

Data goes in kinds, behaviour goes in `impl`. Provider facts (URL, `modelId`, `requiresToken`, `limits`) are kind settings in the `cds` section of `package.json`. Only a provider whose protocol differs gets a `SystemOneService` subclass, selected through the kind's `impl`. Shared code contains no provider names. Kind names are `systemone-<provider>`; no kind is named like the service. See `docs/providers.md`. `cds add systemone --kind` offers every installed kind that reaches `systemone-defaults` through its `kind` chain, except `systemone-defaults` itself and kinds whose `impl` is the mock; a new kind therefore needs no change in `src/add-core.ts`.

## Decisions and Plans

- Architecture decisions are numbered files in `docs/decisions/`, such as `0003-title.md`. One decision per file. Fields: Date, Status, Context, Options considered, Decision, Consequences. The status is `Proposed` until the change is merged, then `Accepted`.
- Plans are in `docs/plans/`. A completed plan moves to `docs/plans/completed/`.

## Testing Guidelines

Use Node's built-in test runner. Work red-green: write the test first and see it fail for the expected reason, then write the code. Add tests for new behavior and a failure case where relevant. HTTP tests must use local servers and avoid external API keys.

- CAP-level behavior is tested in temporary apps created with `tests/helpers/app.cjs` (`createApp`, `runInApp`, `removeApp`). They resolve the repository's `cap-jev` and `@sap/cds`.
- The mock is the default kind in the `development` and `test` profiles. A test that needs a real or fake HTTP endpoint must select a kind explicitly, or run in the production profile, as `tests/cap-integration.test.cjs` does. For the HTTP path, a test can use `startMockServer` from `dist/mock-server` instead of writing its own fake server, as `tests/mock-server-cap.test.cjs` does.
- The mock is tested in `tests/mock.test.cjs` (activation, production refusal, fixtures, failures, latency), `tests/mock-engine.test.cjs` and `tests/mock-fixtures.test.cjs`; its settings types in `tests/mock.test.ts`.
- The mock core is tested in `tests/mock-core.test.cjs`. The HTTP mock server is tested in `tests/mock-server.test.cjs` (plain `fetch`), `tests/mock-server-cap.test.cjs` (temporary CAP apps in the production profile), `tests/mock-server-cli.test.cjs` (the command line in child processes) and, for its option types, `tests/mock-server.test.ts`. Behaviour shared by `MockService` and the server is tested through both.
- The `cds add systemone` planner is tested in `tests/add-core.test.cjs` (against `dist/add-core.js`: options, files, messages, refused kinds, indentation, idempotency, the example fixtures, loading without `@sap/cds`). The facet is tested in `tests/cds-add.test.cjs`, which runs the real `cds add` of `@sap/cds-dk` (a development dependency) in child processes in temporary apps; keep the planner's messages and that test in step. The registration in `cds-plugin.js` is tested in `tests/plugin.test.cjs` with a stubbed `cds.add` and `cds.cli`. `cds add` runs in the `development` profile, so a test that needs the production kind sets `CDS_ENV=production` for the app it starts afterwards.
- The test kit is tested in `tests/testing.test.cjs`: it runs the kit against the built-in token kinds and Cloudflare, runs a temporary provider package with a wrong `unwrap` through a child `node --test` and checks that the output names the failing check, and checks that requiring `dist/testing.js` loads no `@sap/cds` and that `cds-plugin.js` does not load it. `examples/provider-package/test/provider.test.cjs` runs the kit for `systemone-acme`; `npm test` runs it. A new check in the kit must pass for every kind in these tests; a kind that differs gets an adapter option, not an exception in the kit.
- The release scripts are tested in `tests/release-scripts.test.cjs`, in temporary directories.
- The example app is tested with `cds.test` in `tests/example-app.test.cjs` and `tests/example-app-failure.test.cjs`, on the mock and without a fake server.
- One test, `tests/cap-integration.test.cjs`, installs the packed package in a copy of the example app, also runs `cds add systemone` there, and checks that `dist/add.js` and `dist/add-core.js` are in the archive. Keep the example handler and that test's fake server in step.
- Type-level behavior belongs in `tests/*.test.ts`, which `npm run typecheck` checks with positive assertions and `@ts-expect-error` cases.
- `cap-jev` supports the last two stable CAP majors. The `@sap/cds` peer range (`package.json`, `examples/provider-package/package.json`) and the `cds` matrix of `.github/workflows/ci.yml` must name the same majors, as `^9 || ^10` for `cds: [9, 10]`; `npm run release:check` enforces it, tested in `tests/release-scripts.test.cjs`. A new CAP major is added to both in one release, and the oldest leaves both.
- Coverage: a test for a gap asserts the behaviour, not just executes the line. A line that cannot be reached is removed, not excluded with an ignore comment. Child processes are counted when they exit on their own, so the `cds add` facet and the CAP apps of the tests are included. Not counted: a process that a signal stops (the run-until-stopped part of `dist/mock-server-cli.js`), `cds-plugin.js` (outside `dist/`), and the CAP side of the test kit (a string run in a child process). Those files look weaker than they are; test them in child processes as before.
- CI runs `npm run coverage` instead of `npm test` in exactly one job, Node 24 with CAP 10 (matrix conditions in `.github/workflows/ci.yml`); every other job runs `npm test`. Keep the `cds: [9, 10]` line of the matrix unchanged, because `npm run release:check` parses it. When the CAP majors of the matrix change, the step conditions that name a major (`matrix.cds == 9`, `matrix.cds == 10`) change in the same commit. CI runs for pushes to `main` and for pull requests only, so a branch with an open pull request does not run the matrix twice.
- CI runs Node 22, 24 and 26 with CAP 9 and CAP 10; for CAP 9 it installs `@sap/cds@^9 @sap/cds-dk@^9`. To check CAP 9 locally, run `npm install --no-save @sap/cds@^9 @sap/cds-dk@^9` and then `npm test`; run `npm install` afterwards to restore CAP 10. With npm 12 or later, which blocks install scripts, `@sap/cds-dk` 9's `better-sqlite3` has no native binding: run `npx --no-install prebuild-install` in `node_modules/better-sqlite3`, otherwise the example-app tests hang.

## Commit & Pull Request Guidelines

Use short, imperative subjects that describe the change, such as `Add user validation`. Release commits end with the version, such as `Type optional choice probabilities in version 0.4.1`. Keep commits focused. Pull requests should explain what changed, why it changed, how it was tested, and any known limitations. Link a relevant issue when one exists; include screenshots for visible interface changes.

## Releases

Changelog headings are `## <x.y.z>: <title>`. The title becomes the title of the GitHub release, `<x.y.z>: <title>`.

1. Work on a branch named `release-<x.y.z>`.
2. Update the version in `package.json` and `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`), the `cap-jev` range in `examples/cap-app/package.json` and the one quoted in `examples/provider-package/README.md`, the release archive URLs and the `cap-jev-<x.y.z>.tgz` file names in `README.md` and `examples/cap-app/README.md`, and `CHANGELOG.md`.
3. Run `npm run lint`, `npm run typecheck`, `npm test`, `npm pack --dry-run` and `npm run release:check` (which also compares the CAP peer range with the CI matrix), and run `npm test` on CAP 9 as described above.
4. Open a pull request and merge it to `main` with a merge commit, after CI is green.
5. Tag the merge commit `v<x.y.z>` and push the tag.
6. The release workflow runs CI on the tag and creates the GitHub release with the archive and the changelog section as notes; check the run. If it fails, fix the cause and re-run it, or create the release by hand as before.
