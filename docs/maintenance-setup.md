# Read-only example maintenance

This deployment tests public example repositories on a daily schedule. It uses
Render credentials only. GitHub Apps, PATs, webhooks, and model keys are not needed.
It produces tested dependency proposals without modifying GitHub repositories.
See [the dependency loop](dependency-maintenance.md) for policy and retained artifacts.

## Configuration and coverage

`factory.config.ts` explicitly opts repositories into maintenance and defines
trusted commands. The first batch is Express JavaScript, Express TypeScript,
and Hapi. Commands were checked against their source and lockfiles. The
TypeScript example has a build; the other two have syntax and HTTP checks.
None of these examples has a unit-test script. Checks run on the sandbox's
Node runtime, recorded in each result, rather than reproducing every Render
service setting.

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

The cron's `RENDER_WORKFLOW_SLUG` must match the created Workflow's slug. Both
services link the maintenance group. Manual creation through CLI/API can use
the same commands, settings, and group links. Automatic deploys are off so a
code push does not silently change the scheduled tests. Workflows and sandboxes
use metered compute; the cron has its own billing.

Validate the Blueprint against the workspace, deploy the Workflow, and verify
that `verify-repository`, `maintenance-sweep`, `dependency-review`, and
`dependency-sweep` are registered. Run one manual
sweep and inspect its result before enabling the daily cron. A successful deploy
registers tasks but does not execute them.

```bash
npm run maintenance:dependencies -- --dry-run
npm run maintenance:dependencies -- --wait --out ./dependency-results
```

The second command submits real work, waits for completion, prints the report,
and exits nonzero for a failed baseline, rejected candidate, or infrastructure
failure. GitHub publication remains disabled. The original health-only sweep is
available as `maintenance:dispatch`. To run one health recipe directly:

```bash
npm run maintenance:verify -- --repo render-examples/express-hello-world
```

## Read results

Open the Workflow's run history in Render. The dependency sweep contains each
repo's exact SHA, outcome, child run ID, proposed update, and artifact identity.
Child results retain the diff and full baseline/candidate stage results, bounded
command output, sandbox IDs, and cleanup status. GitHub receives no writes.

A Workflow run can succeed as a computation while its report contains failures;
inspect `results[].status`. The cron checks those statuses and fails if any repo
is unhealthy. A repository that cannot be resolved is recorded as
`revision_unavailable`; the other repositories still run. No failed child is
retried automatically.

Each sweep runs one child at a time, each child uses a fresh sandbox, and every
sandbox has a 30-minute provider timeout plus normal explicit cleanup. Independent
manual sweeps can still overlap. The cron waits for completion, with a ten-hour
caller limit, and Render prevents overlapping executions of the same cron.
A canceled cron does not cancel its Workflow; inspect the existing run before
starting another. Daily dispatch uses an idempotency key incorporating the UTC
date, revisions, and recipes. A repeated dispatch can return an earlier run,
including after a Workflow release. For an explicit fresh acceptance test, submit
the planned input with a distinct idempotency key and verify the resulting run's
task version and start time. Daily idempotency is not a durable history or lock.

Public GitHub API rate limits apply without authentication. The pilot makes only
a small number of requests daily. Before expanding toward the 25-repository batch
limit, account for metadata, commit lookup, inventory, and concurrent runs sharing
the outbound rate limit. Failures remain explicit; no credential fallback occurs.

## Acceptance and limits

Accept this deployment only after a hosted sweep completes, expected stage results
are inspected, each sandbox is confirmed terminated, and the cron path is tested.
The previous disposable-fork live tests separately covered a deliberately broken
response, healthy recovery, and a failed install. They do not replace hosted-run
verification.

Results use Render's Workflow retention. There is no long-term history database,
custom dashboard, notification service, database fixture provisioning, automatic
repair, or GitHub publication in this phase. Tested dependency patches are
retained by the [dependency loop](dependency-maintenance.md). Add reviewed recipes to expand
coverage; use the inventory to keep untested repos visible.
