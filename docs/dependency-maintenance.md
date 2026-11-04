# Tested dependency proposals

The dependency loop is enabled for the configured Express JavaScript,
Express TypeScript, Hapi, and Django examples. It produces review artifacts. GitHub publication is disabled by default. A GitHub PAT is not required in public mode.

The default Blueprint schedule now runs the separate [scan pass](dependency-scanning.md).
Use retained scan evidence to select which update receives the full verification
below. The combined `maintenance:dependencies` command remains available for
manual regression sweeps; it is no longer the intended frequent scheduled job.

## What each full verification does

1. Pin the configured branch to an exact commit and run the existing install,
   build/syntax, and HTTP smoke recipe in a fresh sandbox.
2. Read installed direct dependency versions without importing package code.
   Audit the installed baseline, then query the public npm/PyPI registry for stable, non-deprecated releases. Select one
   update, prioritizing eligible direct fixes identified by the audit, then
   runtime dependencies and package names in sorted order. Preserve exact/caret/tilde range style.
3. In a second fresh sandbox at the same commit, change only that dependency's
   declaration and regenerate the existing lockfile with lifecycle scripts
   disabled. npm uses `--package-lock-only`; Yarn Classic uses pinned 1.22.22.
4. Validate that only the intended manifest field changed. Retain both files'
   original and proposed content, a SHA-256 proposal identity, and a unified diff.
5. In a third fresh sandbox at the same commit, apply those exact files and run
   the original frozen install and checks. Require the selected installed version,
   unchanged other direct versions, unchanged proposal files, matching runtime
   and verifier identities, and confirmed sandbox termination. Repeat the audit and block newly introduced
   high, critical, or unknown-severity findings. Unavailable scans cannot pass.

Only a passing comparison becomes `ready_for_review`. A failed baseline blocks
proposal generation. Failed candidates retain their patch and checks as rejected
results. Missing exits, changed files, mismatched versions, registry errors, and
unconfirmed cleanup cannot become successful proposals. Each sandbox has a
30-minute provider timeout; the controller also bounds individual commands.
The sweep runs repositories sequentially, and each repository uses at most three
sandboxes sequentially.

## Supported policy

Opt in through `dependencyUpdates: { packageManager: "npm" | "yarn1" | "pip" }` alongside
a `maintenance` recipe in `factory.config.ts`. Existing recipes must perform a
frozen install (`npm ci` or Yarn `--frozen-lockfile`).

The Node adapter supports a root `package.json` and exactly one `package-lock.json` or
Yarn Classic `yarn.lock`, with at most 40 direct runtime/development dependencies.
It proposes patches and minors within the installed major; for 0.x it stays
within the installed minor. It skips prereleases, deprecated releases, aliases,
Git/file/URL dependencies, and complex ranges. Unsupported ranges are listed in
`discovery.skipped`. Workspaces, mixed lockfiles, symlinks, hard links, invalid
UTF-8, and files larger than 180 KB are rejected. A retained artifact is capped
at 512 KB serialized, so oversized diffs fail explicitly.

Security findings guide selection and are compared before/after. Audit results
are known-advisory evidence, not a guarantee that every minor release is compatible. The recipes are the acceptance evidence.
The pilot examples have no substantive unit tests; their results distinguish syntax,
TypeScript build, and HTTP smoke checks.

The legacy combined sweep tests the first eligible candidate per repository. Other
candidates remain visible in the discovery result. Until a proposal is merged,
subsequent combined sweeps can propose the same update again. The separate scan
path exposes ranked candidates and accepts an explicit selection, so an operator
can test another candidate without merging the first. It does not yet maintain a
persistent queue or automatically skip pending proposals. Published proposals use immutable artifact branches and persistent PR markers
for deduplication. There is no automatic repair, merge, or major-version migration.
See [Python maintenance](python-maintenance.md) for exact requirements pins and
[security audits](security-audits.md) for audit interpretation and limitations.

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

For a manual combined sweep, run `npm run maintenance:dependencies -- --wait`.
The Blueprint now specifies `maintenance:scan -- --wait`; existing hosted cron
configuration changes only when explicitly deployed. Child Workflow
results retain the full patch and comparison evidence; the sweep retains compact
summaries and child run IDs. Retention follows Render's Workflow retention. There
is no separate artifact store yet. Export artifacts while results are retained.
The combined sweep command exits unsuccessfully for a failed baseline, rejected candidate, generation
failure, or infrastructure failure. `no_eligible_update` is healthy but can include
explicitly skipped unsupported declarations.

The daily idempotency key incorporates date, pinned revisions, recipes and update
policy, and is separate from the health-only sweep. A repeated invocation can
reuse an earlier run. An explicit acceptance run should use a distinct
idempotency key. Cancelling the cron does not cancel its children; inspect the
existing run before starting another.

## GitHub publishing

Publication is disabled by default, including in public mode. Once a dedicated
GitHub credential is approved, both `MAINTENANCE_PUBLISH_DRAFTS=true` and the
repository's `dependencyUpdates.publishDrafts: true` are required. The sweep can
then publish ready proposals through a separate `dependency-publish` task.
An operator can also invoke `npm run maintenance:publish -- --repo OWNER/REPO
--review-run trn-...`.

The publisher loads evidence from this Workflow, checks 24-hour freshness,
revalidates the exact tested artifact and current base, and opens or reuses a
draft PR. It never merges or overwrites a human-modified branch or PR. Baseline
and candidate checks do not publish a misleading status against the unchanged
base commit. See [draft publication](dependency-publishing.md) for the safety
contract and unavoidable race when the base advances during PR creation.
