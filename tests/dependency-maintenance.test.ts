import { describe, expect, it, vi } from "vitest";
import { GitHubError } from "../app/github/index.js";
import { config } from "../app/config/index.js";
import type { Sandbox } from "../app/sandbox/index.js";
import { DependencyReviewResult, type DependencySnapshot, type MaintenanceResult, type DependencyCandidate } from "../app/schemas/index.js";
import { discoverUpdates } from "../app/workflows/dependencies/discovery.js";
import { buildArtifact } from "../app/workflows/dependencies/artifact.js";
import { runDependencyReview, type DependencyReviewDeps } from "../app/workflows/dependencies/review.js";
import { dependencySweep } from "../app/workflows/dependencies/index.js";
import { planDependencyMaintenance, waitForDependencyMaintenance } from "../scripts/lib/dependency-maintenance.js";
import { REPO } from "./fixtures/config.js";

const SHA = "a".repeat(40);
const input = { repo: REPO, sha: SHA, installationId: 7 };
const candidate: DependencyCandidate = {
	name: "express",
	section: "dependencies",
	fromRange: "^5.0.0",
	fromVersion: "5.0.1",
	toVersion: "5.2.0",
	toRange: "^5.2.0",
	kind: "minor",
};
const manifest = (range: string) =>
	`${JSON.stringify({ name: "fixture", scripts: { start: "node app.js" }, dependencies: { express: range } }, null, 2)}\n`;
function snapshot(after = false): DependencySnapshot {
	return {
		files: [
			{ path: "package.json", content: manifest(after ? candidate.toRange : candidate.fromRange) },
			{
				path: "package-lock.json",
				content: JSON.stringify({
					lockfileVersion: 3,
					packages: { "node_modules/express": { version: after ? candidate.toVersion : candidate.fromVersion } },
				}),
			},
		],
		installed: { express: after ? candidate.toVersion : candidate.fromVersion },
	};
}
function receipt(id: string): MaintenanceResult {
	return {
		repo: REPO,
		sha: SHA,
		runId: "run-1",
		recipeHash: "a".repeat(64),
		smokeRunnerHash: "b".repeat(64),
		status: "passed",
		sandboxId: id,
		cleanup: "terminated",
		reporting: "skipped",
		stages: [{ name: "runtime", status: "passed", exitCode: 0, durationMs: 1, output: "v24.22.1\n11.19.1" }],
	};
}
function world() {
	const state = {
		before: snapshot(),
		after: snapshot(true),
		changed: false,
		baselineFails: false,
		candidateFails: false,
		contentDrift: false,
		versionDrift: false,
		candidateCleanupFails: false,
	};
	const close = vi.fn(async () => {});
	const sandbox: Sandbox = { id: "sbx-generator", close, upload: vi.fn(), download: vi.fn(), exec: vi.fn() };
	let verifies = 0;
	const verify = vi.fn<NonNullable<DependencyReviewDeps["verify"]>>(async (_input, _id, hooks) => {
		const phase = verifies++ === 0 ? "baseline" : "candidate";
		const s = { ...sandbox, id: `sbx-${phase}` };
		expect(hooks.publish).toBe(false);
		await hooks.beforeInstall?.(s);
		const result = receipt(s.id);
		if ((phase === "baseline" && state.baselineFails) || (phase === "candidate" && state.candidateFails)) return { ...result, status: "failed" };
		try {
			await hooks.afterChecks?.(s);
		} catch {
			result.status = "infrastructure_error";
		}
		if (phase === "candidate" && state.candidateCleanupFails) {
			result.cleanup = "unconfirmed";
			result.status = "infrastructure_error";
		}
		return result;
	});
	const deps: DependencyReviewDeps = {
		verify,
		audit: vi.fn(async () => ({ tool: "npm" as const, status: "completed" as const, findings: [], scannedAt: new Date().toISOString() })),
		open: vi.fn(async () => sandbox),
		prepare: vi.fn(async () => {}),
		discover: vi.fn(async () => ({ candidates: [candidate], skipped: [] })),
		files: {
			install: vi.fn(async () => {}),
			update: vi.fn(async () => {
				state.changed = true;
			}),
			lock: vi.fn(async () => ({ exitCode: 0, output: "lock generated" })),
			apply: vi.fn(async () => {}),
			inspect: vi.fn(async (s, _manager, installed) => {
				const data = structuredClone(s.id === "sbx-baseline" || (s.id === "sbx-generator" && !state.changed) ? state.before : state.after);
				if (!installed) data.installed = {};
				if (s.id === "sbx-candidate" && state.contentDrift) data.files[0].content += " ";
				if (s.id === "sbx-candidate" && state.versionDrift) data.installed.express = "5.3.0";
				return data;
			}),
		},
	};
	return { state, deps, close, verify };
}

describe("dependency discovery", () => {
	const registry = (versions: Record<string, unknown>) => vi.fn(async () => Response.json({ versions }));
	it("selects a stable non-deprecated update in the installed major and preserves the range style", async () => {
		const fetch = registry({ "5.0.1": {}, "5.1.0": {}, "5.2.0": {}, "5.3.0": { deprecated: "removed" }, "6.0.0": {}, "5.4.0-beta.1": {} });
		expect(await discoverUpdates(snapshot(), fetch)).toEqual({ candidates: [candidate], skipped: [] });
		expect(fetch).toHaveBeenCalledWith(
			"https://registry.npmjs.org/express",
			expect.objectContaining({ headers: { Accept: "application/vnd.npm.install-v1+json" }, redirect: "error" }),
		);
	});
	it("limits pre-1.0 packages to patch updates", async () => {
		const s = snapshot();
		s.files[0].content = manifest("~0.2.0");
		s.installed.express = "0.2.1";
		const result = await discoverUpdates(s, registry({ "0.2.2": {}, "0.3.0": {}, "1.0.0": {} }));
		expect(result.candidates[0]).toMatchObject({ toVersion: "0.2.2", toRange: "~0.2.2", kind: "patch" });
	});
	it("does not propose a version already installed or a downgrade", async () => {
		expect((await discoverUpdates(snapshot(), registry({ "4.9.0": {}, "5.0.1": {} }))).candidates).toEqual([]);
	});
	it("does not resolve aliases, URLs, or complex ranges through an arbitrary registry", async () => {
		const s = snapshot();
		s.files[0].content = manifest("git+https://evil.test/repo");
		const fetch = registry({});
		expect(await discoverUpdates(s, fetch)).toEqual({ candidates: [], skipped: [{ name: "express", reason: "unsupported_range" }] });
		expect(fetch).not.toHaveBeenCalled();
	});
	it("records registry failures and invalid responses rather than claiming everything is current", async () => {
		for (const fetch of [vi.fn(async () => new Response("no", { status: 429 })), registry({ "5.2.0": null })]) {
			expect((await discoverUpdates(snapshot(), fetch)).skipped).toEqual([{ name: "express", reason: "registry_unavailable" }]);
		}
	});
});

describe("dependency artifacts", () => {
	it("retains an applicable unified patch, exact before/after contents, and deterministic identity", async () => {
		const artifact = await buildArtifact(SHA, "npm", candidate, snapshot(), snapshot(true));
		expect(artifact.patch).toContain("diff --git a/package.json b/package.json");
		expect(artifact.patch).toContain('+    "express": "^5.2.0"');
		expect(artifact.baseSha).toBe(SHA);
		expect((await buildArtifact(SHA, "npm", candidate, snapshot(), snapshot(true))).id).toBe(artifact.id);
	});
	it("rejects unrelated script edits, mismatched bases, changed paths, and malformed lockfiles", async () => {
		const script = snapshot(true);
		script.files[0].content = JSON.stringify({ dependencies: { express: candidate.toRange }, scripts: { start: "evil" } });
		const path = snapshot(true);
		path.files[1].path = "yarn.lock";
		const lock = snapshot(true);
		lock.files[1].content = "{}";
		for (const changed of [script, path, lock]) await expect(buildArtifact(SHA, "npm", candidate, snapshot(), changed)).rejects.toThrow();
		await expect(buildArtifact(SHA, "npm", { ...candidate, fromRange: "1.0.0" }, snapshot(), snapshot(true))).rejects.toThrow();
	});
});

describe("dependency review", () => {
	it("tests baseline and candidate separately and retains a reviewable patch only after exact-content verification", async () => {
		const w = world();
		const result = await runDependencyReview(input, "run-1", w.deps);
		expect(result.status).toBe("ready_for_review");
		expect(result.publishing).toBe("disabled");
		expect(result.artifact?.files).toHaveLength(2);
		expect(result.generation?.cleanup).toBe("terminated");
		expect(result.baseline?.sandboxId).not.toBe(result.verification?.sandboxId);
		expect(w.close).toHaveBeenCalledOnce();
	});
	it("retains HTTP status for a preflight failure without exposing response contents", async () => {
		const w = world();
		w.verify.mockRejectedValue(new GitHubError(403, "secret response", "secret response"));
		const result = await runDependencyReview(input, "run-1", w.deps);
		expect(result).toMatchObject({ status: "infrastructure_error", reason: "lookup_incomplete", lookupHttpStatus: 403 });
		expect(JSON.stringify(result)).not.toContain("secret response");
		expect(w.deps.open).not.toHaveBeenCalled();
	});
	it("stops before generating a patch when baseline auditing is unavailable", async () => {
		const w = world();
		w.deps.audit = async () => ({
			tool: "npm",
			status: "unavailable",
			reason: "execution_failed",
			findings: [],
			scannedAt: new Date().toISOString(),
		});
		const result = await runDependencyReview(input, "run-1", w.deps);
		expect(result).toMatchObject({ status: "infrastructure_error", reason: "audit_unavailable" });
		expect(w.deps.open).not.toHaveBeenCalled();
	});
	it("retains a passing candidate patch but blocks a new high severity advisory", async () => {
		const w = world();
		let calls = 0;
		w.deps.audit = async () => ({
			tool: "npm",
			status: "completed",
			scannedAt: new Date().toISOString(),
			findings:
				calls++ === 0
					? []
					: [{ id: "GHSA-abcd-efgh-ijkl", package: "express", version: candidate.toVersion, severity: "high", direct: true, fixVersions: [] }],
		});
		const result = await runDependencyReview(input, "run-1", w.deps);
		expect(result).toMatchObject({
			status: "security_blocked",
			reason: "security_regression",
			verification: { status: "passed", cleanup: "terminated" },
			audit: { comparison: { status: "blocked" } },
		});
		expect(result.artifact).toBeDefined();
	});
	it("never promotes a candidate whose final audit is unavailable", async () => {
		const w = world();
		let calls = 0;
		w.deps.audit = async () =>
			calls++ === 0
				? { tool: "npm", status: "completed", scannedAt: new Date().toISOString(), findings: [] }
				: { tool: "npm", status: "unavailable", reason: "invalid_output", scannedAt: new Date().toISOString(), findings: [] };
		expect(await runDependencyReview(input, "run-1", w.deps)).toMatchObject({
			status: "infrastructure_error",
			reason: "audit_unavailable",
			audit: { comparison: { status: "unavailable" } },
		});
	});
	it("stops before proposing updates when the baseline fails", async () => {
		const w = world();
		w.state.baselineFails = true;
		expect((await runDependencyReview(input, "run-1", w.deps)).status).toBe("baseline_failed");
		expect(w.deps.discover).not.toHaveBeenCalled();
		expect(w.deps.open).not.toHaveBeenCalled();
	});
	it("retains rejected candidate evidence without marking it ready", async () => {
		const w = world();
		w.state.candidateFails = true;
		const result = await runDependencyReview(input, "run-1", w.deps);
		expect(result.status).toBe("candidate_failed");
		expect(result.artifact).toBeDefined();
		expect(result.baseline?.status).toBe("passed");
	});
	it.each(["contentDrift", "versionDrift", "candidateCleanupFails"] as const)("does not recommend a candidate with %s", async (failure) => {
		const w = world();
		w.state[failure] = true;
		expect((await runDependencyReview(input, "run-1", w.deps)).status).toBe("infrastructure_error");
	});
	it("cleans up generation failures and does not expose exception contents", async () => {
		const w = world();
		if (!w.deps.files) throw new Error("Missing fixture");
		w.deps.files.lock = vi.fn(async () => {
			throw new Error("private-secret");
		});
		const result = await runDependencyReview(input, "run-1", w.deps);
		expect(result.status).toBe("generation_failed");
		expect(w.close).toHaveBeenCalledOnce();
		expect(w.verify).toHaveBeenCalledOnce();
		expect(JSON.stringify(result)).not.toContain("private-secret");
	});
	it("cannot recommend a patch when generation cleanup is unconfirmed", async () => {
		const w = world();
		w.close.mockRejectedValue(new Error("unavailable"));
		expect(await runDependencyReview(input, "run-1", w.deps)).toMatchObject({
			status: "infrastructure_error",
			generation: { cleanup: "unconfirmed" },
		});
		expect(w.verify).toHaveBeenCalledOnce();
	});
	it("distinguishes no update from an incomplete lookup", async () => {
		for (const unavailable of [false, true]) {
			const w = world();
			w.deps.discover = async () => ({ candidates: [], skipped: unavailable ? [{ name: "express", reason: "registry_unavailable" }] : [] });
			expect((await runDependencyReview(input, "run-1", w.deps)).status).toBe(unavailable ? "infrastructure_error" : "no_eligible_update");
			expect(w.deps.open).not.toHaveBeenCalled();
		}
	});
	it("rejects unconfigured targets and input commands before starting any work", async () => {
		const w = world();
		for (const bad of [
			{ ...input, repo: "acme/docs" },
			{ ...input, command: "evil" },
			{ ...input, sha: "main" },
		])
			await expect(runDependencyReview(bad, "run-1", w.deps)).rejects.toThrow();
		expect(w.verify).not.toHaveBeenCalled();
	});
});

describe("dependency scheduling", () => {
	it("uses its own daily identity and includes package-manager policy", async () => {
		const resolve = async () => ({ sha: SHA });
		const a = await planDependencyMaintenance(config, "2026-11-03", resolve);
		expect(a).toEqual(await planDependencyMaintenance(config, "2026-11-03", resolve));
		expect(a.idempotencyKey).not.toBe((await planDependencyMaintenance(config, "2026-11-04", resolve)).idempotencyKey);
		const other = structuredClone(config);
		other.repos[REPO].dependencyUpdates = { packageManager: "yarn1" };
		expect(a.idempotencyKey).not.toBe((await planDependencyMaintenance(other, "2026-11-03", resolve)).idempotencyKey);
	});
	it("continues after child failures and verifies each returned identity", async () => {
		let active = 0;
		let peak = 0;
		const run = vi.fn(async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			throw Error("failure");
		});
		const result = await dependencySweep.func({ metadata: {}, run }, { repositories: [input, { ...input, sha: "b".repeat(40) }] });
		expect(peak).toBe(1);
		expect(result.results.map((r) => r.status)).toEqual(["infrastructure_error", "infrastructure_error"]);
	});
	it("treats a completed sweep containing a rejected update as unhealthy", async () => {
		const result = await waitForDependencyMaintenance(async () => ({
			status: "completed",
			results: [{ completedAt: new Date().toISOString(), results: [{ repo: REPO, sha: SHA, status: "candidate_failed" }] }],
		}));
		expect(result.healthy).toBe(false);
		await expect(waitForDependencyMaintenance(async () => ({ status: "completed", results: [] }))).rejects.toThrow();
	});
	it("bounds result data and rejects unexpected fields", () => {
		expect(
			DependencyReviewResult.safeParse({
				repo: REPO,
				sha: SHA,
				runId: "r",
				status: "ready_for_review",
				publishing: "enabled",
				completedAt: new Date().toISOString(),
			}).success,
		).toBe(false);
	});
});
