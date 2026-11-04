import { describe, expect, it, vi } from "vitest";
import { config, requireRepo } from "../app/config/index.js";
import type { Sandbox } from "../app/sandbox/index.js";
import {
	type AuditReport,
	type DependencyCandidate,
	type DependencyScanResult,
	DependencyScanSweepResult,
	type DependencySnapshot,
} from "../app/schemas/index.js";
import { loadDependencyScan } from "../app/workflows/dependencies/load-scan.js";
import { type DependencyScanDeps, runDependencyScan } from "../app/workflows/dependencies/scan.js";
import { scanRecipeHash } from "../app/workflows/dependencies/scan-identity.js";
import { auditPriority, rankScanCandidates } from "../app/workflows/dependencies/scan-priority.js";
import { type SelectedDependencyDeps, verifySelectedDependency } from "../app/workflows/dependencies/verify-selected.js";
import { planDependencyScan, waitForMaintenanceTask } from "../scripts/lib/dependency-scanning.js";
import { REPO } from "./fixtures/config.js";

const SHA = "a".repeat(40);
const HASH = "b".repeat(64);
const NOW = Date.parse("2026-11-04T12:00:00Z");
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
const audit = (): AuditReport => ({
	tool: "npm",
	status: "completed",
	scannedAt: new Date(NOW).toISOString(),
	findings: [{ id: "GHSA-test", package: "express", version: "5.0.1", severity: "high", direct: true, fixVersions: ["5.2.0"] }],
});
const snapshot: DependencySnapshot = {
	files: [{ path: "package.json", content: JSON.stringify({ dependencies: { express: "^5.0.0" } }) }],
	installed: { express: "5.0.1" },
};
function scanWorld() {
	const state = { warm: false, closed: true, mutate: false, audited: false };
	const exec = vi.fn<Sandbox["exec"]>(async () => ({ exitCode: 0, stdout: "v24.0.0\n11.0.0", stderr: "" }));
	const sandbox: Sandbox = { id: "sbx-scan", exec, close: vi.fn(), upload: vi.fn(), download: vi.fn() };
	const deps: DependencyScanDeps = {
		withPrepared: async (_repo, options, use) => {
			options.onSandbox?.(sandbox.id);
			try {
				if (!state.warm) await options.prepare(sandbox);
				options.onCache?.({ status: state.warm ? "hit" : "created", key: options.key });
				await options.inspect(sandbox);
				return await use(sandbox);
			} finally {
				options.onCleanup?.(state.closed);
			}
		},
		prepare: vi.fn(async () => {}),
		toolHash: async () => HASH,
		files: {
			install: vi.fn(),
			apply: vi.fn(),
			update: vi.fn(),
			lock: vi.fn(),
			inspect: vi.fn(async () => {
				const data = structuredClone(snapshot);
				if (state.mutate && state.audited) data.installed.express = "6.0.0";
				return data;
			}),
		},
		audit: vi.fn(async () => {
			state.audited = true;
			return audit();
		}),
		discover: vi.fn(async () => ({ candidates: [candidate], skipped: [] })),
	};
	return { state, exec, deps, run: () => runDependencyScan(input, "trn-scan", deps) };
}
function retained(): DependencyScanResult {
	return {
		repo: REPO,
		sha: SHA,
		runId: "trn-scan",
		status: "completed",
		completedAt: new Date(NOW).toISOString(),
		recipeHash: scanRecipeHash(requireRepo(REPO, 7)),
		toolHash: HASH,
		inventoryHash: HASH,
		runtime: "v24",
		sandboxId: "sbx-scan",
		cleanup: "terminated",
		audit: audit(),
		discovery: { candidates: [candidate], skipped: [] },
		rankedCandidates: rankScanCandidates([candidate], audit()),
		priority: "high",
		unratedFindings: 0,
		priorityBasis: "reported_severity_and_fix_metadata",
		exploitation: "not_assessed",
		reachability: "not_assessed",
		verification: "not_run",
		publishing: "disabled",
	};
}
function selectionWorld() {
	const evidence = retained();
	const deps: SelectedDependencyDeps = {
		loadScan: vi.fn(async () => ({ scan: evidence, input })),
		now: () => NOW,
		toolHash: async () => HASH,
		resolveRevision: vi.fn(async () => ({ sha: SHA, installationId: 7 })),
		runReview: vi.fn(async () => ({
			repo: REPO,
			sha: SHA,
			runId: "trn-review",
			status: "baseline_failed",
			publishing: "disabled",
			completedAt: new Date(NOW).toISOString(),
		})),
	};
	return { evidence, deps, run: () => verifySelectedDependency({ repo: REPO, scanRunId: "trn-scan", candidateName: "express" }, deps) };
}

describe("scan workload boundaries", () => {
	it("audits and discovers without builds, smoke, updates, or publication", async () => {
		const w = scanWorld();
		expect(await w.run()).toMatchObject({
			status: "completed",
			cleanup: "terminated",
			verification: "not_run",
			publishing: "disabled",
			priority: "high",
			snapshot: { status: "created" },
		});
		expect(w.deps.files?.update).not.toHaveBeenCalled();
		expect(w.deps.files?.lock).not.toHaveBeenCalled();
		const commands = w.exec.mock.calls.map((c) => c[0]).join("\n");
		expect(commands).toContain("--ignore-scripts");
		expect(commands).not.toMatch(/npm run build|npm start|npm test/);
	});
	it("refreshes advisory evidence on a warm scan without reinstalling", async () => {
		const w = scanWorld();
		w.state.warm = true;
		expect(await w.run()).toMatchObject({ status: "completed", snapshot: { status: "hit" } });
		expect(w.deps.prepare).not.toHaveBeenCalled();
		expect(w.deps.audit).toHaveBeenCalledOnce();
		expect(w.deps.discover).toHaveBeenCalledOnce();
	});
	it("does not turn an unavailable audit into a healthy scan", async () => {
		const w = scanWorld();
		w.deps.audit = async () => ({
			tool: "npm",
			status: "unavailable",
			reason: "execution_failed",
			findings: [],
			scannedAt: new Date(NOW).toISOString(),
		});
		expect(await w.run()).toMatchObject({ status: "incomplete", priority: "needs_triage", reason: "audit_unavailable" });
		expect(w.deps.discover).not.toHaveBeenCalled();
	});
	it.each(["cleanup", "inventory"])("fails closed on unconfirmed %s", async (kind) => {
		const w = scanWorld();
		if (kind === "cleanup") w.state.closed = false;
		else w.state.mutate = true;
		expect(await w.run()).toMatchObject({ status: "infrastructure_error", reason: "unconfirmed_execution" });
	});
	it("retains policy exclusions without failing an otherwise completed scan", async () => {
		const w = scanWorld();
		w.deps.discover = async () => ({ candidates: [candidate], skipped: [{ name: "packaging", reason: "unsupported_range" }] });
		expect(await w.run()).toMatchObject({
			status: "completed",
			discovery: { candidates: [candidate], skipped: [{ name: "packaging", reason: "unsupported_range" }] },
			verification: "not_run",
		});
	});
	it.each(["registry_unavailable", "unresolved_version"] as const)("retains incomplete discovery for %s", async (reason) => {
		const w = scanWorld();
		w.deps.discover = async () => ({ candidates: [candidate], skipped: [{ name: "other", reason }] });
		expect(await w.run()).toMatchObject({ status: "incomplete", reason: "discovery_incomplete", priority: "high" });
	});
});
describe("evidence based urgency", () => {
	it("keeps unknown severity in triage and uses baseline critical severity", () => {
		const report = audit();
		report.findings[0].severity = "unknown";
		expect(auditPriority(report)).toBe("needs_triage");
		expect(rankScanCandidates([candidate], report)[0]).toMatchObject({ priority: "needs_triage", fixEvidence: "reported_version" });
		report.findings.push({ ...report.findings[0], id: "GHSA-critical", severity: "critical", direct: false });
		expect(auditPriority(report)).toBe("critical");
		expect(rankScanCandidates([candidate], report)[0].relatedFindings).toBe(1);
	});
	it("does not infer an unreported fixed version or a direct link for transitive findings", () => {
		const report = audit();
		report.findings[0].direct = false;
		expect(rankScanCandidates([candidate], report)[0]).toMatchObject({ priority: "maintenance", relatedFindings: 0, fixEvidence: "not_reported" });
	});
});
describe("explicit selected verification", () => {
	it("passes exact retained candidate/source into the independent full review", async () => {
		const w = selectionWorld();
		expect(await w.run()).toMatchObject({
			status: "rejected",
			reviewRunId: "trn-review",
			reviewStatus: "baseline_failed",
			reason: "verification_failed",
		});
		expect(w.deps.runReview).toHaveBeenCalledWith({ ...input, selectedCandidate: candidate });
	});
	it.each(["stale", "source", "recipe", "tool", "target", "candidate", "incomplete"])("refuses %s evidence before expensive work", async (kind) => {
		const w = selectionWorld();
		if (kind === "stale") w.evidence.audit = { ...audit(), scannedAt: new Date(NOW - 7 * 3600_000).toISOString() };
		if (kind === "source") w.deps.resolveRevision = async () => ({ sha: "c".repeat(40) });
		if (kind === "recipe") w.evidence.recipeHash = "c".repeat(64);
		if (kind === "tool") w.evidence.toolHash = "c".repeat(64);
		if (kind === "target") w.evidence.repo = "acme/docs";
		if (kind === "candidate" && w.evidence.discovery) w.evidence.discovery.candidates = [];
		if (kind === "incomplete") w.evidence.status = "incomplete";
		expect((await w.run()).status).not.toBe("verified");
		expect(w.deps.runReview).not.toHaveBeenCalled();
	});
	it("rejects caller supplied patches or candidate versions", async () => {
		const w = selectionWorld();
		await expect(verifySelectedDependency({ repo: REPO, scanRunId: "trn-scan", candidateName: "express", candidate }, w.deps)).rejects.toThrow();
		expect(w.deps.loadScan).not.toHaveBeenCalled();
	});
});
describe("retained scan authority", () => {
	function world() {
		const evidence = retained();
		const data: Record<string, unknown> = {
			"/task-runs/trn-scan": { id: "trn-scan", taskId: "tsk-scan", status: "completed", input: [input], results: [evidence] },
			"/task-runs/trn-select": { id: "trn-select", taskId: "tsk-select", status: "running" },
			"/tasks/tsk-scan": { id: "tsk-scan", name: "dependency-scan", workflowId: "wfl-maintenance" },
			"/tasks/tsk-select": { id: "tsk-select", name: "dependency-verify-selected", workflowId: "wfl-maintenance" },
		};
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => Response.json(data[new URL(String(url)).pathname.replace(/^\/v1/, "")]));
		return { data, evidence, fetch, run: () => loadDependencyScan("trn-scan", "trn-select", { fetch, token: "test" }) };
	}
	it("accepts matching provider owned task results and inputs", async () => {
		const w = world();
		expect(await w.run()).toEqual({ scan: w.evidence, input });
	});
	it.each(["task", "workflow", "running", "target"])("rejects wrong %s authority", async (kind) => {
		const w = world();
		if (kind === "task") w.data["/tasks/tsk-scan"] = { id: "tsk-scan", name: "dependency-review", workflowId: "wfl-maintenance" };
		if (kind === "workflow") w.data["/tasks/tsk-select"] = { id: "tsk-select", name: "dependency-verify-selected", workflowId: "wfl-other" };
		if (kind === "running") w.data["/task-runs/trn-scan"] = { id: "trn-scan", taskId: "tsk-scan", status: "running" };
		if (kind === "target") w.evidence.sha = "c".repeat(40);
		await expect(w.run()).rejects.toThrow();
	});
});
describe("scan dispatch", () => {
	it("deduplicates within six hours and refreshes unchanged commits next window", async () => {
		const resolve = async () => ({ sha: SHA });
		const a = await planDependencyScan(config, "2026-11-04T06:00:00Z", resolve);
		const b = await planDependencyScan(config, "2026-11-04T11:59:59Z", resolve);
		const c = await planDependencyScan(config, "2026-11-04T12:00:00Z", resolve);
		expect(a.idempotencyKey).toBe(b.idempotencyKey);
		expect(a.idempotencyKey).not.toBe(c.idempotencyKey);
	});
	it("waits for provider completion and does not infer success from running state", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce({ status: "running" })
			.mockResolvedValueOnce({ status: "completed", results: [{ completedAt: new Date(NOW).toISOString(), results: [] }] });
		expect(await waitForMaintenanceTask(get, DependencyScanSweepResult, { sleep: async () => {} })).toHaveProperty("results", []);
	});
});
