# Python maintenance pilot

The `pip` adapter supports one root `requirements.txt` containing at most 40
exact public package pins. Comments, blank lines, ordinary extras, and original
line endings are preserved. Names are normalized using Python's lowercase and
hyphen convention. Existing two-component and `.postN` version pins can remain
unchanged; candidate selection supports only ordinary stable `X.Y.Z` versions.
It stays in the installed major, and within the installed minor for `0.x`.
Prereleases and releases with yanked distributions are excluded.

Requirements directives, alternate indexes, editable installs, URLs, environment
markers, ranges, duplicate normalized names, and mixed Poetry/uv/Pipfile/project
layouts are rejected. This is intentionally a bounded adapter, not a general
PEP 440 resolver or support for every Python project format.

## Proposal and verification

The adapter reads actual installed distributions from `.venv` metadata without
importing project packages or running the project interpreter. A root-owned
helper runs under system `python3 -I -S`, validates regular files and link counts,
and opens path components without following symlinks. It rejects requirement
files larger than 180 KB, invalid UTF-8, and hard links.

A Python proposal changes exactly one version in `requirements.txt`. The host
checks the complete original and proposed text before generating the shared
patch artifact. The fresh candidate sandbox installs those exact pins using
wheels only, then runs the same configured checks as the baseline. Direct
installed versions other than the selected dependency must remain unchanged.

There is no separate generated transitive lockfile. Exact direct pins do not
make transitive resolution fully reproducible. The proposal records the exact
requirements file and tested direct versions; future uv/Poetry support must
retain and verify their actual lockfiles. Resolver conflicts are rejected by the
candidate install rather than repaired by broadening unrelated pins.

## Audit

`pip-audit==2.10.1` is installed in a separate root-owned audit virtual environment.
The tool executes as the unprivileged runner with isolated Python. Its input is
the complete exact installed inventory of the application's `.venv`, including
transitive distributions. It uses `--no-deps --disable-pip`, so auditing does not
resolve or modify the application environment. The parser requires every
installed package and exact version to appear in the response. Skipped packages,
incomplete output, errors, or inconsistent exit codes are unavailable results.

The PyPI audit service does not provide severity in this report format. Findings
therefore retain `unknown` severity and explicit fixed versions; no severity is
inferred from advisory names. Shared policy blocks newly introduced unknown
findings while preserving existing findings in the before/after evidence.
Repeated advisory IDs are deduplicated by package and ID; when duplicate records
disagree on fixed versions, only their intersection guides update selection.
Audit output is bounded and captured outside the runner-owned checkout.

## Django pilot

The pilot is `render-examples/django`, branch `main`. The inspected source was
`fbc60fcb44eebd63cfd45566e6973183e6f75aa4`. Its root requirements use exact pins.
A temporary SQLite database avoids production database credentials. Checks run
Django's system checks and migrations, followed by a Gunicorn HTTP smoke check of
`/` for the `Hello World!` page. The repository's test module is empty: these are
system, migration, and HTTP checks, not an application unit-test suite or a
verification of managed PostgreSQL behavior.

## Primary references

- [PyPI JSON API](https://docs.pypi.org/api/json/): metadata and yanked distribution information.
- [pip-audit](https://github.com/pypa/pip-audit): audit input, fixed versions, and isolation limitations.
- [Pinned pip-audit JSON formatter](https://github.com/pypa/pip-audit/blob/v2.10.1/pip_audit/_format/json.py): complete versus skipped dependencies and read-only result shape.
- [Django pilot source](https://github.com/render-examples/django/tree/fbc60fcb44eebd63cfd45566e6973183e6f75aa4).
