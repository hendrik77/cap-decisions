# 4. Tag-triggered release workflow

**Date:** 2026-10-21
**Status:** Accepted (0.7.0)

## Context

Releases up to 0.6.0 followed six manual steps in `AGENTS.md`. Two of them are error-prone:

- The version appears in six places: `package.json`, `package-lock.json`, the `cap-jev` range of the example app, the release archive URLs in two READMEs, and `CHANGELOG.md`.
- The GitHub release, its archive and its notes are created by hand from the changelog.

The commit convention is short imperative subjects; release commits end with the version. Releases are made from merge commits on `main`, tagged `v<x.y.z>`. `cap-jev` is not on npm before 1.0.0.

## Options considered

| Option | Outcome | Verdict |
| --- | --- | --- |
| **A.** Keep the manual steps | Works, but the version references and release notes depend on care | Rejected |
| **B.** `release-it` or `semantic-release` with conventional commits | Generates versions and changelogs from commit messages; requires changing the commit convention and the hand-written changelog | Rejected |
| **C.** `release-please` | A bot opens release pull requests from conventional commits; same convention change, and a second actor on the repository | Rejected |
| **D.** A check script plus a workflow triggered by the version tag | The changelog stays hand-written; the script catches inconsistent versions before the release; the tag push creates the release from the tested commit | **Selected** |

## Decision

1. **`npm run release:check`** (`scripts/release-check.cjs`) checks that every version reference matches `package.json`, and with `--tag` that the tag matches. It runs locally before the pull request and in the workflow before the release.
2. **Changelog headings carry the release title**, `## <version>: <title>`. `scripts/release-notes.cjs` extracts the title and the section as release notes.
3. **`.github/workflows/release.yml`** runs on pushed tags `v*.*.*`: the full CI matrix (reused from `ci.yml` through `workflow_call`), then the release job with `contents: write`: check, `npm pack`, notes, `gh release create --verify-tag`. An existing release fails the job instead of being overwritten.
4. **Versions stay manual**: `npm version <x.y.z> --no-git-tag-version` on the release branch, and the tag on the merge commit.
5. **No `npm publish`** before 1.0.0. The workflow gets a publish step with provenance when 1.0.0 is planned.

## Consequences

- A release is: version bump and changelog on the branch, `release:check`, merge, tag, push the tag.
- A wrong version reference fails before the merge, not after the release.
- Only the release job can write to the repository, and only on tag pushes.
- If the workflow fails, it can be re-run after a fix, or the release is created by hand as before.

## References

- [Plan](../plans/http-mock-server-and-release-automation.md), tasks R4, R5 and R7
- GitHub: [Reusing workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows), [`gh release create`](https://cli.github.com/manual/gh_release_create)
