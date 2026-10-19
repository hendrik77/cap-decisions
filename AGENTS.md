# Repository Guidelines

This repository contains the `cap-jev` TypeScript CAP plugin. Keep these conventions current as the package grows.

## Project Structure & Module Organization

Keep plugin source in `src/`, Node test files in `tests/`, and the sample CAP app in `examples/cap-app/`. `dist/` is generated and excluded from Git. `cds-plugin.js` must remain at the package root for CAP discovery.

## Build, Test, and Development Commands

Use `npm run typecheck`, `npm run build`, and `npm test`; all are documented in the root README. `npm pack --dry-run` checks the publishable contents. The plugin has no standalone server; run it through a CAP application.

## Coding Style & Naming Conventions

TypeScript uses the strict `tsconfig.json` configuration and two-space indentation. JavaScript test files use CommonJS and two-space indentation. Keep source and test file names descriptive; avoid unrelated formatting changes.

## Testing Guidelines

Use Node's built-in test runner. Add tests for new behavior and a failure case where relevant. HTTP tests must use local servers and avoid external API keys. The integration test installs the packed package in the sample CAP app.

## Commit & Pull Request Guidelines

There is no Git history from which to infer a commit convention. Use short, imperative subjects that describe the change, such as `Add user validation`. Keep commits focused. Pull requests should explain what changed, why it changed, how it was tested, and any known limitations. Link a relevant issue when one exists; include screenshots for visible interface changes.
