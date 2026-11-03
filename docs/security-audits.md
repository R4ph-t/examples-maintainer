# Security checks for dependency proposals

Each supported dependency review audits the installed baseline and the exact
candidate that passed the application's verification recipe. Audit results are
separate evidence from build/startup tests: a clean vulnerability report cannot
prove that the application remains compatible.

Node adapters use `npm audit --json` or pinned Yarn Classic 1.22.22's
`yarn audit --json`. npm is directed to the public npm registry. Yarn Classic's
audit implementation uses its public registry audit endpoint; the repository's
existing `registry.yarnpkg.com` egress allowance must remain available. An
unsupported endpoint, timeout, malformed report, missing terminal summary, or
lost command exit is **unavailable**, never a clean scan. Python's adapter can
return the same schema using `pip-audit`.

## Comparison policy

The normalized report records advisory identity, package, known installed
version, severity, direct/transitive relationship where available, and reported
fixed versions. npm does not supply every installed transitive version; those
versions are explicitly null. Multiple vulnerable instances of the same
advisory/package are combined, keeping the highest reported severity. If their
versions differ, the combined version is null.

Comparison uses advisory identity plus package, not installed version. Upgrading
without removing an advisory leaves it in `remaining`; it is not counted as a
fix. The report separates fixed, remaining, and newly introduced findings.
New high, critical, or unknown-severity findings block a proposal. A persisting
advisory whose severity rises to one of those levels also blocks. Existing
high/critical/unknown findings remain visible and do not by themselves block an
otherwise improving update. Both scans must be complete and use the same tool.
This policy does not label a passing comparison "vulnerability-free".

Eligible direct dependencies with an explicitly reported matching fixed version
are considered first, followed by directly affected packages. Other candidates
retain their deterministic order. Priority is a reason to test a candidate,
not proof that it fixes an advisory; the post-update audit supplies that evidence.
The selector does not infer that a parent's update fixes every transitive issue.
It never runs `audit fix` or `--force`.

## Execution and output boundaries

Audit commands run as the unprivileged sandbox runner with its scrubbed
environment. Pinned Yarn is installed with lifecycle scripts disabled into a
root-owned directory outside the checkout and invoked by its exact path; repo
binaries and the runner cache cannot replace the auditor. npm receives distinct
empty root-owned user/global config files. A parent shell captures stdout to a randomly named root-owned file
outside the checkout, with a guest timeout and file-size limit. The controller
requires the confirmed exit, downloads the bounded file, validates UTF-8 and
JSON, checks scanner exit semantics, and normalizes only bounded fields. Raw
stdout, response bodies, error messages, and advisory prose are not published.

npm's vulnerability exit 1 is expected; a matching complete report is required.
Yarn's severity bitmask must match its terminal summary and reported advisory
severities. A partial JSON-lines stream cannot be mistaken for a clean scan.
Each normalized report is limited to 200 findings and 64 KB; a comparison is
limited to 128 KB. Over-limit reports become unavailable. Guest command time is
bounded to 120 seconds, with a 130-second controller timeout and a bounded
result download. Protected Yarn installation has a separate 120-second guest
limit and 130-second controller timeout. File cleanup is attempted before the surrounding sandbox is
terminated by the existing review lifecycle.

## References

- [npm audit command and exit semantics](https://docs.npmjs.com/cli/v11/commands/npm-audit/)
- [Yarn Classic audit and JSON-lines output](https://classic.yarnpkg.com/lang/en/docs/cli/audit/)
- [Yarn audit implementation and registry endpoint](https://github.com/yarnpkg/yarn/blob/master/src/cli/commands/audit.js)
- [npm audit report format](https://github.com/npm/cli/blob/latest/workspaces/arborist/lib/audit-report.js)

These scanners detect published advisories. They are not a complete malware
scanner, proof of exploitability, or substitute for application tests and review.
