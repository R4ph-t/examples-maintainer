# Personal draft PR acceptance

This branch targets only R4ph-t/express-hello-world (main) and R4ph-t/django-mlpc1ydx (master). Deploy it to a separate manually triggered Workflow, with automatic deploys off and no cron. The daily maintainer stays on feat/repository-maintenance.

Run fresh dependency reviews, then invoke the unchanged dependency-publish task with each completed review ID. Require draft status, exact tested files and base SHA, and no extra changed paths. Invoke publication again and require reused with the same PR number and commit. Never merge these PRs.

The controller needs a fine-grained personal token restricted to these repositories with Contents and Pull requests read/write, plus MAINTENANCE_MODE=pat and MAINTENANCE_PUBLISH_DRAFTS=true. Both recipes opt in to draft publication. Keep the GitHub credential out of sandboxes. Use the existing dedicated scoped Render key.

Public mode can run the reviews before the token is configured. Review evidence remains valid across the subsequent authentication-only deployment when the exact source, recipe, runtime and audit checks still match. Disable publication after acceptance; retain drafts for inspection.
