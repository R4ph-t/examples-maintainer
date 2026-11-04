# Read-only example maintenance

The guide below describes public-mode setup. The current Blueprint additionally
links `examples-maintainer-github` to the Workflow and sets its mode to `pat`.
That group holds `MAINTENANCE_GITHUB_TOKEN` and `MAINTENANCE_PUBLISH_DRAFTS=false`.
Keep GitHub credentials out of the shared `examples-maintainer` group. The cron
keeps public mode and receives no PAT. For a fully public first deployment, omit
the GitHub group link and set the Workflow's mode to `public`. PAT mode alone
does not enable draft publication; standalone health checks can publish statuses.

This deployment scans public example dependencies every six hours and verifies
explicitly selected updates in separate clean environments. It uses
Render credentials only. GitHub Apps, PATs, webhooks, and model keys are not needed.
Selected verification produces tested proposals without modifying GitHub repositories.
See [the dependency loop](dependency-maintenance.md) for policy and retained artifacts.

## Configuration and coverage

`factory.config.ts` explicitly opts repositories into maintenance and defines
trusted commands. The four pilots are Express JavaScript, Express TypeScript,
Hapi, and Django. TypeScript has a build; the JavaScript examples have syntax
and HTTP checks. Django uses system checks, SQLite migrations, and HTTP checks.
These recipes do not provide substantive unit-test suites or reproduce every
production service setting. Runtime versions are recorded in each result.

Run `npm run maintenance:inventory` to list the organization's public repos.
Each is marked `configured`, `needs_recipe`, or `excluded` (archived/disabled).
Discovery does not automatically execute repositories or infer commands.

## Prepare and deploy

Use Node 24, run `npm ci`, then `npm run check`. For setup, authenticate with a
management `RENDER_API_KEY` that can access the intended workspace and manage its
environment groups. Keep it in the process environment or ignored `.env` file.
Configure the intended workspace with:

```bash
npm run setup:maintenance -- --workspace tea-YOUR_WORKSPACE
```

This reads the configured public revisions, checks Render workspace access,
and creates/updates only `RENDER_WORKSPACE_ID` and `MAINTENANCE_MODE=public` in
the `examples-maintainer` environment group. It saves those values to local
`.env`. The management key is never copied to the group, and an existing runtime
key is left untouched. This setup is separate from the inherited full factory's
App runbook.

In Render Account settings > API Keys, create a dedicated key named
`examples-maintainer`, restricted to the maintenance workspace. For the current
shared runtime key, select these permissions:

| Permission | Access |
| --- | --- |
| Workflows | Read |
| Run workflow tasks | Run |
| Sandbox lifecycle and snapshots | Read & write |
| Sandbox execution and file transfer | Execute |

Leave other permissions off, including workflow secrets. Set the key as
`RENDER_API_KEY` in the `examples-maintainer` environment group through the
Dashboard before deployment. It does not need environment-group or deployment
permissions. Permission labels can change; check the current Dashboard catalog.
For manual runtime checks, use this scoped key rather than the management key.
Never paste either key into logs, chat, or source control.

Publish the tested branch before deployment. `render.maintenance.yaml` describes:

- `examples-maintainer`: a Workflow, started with `npm run start:maintenance`.
- `examples-maintainer-daily`: a Starter Cron Job, running
  `npm run maintenance:dependencies -- --wait` at **03:00 UTC daily**.
- `examples-maintainer-scan`: a separate Starter Cron Job, running
  `npm run maintenance:scan -- --wait` at **00:00, 06:00, 12:00, and 18:00 UTC**.

This is the desired configuration; existing hosted services change only after
deployment. The new scan path requires live acceptance before scheduling.

The cron's `RENDER_WORKFLOW_SLUG` must match the created Workflow's slug. Both
services link the maintenance group. Manual creation through CLI/API can use
the same commands, settings, and group links. Automatic deploys are off so a
code push does not silently change the scheduled tests. Workflows and sandboxes
use metered compute; the cron has its own billing.

Validate the Blueprint against the workspace, deploy the Workflow, and verify
that `verify-repository`, `maintenance-sweep`, `dependency-review`,
`dependency-sweep`, `dependency-publish`, `dependency-scan`,
`dependency-scan-sweep`, and `dependency-verify-selected` are registered.
A successful deploy registers tasks but does not execute them.

```bash
npm run maintenance:scan -- --dry-run
npm run maintenance:scan -- --wait --out ./scan-results
```

The second command submits real scan work, waits for completion, and exports
ranked evidence. Inspect a cold scan, a subsequent window's cache hit, and an
explicit candidate verification before enabling the recurring cron. Follow
[the scanning runbook](dependency-scanning.md) for selection, freshness rules,
cache behavior, and acceptance. Snapshot reuse requires snapshot read/write
permission on the intended sandbox group; unauthorized restore fails closed.

## Read results

The scan sweep retains each repo's exact SHA, priority, outcome, and child run ID.
Child results retain audits, ranked candidates, source/tool identity, snapshot
receipts, and cleanup status. Scan completion does not mean the application
builds or runs. Full selected verification retains the separate baseline and
candidate checks and patch. GitHub receives no writes in public mode.

A Workflow run can succeed as a computation while its report contains failures;
inspect `results[].status`. The scan cron exits nonzero for incomplete scans or
infrastructure errors; finding vulnerabilities itself does not fail scan execution.
A repository that cannot be resolved is recorded explicitly; others still run.
Children are sequential within each sweep, without automatic retries. Independent
manual runs can overlap. Every sandbox has a 30-minute provider timeout and
explicit cleanup. Canceling the cron does not cancel its Workflow.

Scan dispatch deduplicates within canonical six-hour UTC windows using revision
and recipe identity. Provider deduplication can reuse a run across releases and
is not a permanent history or lock. Inspect task version and start time when
accepting a new deployment; do not mistake an earlier run for new evidence.

The full combined sweep continues daily and remains available manually as
`maintenance:dependencies -- --wait`, and health-only checks as
`maintenance:dispatch -- --wait`. For their result details, see
[dependency maintenance](dependency-maintenance.md) and [maintenance](maintenance.md).

Public GitHub API rate limits apply without authentication. The pilot makes only
a small number of requests per sweep. Before expanding toward the 25-repository batch
limit, account for metadata, commit lookup, inventory, and concurrent runs sharing
the outbound rate limit. Failures remain explicit; no credential fallback occurs.

## Acceptance and limits

Accept this deployment only after hosted scans and selected verification complete,
expected results are inspected, sandbox cleanup is confirmed, and the cron path is tested.
The previous disposable-fork live tests separately covered a deliberately broken
response, healthy recovery, and a failed install. They do not replace hosted-run
verification.

Results use Render's Workflow retention. There is no long-term history database,
custom dashboard, notification service, database fixture provisioning, automatic
repair, or GitHub publication in this phase. Tested dependency patches are
retained by the [dependency loop](dependency-maintenance.md). Add reviewed recipes to expand
coverage; use the inventory to keep untested repos visible.
