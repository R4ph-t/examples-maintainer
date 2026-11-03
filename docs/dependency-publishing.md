# Draft dependency proposals

The publisher consumes a retained, completed `dependency-review` run. Its input
contains only the configured repository, review run ID, and optional GitHub App
installation ID. The Workflows controller loads the result and verifies the
source task belongs to the same configured Workflow. A caller cannot submit a
patch or a claimed passing review in the task input.

Publication is off by default. Both controls are required:

- `MAINTENANCE_PUBLISH_DRAFTS=true` on the controller; and
- `dependencyUpdates.publishDrafts: true` on the selected repository.

Public maintenance mode always disables the production publisher. PAT mode uses
only `MAINTENANCE_GITHUB_TOKEN`; it never falls back to `GH_TOKEN`. App mode uses a
repository-restricted installation token. The credential needs repository
Contents and Pull requests write access, and remains in the controller. No token
is staged in the dependency sandboxes. Keep both controls off until GitHub access
is approved and the publication path is ready to enable.

## Evidence required

The source result must be `ready_for_review`, with three distinct, confirmed
terminated sandboxes. The publisher checks the recipe and smoke-runner hashes
against the current deployed configuration, every required stage and exit code,
the matching runtime evidence, and successful artifact generation.

The baseline and candidate audit reports must both be completed, belong to the
configured package manager, and be at most 24 hours old. The overall review must
also be at most 24 hours old. The publisher independently recomputes the audit
comparison and requires it to match the saved result with no newly introduced
high, critical, or unknown-severity finding. An existing advisory escalating into
one of those severities also blocks publication.

The artifact is rebuilt from its original and proposed file contents using the
same package-manager-specific validator as the review. Its digest, complete
files, and generated diff must match. The original file blob hashes must match
the pinned GitHub commit. The publisher computes the complete expected root Git
tree locally, preserving every unrelated file, directory, mode, and submodule.
GitHub must reproduce that exact tree before a branch is created.

## Durable behavior

Each proposal has a deterministic branch:

```text
maintenance/deps-<full artifact SHA-256>
```

The artifact identity includes the pinned base SHA, selected dependency update,
and exact original/proposed contents. A repeated review of the same change uses
the same branch even if its Workflow run ID differs. Commits and PR bodies carry
a persistent artifact marker.

An existing branch is reused only when its complete tree, single parent, and
marker match the proposal. The publisher never updates or force-pushes a branch.
An existing draft PR is reused only when its author is the configured credential
identity, repository/branch targets and head commit match, and its marker is
intact. Existing PR text is never rewritten. A closed PR suppresses another PR
for the same artifact, including after the head branch is deleted. A human-edited
branch, removed marker, retargeted PR, or PR made ready for review causes the
publisher to stop and preserve that work.

Blob/tree creation can be retried because their identities are content-addressed.
Ref and PR POST requests are not blindly retried. After an ambiguous response,
the publisher reads the deterministic branch or PR and verifies its identity.
Concurrent invocations converge on one branch and draft. If reconciliation
cannot confirm the write, the result is `unknown`; inspect the named branch/run
before attempting more work. Unreachable Git objects may remain after a failed
attempt, but no unrelated branch is moved or removed.

The base branch is checked before publishing, immediately before branch
creation, and before and after draft creation. GitHub's PR creation API does not
provide an atomic expected-base guard: a simultaneous base push can leave a draft
whose result is reported as `stale`. The draft identifies its tested base; a human
must revalidate it before merging. This publisher cannot merge, approve, close,
delete, or rewrite a proposal.

## Results and validation

The result distinguishes `disabled`, `published`, `reused`, `suppressed`, `stale`,
`rejected`, and `unknown`, with bounded reason codes and the artifact/branch/PR
identity when known. Unexpected exception bodies and repository command output
are never copied into the result or PR body.

The local tests use fake GitHub operations and real Git object calculation to
cover exact-tree publication, tampering, stale or regressed evidence, changed
bases, human edits, closed proposals, lost responses, and overlapping callers.
These tests do not prove approved GitHub credentials or a live PR creation. Live
publication remains a separately gated operation.

GitHub API references: [Git trees](https://docs.github.com/en/rest/git/trees),
[Git references](https://docs.github.com/en/rest/git/refs), and
[pull requests](https://docs.github.com/en/rest/pulls/pulls).
