# Example maintenance

This fork adds model-free repository health checks and tested dependency
proposals to software-factory. Four examples are configured: Express JavaScript,
Express TypeScript, Hapi, and Django. Fresh Render Sandboxes install dependencies,
run each repository's configured checks, and verify an HTTP response.

The recipes distinguish JavaScript syntax checks, TypeScript compilation, and
Django system/migration checks. These examples have no substantive unit-test
suite; the results do not invent one or prove a production Render deployment.
See [dependency maintenance](dependency-maintenance.md) for audited update
proposals and gated draft PR publication.

## Read-only deployment

Use [the standalone setup guide](maintenance-setup.md) for the first phase.
Set `MAINTENANCE_MODE=public` to explicitly disable GitHub authentication and
publication, even when local App or PAT credentials exist. Public repositories
are resolved through credential-free `git ls-remote` against the exact configured
`refs/heads/<branch>` at `github.com`. The subprocess has a private empty home,
no inherited credentials or Git configuration, disabled helpers/prompts and
redirects, bounded output, and a 30-second deadline. The sandbox clone also uses
an isolated anonymous Git environment and rejects redirects; successful cloning
proves public accessibility without a redundant REST metadata request. Missing,
private, renamed, malformed, or unreachable targets fail closed. PAT mode retains
its authenticated metadata/private-repository check. Results use `reporting: skipped`.

This removes the unauthenticated REST metadata dependency from public execution.
A live public metadata request returned HTTP 403; that status alone does not
establish its exact cause. Git transport errors remain explicit infrastructure
failures, never successful checks. [Git ls-remote](https://git-scm.com/docs/git-ls-remote)
and [Git HTTP/configuration](https://git-scm.com/docs/git-config) document these
transport and configuration controls.

The Django pilot uses an isolated SQLite database for system checks, migrations,
and a Gunicorn HTTP smoke check. It does not verify managed PostgreSQL behavior.
See [Python maintenance](python-maintenance.md) for the requirements adapter and
its limits. `npm run maintenance:inventory` distinguishes configured repos from
those still needing a reviewed recipe.

## What runs

`verify-repository` accepts a configured repository, GitHub App installation
ID in App mode, and exact 40-character commit SHA. Its recipe comes only from this
service's deployed `factory.config.ts`, never task input or the target repo.

Each run:

1. Creates an empty sandbox with an HTTPS allow-list and a 30-minute runtime timeout.
2. Prepares the factory's unprivileged user and clones the exact commit.
3. Deletes and checks clone credentials before running repository code.
4. Records the selected Node/npm or Python/pip runtime and runs install and
   configured checks in order.
5. Starts the application, checks its localhost response, and stops its process
   group, including descendants that outlive their parent.
6. Terminates the sandbox, recording whether termination was confirmed.
7. Reports a GitHub Check in App mode, a commit status in PAT mode, or skips
   publication in public mode. Dependency baseline/candidate checks always skip
   this publication; a separate gated task handles draft proposals.

Health and full update verification never restore dependency snapshots. The
separate [scan pass](dependency-scanning.md) can reuse prepared snapshots.
Every verification command has a guest
`timeout` and a separate client deadline. The host controls the smoke-test
script outside the writable checkout. Repository commands and app logs remain
untrusted; only stage metadata goes to GitHub. Bounded stdout/stderr tails are
retained in the Workflow result.

`maintenance-sweep` accepts up to 25 pinned repository inputs and runs children
sequentially. A failed child does not prevent testing the remaining repos.
Neither task automatically retries. This bounds concurrency **within a sweep**;
independent sweeps or direct task invocations can overlap. Configure platform
concurrency limits before expanding the fleet.

## Configure a recipe

The four pilots have recipes in `factory.config.ts`. Add a `maintenance` object
to opt another repository into health verification:

```typescript
maintenance: {
  install: { name: "install", command: "npm ci", timeoutSeconds: 180 },
  checks: [
    { name: "build", command: "npm run build", timeoutSeconds: 120 },
    { name: "test", command: "npm test", timeoutSeconds: 120 },
  ],
  smoke: {
    start: "PORT=3001 npm start",
    port: 3001,
    path: "/",
    expectedStatus: 200,
    bodyIncludes: "Expected application text",
    timeoutSeconds: 30,
  },
},
```

Only add commands the example actually provides. Install/check names must be
unique; `prepare`, `runtime`, and `smoke` are reserved. All recipe timeouts
together must fit within 15 minutes, leaving room for bootstrap and cleanup.
Recipes can select `runtime: "node"` (the default) or `runtime: "python"`.
The bootstrap installs the required tools and records actual versions; explicit
per-repository runtime versions and image digests are not pinned. The Django
pilot provisions a temporary SQLite file. Managed database, Redis, and other
external-service fixtures remain follow-up work.

The Express pilot uses its existing Yarn v1 lockfile. The recipe invokes pinned
Yarn 1.22.22 through npm exec and installs with `--frozen-lockfile`; both registry
hosts are allow-listed. This preserves the example's documented package manager.
The [dependency loop](dependency-maintenance.md) generates an exact update
artifact, compares baseline/candidate [security audits](security-audits.md), and
repeats the recipe in a separate clean sandbox.

## PAT authentication for the scheduled maintainer

The scheduled maintenance path can use `MAINTENANCE_GITHUB_TOKEN` instead of a
GitHub App. This is an explicit controller credential; it does not use an
ambient `GH_TOKEN`. When no explicit `MAINTENANCE_MODE` is set, this token selects PAT mode for
maintenance only. Explicit public mode still disables GitHub authentication. The inherited issue-to-PR agent workflows still use the App.

In PAT mode, the controller validates public repository visibility, resolves
the commit through the authenticated API, and clones anonymously in the sandbox. No PAT,
App token, or model key enters that sandbox. Private or renamed repositories
are refused before creating a sandbox; private PAT cloning is not implemented.

Create a fine-grained PAT for the organization and selected repositories.
Health verification needs Contents read and Commit statuses write. The implemented
[draft publisher](dependency-publishing.md) additionally needs Contents write and
Pull requests write, and remains disabled until both publication opt-ins are set.
The token acts with the user's existing access; organization approval and token
expiry still apply. A pending approval is not usable write access.

Save the token in ignored local `.env`, or the controller's Render environment
group. Never put it in a recipe, task input, guest environment, or git remote.
With `RENDER_API_KEY` and `RENDER_WORKSPACE_ID` also configured, run one live
verification without a hosted Workflow:

```bash
npm run maintenance:verify -- --repo render-examples/express-hello-world
```

In PAT mode, this command creates a sandbox and publishes a status. It fails if verification,
cleanup, or publication fails. `maintenance:dispatch -- --dry-run` performs only
read operations. PAT dispatch inputs omit `installationId`; App dispatch inputs
still include it.

PATs publish commit statuses under `examples-maintainer / health`, mapping
infrastructure failures to `error`. GitHub reserves Check Run creation for Apps.
The result's `checkUrl` points to the status API resource in PAT mode. Detailed
stage output remains in the Workflow result (or CLI JSON), not on GitHub. Status
writes are not retried after an ambiguous response.

For hosting, `npm run start:maintenance` registers the health, scan, selected-verification, dependency
review/sweep, and draft-publication tasks, without the inherited agent workflows. It needs the three variables in `SERVICE_ENV.maintenance`, supplied through
the `examples-maintainer` environment group in `MAINTENANCE_ENV_GROUPS`. No
webhook gateway, App installation, or model provider key is needed. The inherited
`setup:render` and doctor commands remain specific to the full App-based factory;
they do not provision or validate this standalone deployment.

## Prepare the App-based deployment

Follow the existing [setup runbook](runbooks/setup.md) for the fork. Keep its
human checkpoints for App installation, credentials, paid services, and webhook
activation. Public and PAT maintenance do not require this App-based setup.

The App now needs `checks: write`, in addition to its existing permissions.
Update the App and accept the installation's new permission, then rerun
`npm run setup:github` and the existing doctor checks. Deploy the Workflows
service to register the health and dependency tasks.

This App-based path needs Render and GitHub App credentials, but makes no model calls.
The full inherited factory setup still expects the agent harness's model key;
maintenance does not pass that key to its sandbox. The task gateway and its
existing bot filters are unchanged.

## Preview and start a sweep

Use a checkout matching the deployed configuration. The dispatcher resolves
each opted-in repository's current base-branch SHA and, in App mode, its installation.

```bash
npm run maintenance:dispatch -- --dry-run
npm run maintenance:dispatch
```

The dry run reads GitHub and prints the pinned input and idempotency key. It
creates no sandbox, Workflow run, or GitHub Check. Dispatch additionally needs
`RENDER_API_KEY` and `RENDER_WORKFLOW_SLUG`. Public mode needs no GitHub
credential. PAT mode needs `MAINTENANCE_GITHUB_TOKEN`; App mode needs
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, in local `.env` or the environment.

The default window is today's UTC date. Supply `--window YYYY-MM-DD` for a
specific window. The key includes the window, repository SHAs, and recipes,
so a retry in the same window can deduplicate while the same unchanged commit
can be tested the next day. Provider idempotency has bounded retention and can reuse an earlier run across
Workflow versions; it is not a permanent run ledger. Use a distinct key for a
fresh acceptance run after changing execution behavior.

For frequent scanning, `render.maintenance.yaml` specifies `examples-maintainer-scan`:

- build command: `npm ci`
- start command: `npm run maintenance:scan -- --wait`
- schedule: `0 */6 * * *` (every six hours, UTC)
- scoped Render key, workspace ID, Workflow slug, and maintenance mode through
  environment groups; GitHub credentials only when needed

The separate `examples-maintainer-daily` preserves full dependency verification
at 03:00 UTC. The scan schedule requires deployment and manual acceptance before
scheduling. Follow [dependency scanning](dependency-scanning.md) to inspect scan
results and select an update for full verification. The legacy combined
`maintenance:dependencies -- --wait` and health-only
`maintenance:dispatch -- --wait` remain available manually. No scan publishes a
GitHub artifact or counts as application verification.

## Interpret results

- `passed`: every configured stage passed and sandbox termination succeeded.
- `failed`: a stage returned a confirmed nonzero exit; later stages did not run.
- `infrastructure_error`: creation/preparation failed, an exit was unknown, or
  cleanup could not be confirmed.
- `reporting: failed`: GitHub did not confirm the Check write. The original
  verification and cleanup results are still in the Workflow result.

The result includes commit, recipe hash, smoke-runner hash, run ID, sandbox ID,
cleanup status, stage timings, exit codes, and bounded output. Check creation
is not retried after an ambiguous response; its external ID names the run for
reconciliation. There is no notification loop or repeated issue/comment spam.

A Workflow task completing successfully means it returned a report; consult
that report's status. A killed Workflow may never report, and `finally` cannot
run after a hard kill. The provider timeout is the cleanup backstop. Sandbox
creation with a lost response can leave an unknown ID until that timeout;
reconciliation and a durable run ledger remain follow-up work.

## Acceptance before scheduling

For App-mode health acceptance, use a disposable pilot repository authorized
for the App:

1. Run the healthy commit; require passing response and confirmed cleanup.
2. Change the returned text on a disposable branch and select a reachable
   commit; require `smoke: failed` and confirmed cleanup.
3. Restore the response; require recovery at the new commit.
4. Check that GitHub Checks name those exact SHAs and contain no raw app output.
5. Test a failed install and confirm later stages do not execute.

The current fresh checkout clones the configured base branch history; commits
outside that history are not supported yet. For the broken/recovered pilot,
use a dedicated configured test branch. Do not alter the published example for
this acceptance exercise.

Local tests exercise HTTP success, broken response, recovery, early process
exit, response deadlines, and process cleanup using disposable fixtures. SDK,
GitHub, and Workflow tests use fakes. These do not prove live Render execution.

## Next increments

- Broader Python package-manager support, managed-service fixtures, and explicit
  runtime/image selection.
- More reviewed repository recipes, retained dependency inventories, and
  searchable health history.
- Persistent candidate queueing, external triggers, and
  bounded repair rounds verified in separate sandboxes.
- Persistent coordination, cleanup reconciliation, and change-only digests.

Health-only tasks do not modify repositories. The dependency loop generates and
tests patches; its separately gated publisher can create or reuse draft PRs.
No maintenance task automatically merges changes or deploys an updated example.
