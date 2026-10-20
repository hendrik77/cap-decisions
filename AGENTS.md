# Repository Guidelines

This repository contains the `cap-jev` TypeScript CAP plugin. Keep these conventions current as the package grows.

## Project Structure & Module Organization

Keep plugin source in `src/`, Node test files in `tests/`, and the sample CAP app in `examples/cap-app/`. `dist/` is generated and excluded from Git. `cds-plugin.js` must remain at the package root for CAP discovery.

## Build, Test, and Development Commands

Use `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test`; all are documented in the root README. `npm run format` applies Prettier to `src`, `tests`, and the example handlers. `npm pack --dry-run` checks the publishable contents. The plugin has no standalone server; run it through a CAP application such as `examples/cap-app`.

## Coding Style & Naming Conventions

TypeScript uses the strict `tsconfig.json` configuration and two-space indentation. JavaScript test files use CommonJS and two-space indentation. Keep source and test file names descriptive; avoid unrelated formatting changes.

## Testing Guidelines

Use Node's built-in test runner. Add tests for new behavior and a failure case where relevant. HTTP tests must use local servers and avoid external API keys. The integration test installs the packed package in the sample CAP app and calls its `classify` action, so keep the example handler and the test's fake server in step. Type-level behavior belongs in `tests/*.test.ts`, which `npm run typecheck` checks with positive assertions and `@ts-expect-error` cases.

## Commit & Pull Request Guidelines

Use short, imperative subjects that describe the change, such as `Add user validation`. Release commits end with the version, such as `Type optional choice probabilities in version 0.4.1`. Keep commits focused. Pull requests should explain what changed, why it changed, how it was tested, and any known limitations. Link a relevant issue when one exists; include screenshots for visible interface changes.

## Releases

A release updates the version in `package.json`, `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`), the `cap-jev` dependency in `examples/cap-app/package.json`, and the release archive URLs in `README.md` and `examples/cap-app/README.md`, and adds a `CHANGELOG.md` entry. Merge to `main` through a pull request with a merge commit, tag the merge commit `v<x.y.z>`, wait for CI, then create a GitHub release with the `npm pack` archive attached.
