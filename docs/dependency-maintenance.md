# Tested dependency proposals

The dependency loop is enabled for the three configured Express JavaScript,
Express TypeScript, and Hapi examples. It produces review artifacts and does not
write to GitHub. A GitHub PAT is not required in public mode.

## What each run does

1. Pin the configured branch to an exact commit and run the existing install,
   build/syntax, and HTTP smoke recipe in a fresh sandbox.
2. Read installed direct dependency versions without importing package code.
   Query the public npm registry for stable, non-deprecated releases. Select one
   update, considering runtime dependencies first and package names in sorted
   order. Preserve exact/caret/tilde range style.
3. In a second fresh sandbox at the same commit, change only that dependency's
   declaration and regenerate the existing lockfile with lifecycle scripts
   disabled. npm uses `--package-lock-only`; Yarn Classic uses pinned 1.22.22.
4. Validate that only the intended manifest field changed. Retain both files'
   original and proposed content, a SHA-256 proposal identity, and a unified diff.
5. In a third fresh sandbox at the same commit, apply those exact files and run
   the original frozen install and checks. Require the selected installed version,
   unchanged other direct versions, unchanged proposal files, matching runtime
   and verifier identities, and confirmed sandbox termination.

Only a passing comparison becomes `ready_for_review`. A failed baseline blocks
proposal generation. Failed candidates retain their patch and checks as rejected
results. Missing exits, changed files, mismatched versions, registry errors, and
unconfirmed cleanup cannot become successful proposals. Each sandbox has a
30-minute provider timeout; the controller also bounds individual commands.
The sweep runs repositories sequentially, and each repository uses at most three
sandboxes sequentially.

## Supported policy

Opt in through `dependencyUpdates: { packageManager: "npm" | "yarn1" }` alongside
a `maintenance` recipe in `factory.config.ts`. Existing recipes must perform a
frozen install (`npm ci` or Yarn `--frozen-lockfile`).

This phase supports a root `package.json` and exactly one `package-lock.json` or
Yarn Classic `yarn.lock`, with at most 40 direct runtime/development dependencies.
It proposes patches and minors within the installed major; for 0.x it stays
within the installed minor. It skips prereleases, deprecated releases, aliases,
Git/file/URL dependencies, and complex ranges. Unsupported ranges are listed in
`discovery.skipped`. Workspaces, mixed lockfiles, symlinks, hard links, invalid
UTF-8, and files larger than 180 KB are rejected. A retained artifact is capped
at 512 KB serialized, so oversized diffs fail explicitly.

This is a version-update policy, not vulnerability remediation or a guarantee
that every minor release is compatible. The recipes are the acceptance evidence.
The pilot examples have no unit-test scripts; their results distinguish syntax,
TypeScript build, and HTTP smoke checks.

Only the first eligible candidate is tested per repo per daily run. Other
candidates remain visible in the discovery result. Until a proposal is merged,
subsequent days can propose the same update again. There is no persistent PR
queue, cross-day deduplication, automatic repair, merge, or major-version migration.

## Run and retrieve results

The Workflow exposes `dependency-review` and `dependency-sweep`, alongside the
original health-only tasks. Run with the dedicated workspace-scoped Render key:

```bash
npm run maintenance:dependencies -- --dry-run
npm run maintenance:dependencies -- --wait --out ./dependency-results
```

The dry run resolves branches and shows the pinned batch. The second command
runs real work, waits, and exports the sweep summary, per-repository JSON, and
candidate `.patch` files. Filenames include the review status so rejected patches
cannot be mistaken for approved ones. Review the JSON alongside any patch.

The hosted cron runs `npm run maintenance:dependencies -- --wait`. Child Workflow
results retain the full patch and comparison evidence; the sweep retains compact
summaries and child run IDs. Retention follows Render's Workflow retention. There
is no separate artifact store yet. Export artifacts while results are retained.
Cron exits unsuccessfully for a failed baseline, rejected candidate, generation
failure, or infrastructure failure. `no_eligible_update` is healthy but can include
explicitly skipped unsupported declarations.

The daily idempotency key incorporates date, pinned revisions, recipes and update
policy, and is separate from the health-only sweep. A repeated invocation can
reuse an earlier run. An explicit acceptance run should use a distinct
idempotency key. Cancelling the cron does not cancel its children; inspect the
existing run before starting another.

## GitHub publishing

Publication is deliberately disabled in this loop, including when a PAT or App
credential is present. Baseline/candidate checks never publish a misleading
status against the unchanged base commit. Future publishing must revalidate the
base branch and exact tested artifact, create a content-addressed branch, and
open or reuse a draft PR. PAT approval is needed for that publishing phase.
