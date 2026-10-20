# Repository Guidelines

This repository contains the `cap-jev` TypeScript CAP plugin. Keep these conventions current as the package grows.

## Project Structure & Module Organization

- `src/`: plugin source. `index.ts` holds `SystemOneService` and the public exports, `transport.ts` is the internal HTTP transport, `validation.ts` and `types.ts` hold validation and types.
- `src/providers/`: provider subclasses of `SystemOneService`, one file per provider (currently `cloudflare.ts` and `mock.ts`). Each is exported through `exports` in `package.json`. The mock's pure helpers sit next to it: `mock-engine.ts` (the deterministic answer engine) and `mock-fixtures.ts` (parsing and matching of fixture rules). They import no CAP code and are not exported.
- `tests/`: Node test files. `tests/helpers/` holds the temporary-app helper (`app.cjs`) and the local fake server (`fake-server.cjs`).
- `examples/cap-app/`: the sample CAP app; it runs on the mock in development, and its fixture rules are in `examples/cap-app/test/data/systemone.json`. `examples/provider-package/`: a minimal provider package. Both are npm workspaces.
- `docs/`: guides (`providers.md`, `local-development.md`), architecture decision records in `docs/decisions/`, and plans in `docs/plans/`.
- `dist/` is generated and excluded from Git. `cds-plugin.js` must remain at the package root for CAP discovery, and it must never throw.

## Build, Test, and Development Commands

Use `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test`; all are documented in the root README. `npm run format` applies Prettier to `src`, `tests`, and the example handlers. `npm pack --dry-run` checks the publishable contents. The plugin has no standalone server; run it through a CAP application such as `examples/cap-app`.

## Coding Style & Naming Conventions

TypeScript uses the strict `tsconfig.json` configuration and two-space indentation. JavaScript test files use CommonJS and two-space indentation. Keep source and test file names descriptive; avoid unrelated formatting changes.

## Providers

Data goes in kinds, behaviour goes in `impl`. Provider facts (URL, `modelId`, `requiresToken`, `limits`) are kind settings in the `cds` section of `package.json`. Only a provider whose protocol differs gets a `SystemOneService` subclass, selected through the kind's `impl`. Shared code contains no provider names. Kind names are `systemone-<provider>`; no kind is named like the service. See `docs/providers.md`.

## Decisions and Plans

- Architecture decisions are numbered files in `docs/decisions/`, such as `0003-title.md`. One decision per file. Fields: Date, Status, Context, Options considered, Decision, Consequences. The status is `Proposed` until the change is merged, then `Accepted`.
- Plans are in `docs/plans/`. A completed plan moves to `docs/plans/completed/`.

## Testing Guidelines

Use Node's built-in test runner. Work red-green: write the test first and see it fail for the expected reason, then write the code. Add tests for new behavior and a failure case where relevant. HTTP tests must use local servers and avoid external API keys.

- CAP-level behavior is tested in temporary apps created with `tests/helpers/app.cjs` (`createApp`, `runInApp`, `removeApp`). They resolve the repository's `cap-jev` and `@sap/cds`.
- The mock is the default kind in the `development` and `test` profiles. A test that needs a real or fake HTTP endpoint must select a kind explicitly, or run in the production profile, as `tests/cap-integration.test.cjs` does.
- The mock is tested in `tests/mock.test.cjs` (activation, production refusal, fixtures, failures, latency), `tests/mock-engine.test.cjs` and `tests/mock-fixtures.test.cjs`; its settings types in `tests/mock.test.ts`.
- The example app is tested with `cds.test` in `tests/example-app.test.cjs` and `tests/example-app-failure.test.cjs`, on the mock and without a fake server.
- One test, `tests/cap-integration.test.cjs`, installs the packed package in a copy of the example app. Keep the example handler and that test's fake server in step.
- Type-level behavior belongs in `tests/*.test.ts`, which `npm run typecheck` checks with positive assertions and `@ts-expect-error` cases.
- CI runs Node 22, 24 and 26 with CAP 9 and CAP 10. To check CAP 9 locally, run `npm install --no-save @sap/cds@^9` and then `npm test`.

## Commit & Pull Request Guidelines

Use short, imperative subjects that describe the change, such as `Add user validation`. Release commits end with the version, such as `Type optional choice probabilities in version 0.4.1`. Keep commits focused. Pull requests should explain what changed, why it changed, how it was tested, and any known limitations. Link a relevant issue when one exists; include screenshots for visible interface changes.

## Releases

1. Work on a branch named `release-<x.y.z>`.
2. Update the version in `package.json` and `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`), the `cap-jev` range in `examples/cap-app/package.json`, the release archive URLs in `README.md` and `examples/cap-app/README.md`, and `CHANGELOG.md`.
3. Run `npm run lint`, `npm run typecheck`, `npm test` and `npm pack --dry-run`, and run `npm test` on CAP 9 as described above.
4. Open a pull request and merge it to `main` with a merge commit, after CI is green.
5. Tag the merge commit `v<x.y.z>`.
6. Create a GitHub release with the `npm pack` archive attached.
