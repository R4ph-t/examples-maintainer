# Scan first, verify selected updates

Maintenance has two separate workloads. Frequent scans refresh dependency and
advisory evidence; selected verification builds and runs an exact proposed update.
A scan never means an application passed its checks, and neither timestamp is a
human review timestamp.

The Blueprint specifies a six-hour scan cadence alongside daily full verification.
Applying this source change
does not update an existing deployment or cron; deploy and accept the new tasks
before enabling the hosted schedule. The combined `maintenance:dependencies`
command retains its daily 03:00 UTC run and remains available manually.

## Scan configured repositories

Use a checkout matching the deployed Workflow and its configuration:

```bash
npm run maintenance:scan -- --dry-run
npm run maintenance:scan -- --wait --out ./scan-results
```

The dry run resolves revisions and prints the plan without starting work. The
second command creates real sandbox work. It exports `scan-sweep.json` and each
repository's detailed scan JSON. `--out` requires `--wait`; without `--wait`, the
command returns the parent run ID without checking its eventual outcome.

Only repositories with reviewed maintenance and dependency-update configuration
run, at most 25 per sweep. Today that is four pilots, not the entire public
organization inventory. Inventory discovery never authorizes execution.

Each child pins the source SHA, installs or restores dependencies, refreshes the
security audit, discovers policy-eligible updates, and records recipe/tool hashes,
runtime, installed-inventory hash, snapshot receipt, and cleanup outcome. It does
not run application build/check/smoke commands, generate patches, or publish to
GitHub. The current Node recipes disable installation lifecycle scripts for
scans; Python's pilot recipe installs wheels only. New install recipes require
review, especially compound shell commands: appending package-manager flags does
not turn an arbitrary command into a safe audit-only installer.

Rows are ranked critical, high, needs-triage, moderate, low, informational, then
routine maintenance. Unrated findings remain needs-triage. Candidate ranking uses
reported severity and exact fix-version metadata for directly matching packages;
it does not infer transitive remediation, exploitability, or runtime reachability.
An audit finding without an eligible candidate remains visible for manual work.

`completed` means scan evidence is complete and cleanup confirmed, even if it
contains vulnerabilities. Unsupported dependency ranges remain explicit policy
exclusions in `discovery.skipped`; completion does not claim those packages are
current or have an automated update. Missing audits, failed registry lookups,
or unresolved installed versions are `incomplete`;
execution or cleanup uncertainty is `infrastructure_error`. With `--wait`, either
non-completed status exits nonzero. Inspect findings separately from job health.

## Verify one selected candidate

Choose the repository's child `runId` from the sweep and a candidate name from its
detailed result. The parent sweep ID is not a scan ID.

```bash
npm run maintenance:verify-update -- \
  --repo render-examples/express-hello-world \
  --scan-run trn-REPLACE_WITH_CHILD_RUN_ID \
  --candidate express --wait
```

The controller loads retained evidence from a completed `dependency-scan` owned
by the same Workflow. It requires scan and audit evidence no older than six hours,
the current configured branch's exact SHA, and matching recipe/tool hashes.
Changed source, configuration, or expired evidence requires another scan.

The existing full review independently rediscovers that exact candidate and uses
clean baseline and candidate environments for installation, configured checks,
HTTP smoke tests, and audit comparison. A changed or unavailable candidate is
rejected; another package is never substituted silently. Failed checks retain
their evidence and block a ready-for-review result.

The selected task returns `reviewRunId` and `reviewStatus`. It never auto-publishes.
Use the existing [draft publication flow](dependency-publishing.md) with that review
ID only after its independent publication gates are satisfied. Public mode always
disables GitHub writes. No persistent queue, automatic selection, automatic merge,
or human-review ledger is added by this path.

## Prepared snapshots

Public and PAT scans can capture credential-free prepared filesystem state.
Snapshots are keyed by repository, exact commit, recipe/egress, and tool/bootstrap
identity. Restores verify the manifest, source SHA, runtime and dependency digest,
and expiry, and reapply the current sandbox network policy and timeout.

Reuse lasts at most 24 hours, allowing hits across six-hour scans. Every hit still
refreshes advisory and candidate-version data against the prepared inventory.
For Python, transitive installed versions can therefore remain up to 24 hours
old; selected verification resolves them independently. Missing/not-ready snapshots or confirmed expiry
fall back to fresh preparation. Identity mismatch or ambiguous restore/cleanup
fails closed. Optional capture failure permits the fresh scan to finish and is
reported as unavailable. App-mode preparation bypasses caching because it can
stage clone credentials. Full update verification never restores these snapshots.

The provider's default image is mutable. A runtime digest verifies restored state;
it does not pin the latest provider image. The lifetime bounds that reuse. Cache
receipts distinguish hit, created, disabled, and unavailable; a restored receipt
records its key and lifetime, without claiming a provider snapshot ID lookup.

## Scheduling and acceptance

`render.maintenance.yaml` defines `examples-maintainer-scan`, running
`npm run maintenance:scan -- --wait` at 00:00, 06:00, 12:00, and 18:00 UTC.
The separate `examples-maintainer-daily` retains full dependency verification at
03:00 UTC. Its combined loop selects one eligible update per repository; it does
not consume a persistent scan queue. Explicit selection from scan evidence is
also available. Automatic deployment remains disabled on both jobs.

The scan dispatch key includes a canonical six-hour UTC window and the existing
revision/recipe plan identity. `--window` accepts a UTC ISO datetime and rounds
down to that window. Provider deduplication is bounded and may return an earlier
run across releases; it is not a permanent history or a global lock. Retrying the
same selection also deduplicates while provider retention permits. Inspect the
existing run after an ambiguous response before launching more work.

Before scheduling, verify registration of `dependency-scan`,
`dependency-scan-sweep`, and `dependency-verify-selected`; inspect a hosted cold
scan, another window's cache hit, and an explicit candidate verification. Confirm
sandbox cleanup and the retained evidence. These are live acceptance steps, not
claims established by fake unit tests. The scoped key must allow snapshot read/write for the
intended sandbox group; unauthorized restoration fails closed. Independent manual sweeps can overlap;
within each sweep children run sequentially. Results use Workflow retention, with
no separate durable history database. A canceled cron does not cancel its Workflow.
