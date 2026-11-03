# Example maintenance

This fork adds a model-free health check to software-factory. The first pilot
is `render-examples/express-hello-world`. It installs dependencies in a new
Render Sandbox, checks JavaScript syntax, starts the server, and verifies that
`GET /` returns HTTP 200 and contains `Hello from Render!`.

The pilot has no build or unit-test script; the result does not invent those
checks. It also does not exercise browser assets or prove a Render deployment.

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

The configured pilot now includes Express JavaScript, Express TypeScript, and
Hapi. `npm run maintenance:inventory` distinguishes configured repos from those
still needing a reviewed recipe.

## What runs

`verify-repository` accepts a configured repository, GitHub App installation
ID in App mode, and exact 40-character commit SHA. Its recipe comes only from this
service's deployed `factory.config.ts`, never task input or the target repo.

Each run:

1. Creates an empty sandbox with an HTTPS allow-list and a 30-minute runtime timeout.
2. Prepares the factory's unprivileged user and clones the exact commit.
3. Deletes and checks clone credentials before running repository code.
4. Records Node/npm versions and runs install and configured checks in order.
5. Starts the application, checks its localhost response, and stops its process
   group, including descendants that outlive their parent.
6. Terminates the sandbox, recording whether termination was confirmed.
7. Publishes one completed GitHub Check on the tested commit.

No dependency snapshot is restored or created. Every command has a guest
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

The example in `factory.config.ts` is ready for the Express pilot. Add a
`maintenance` object to opt another repository in:

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
The first version uses the factory's existing base runtime (Node >=22), records
its actual version, and does not pin an image digest or provision databases.
Python and database fixtures are follow-up work.

The Express pilot uses its existing Yarn v1 lockfile. The recipe invokes pinned
Yarn 1.22.22 through npm exec and installs with `--frozen-lockfile`; both registry
hosts are allow-listed. This preserves the example's documented package manager.
A separate dependency refresh mode is follow-up work.

## PAT authentication for the scheduled maintainer

The scheduled maintenance path can use `MAINTENANCE_GITHUB_TOKEN` instead of a
GitHub App. This is an explicit controller credential; it does not use an
ambient `GH_TOKEN`. When set, it takes precedence over App credentials for
maintenance only. The inherited issue-to-PR agent workflows still use the App.

For public examples, the controller validates repository visibility, resolves
the commit through the API, and clones anonymously in the sandbox. No PAT,
App token, or model key enters that sandbox. Private or renamed repositories
are refused before creating a sandbox; private PAT cloning is not implemented.

Create a fine-grained PAT for the organization and selected repositories.
Current verification needs Contents read and Commit statuses write. The planned
patch/PR phase additionally needs Contents write and Pull requests write.
The token acts with the user's existing access; organization approval and token
expiry still apply. A pending approval is not usable write access.

Save the token in ignored local `.env`, or the controller's Render environment
group. Never put it in a recipe, task input, guest environment, or git remote.
With `RENDER_API_KEY` and `RENDER_WORKSPACE_ID` also configured, run one live
verification without a hosted Workflow:

```bash
npm run maintenance:verify -- --repo render-examples/express-hello-world
```

This command creates a sandbox and publishes a status. It fails if verification,
cleanup, or publication fails. `maintenance:dispatch -- --dry-run` performs only
read operations. PAT dispatch inputs omit `installationId`; App dispatch inputs
still include it.

PATs publish commit statuses under `examples-maintainer / health`, mapping
infrastructure failures to `error`. GitHub reserves Check Run creation for Apps.
The result's `checkUrl` points to the status API resource in PAT mode. Detailed
stage output remains in the Workflow result (or CLI JSON), not on GitHub. Status
writes are not retried after an ambiguous response.

For hosting, use `npm run start:maintenance` to register only the two maintenance
tasks. It needs the three variables in `SERVICE_ENV.maintenance`, supplied through
the `examples-maintainer` environment group in `MAINTENANCE_ENV_GROUPS`. No
webhook gateway, App installation, or model provider key is needed. The inherited
`setup:render` and doctor commands remain specific to the full App-based factory;
they do not provision or validate this standalone deployment.

## Prepare the App-based deployment

Follow the existing [setup runbook](runbooks/setup.md) for the fork. Keep its
human checkpoints for App installation, credentials, paid services, and webhook
activation. This change itself does not deploy or schedule anything.

The App now needs `checks: write`, in addition to its existing permissions.
Update the App and accept the installation's new permission, then rerun
`npm run setup:github` and the existing doctor checks. Deploy the Workflows
service to register `verify-repository` and `maintenance-sweep`.

This feature needs Render and GitHub App credentials, but makes no model calls.
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
`RENDER_API_KEY` and `RENDER_WORKFLOW_SLUG`; both commands need
`MAINTENANCE_GITHUB_TOKEN`, or `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`,
in local `.env` or the environment.

The default window is today's UTC date. Supply `--window YYYY-MM-DD` for a
specific window. The key includes the window, repository SHAs, and recipes,
so a retry in the same window can deduplicate while the same unchanged commit
can be tested the next day. The SDK's start idempotency lasts 24 hours and is
scoped to the deployed Workflow version; it is not a permanent run ledger.

For a daily schedule, configure one Render Cron Job from this fork with:

- build command: `npm ci`
- start command: `npm run maintenance:dispatch`
- schedule: `0 3 * * *` (03:00 UTC; 04:00 or 05:00 in Paris)
- the four dispatcher variables above, supplied through environment groups

`render.maintenance.yaml` includes the daily Cron Job. Start scheduling only
after the manual acceptance run. The dispatcher returns the parent run ID; without `--wait` it
does not wait for tests to finish. The scheduled job uses `--wait` and exits
nonzero for an unhealthy sweep. Inspect Workflow results and
commit Checks for outcomes.

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

Use a disposable pilot repository authorized for the App:

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

- Python/database recipes and explicit runtime image selection.
- Retained dependency inventories and searchable health history.
- Renovate candidate triggers, baseline/candidate comparison, and bounded
  repairs verified in a separate sandbox.
- Persistent coordination, cleanup reconciliation, and change-only digests.

No dependency updates, repository patches, PRs, merges, or deployments are
performed by these maintenance tasks.
