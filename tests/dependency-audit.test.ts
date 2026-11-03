import { describe, expect, it, vi } from "vitest";
import type { Sandbox } from "../app/sandbox/index.js";
import { AuditReport, type AuditFinding } from "../app/schemas/audits.js";
import type { DependencyCandidate } from "../app/schemas/dependencies.js";
import { auditSandbox, compareAuditReports, normalizeAudit, prioritizeCandidates, unavailableAudit } from "../app/workflows/dependencies/audit.js";

const finding: AuditFinding = {
	id: "GHSA-abcd-1234-5678",
	package: "express",
	version: "5.0.0",
	severity: "high",
	direct: true,
	fixVersions: ["5.3.0"],
};
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
const advisory = { source: 1234, name: "express", severity: "high", url: "https://github.com/advisories/GHSA-abcd-1234-5678" };
const npm = (vulnerable = true) => ({
	auditReportVersion: 2,
	vulnerabilities: vulnerable
		? {
				express: {
					name: "express",
					isDirect: true,
					severity: "high",
					via: [advisory],
					fixAvailable: { name: "express", version: "5.3.0", isSemVerMajor: false },
				},
			}
		: {},
	metadata: { vulnerabilities: { ...counts, high: vulnerable ? 1 : 0, total: vulnerable ? 1 : 0 } },
});
function report(findings: AuditFinding[] = [], tool: "npm" | "yarn1" | "pip-audit" = "npm") {
	return AuditReport.parse({ tool, status: "completed", findings, scannedAt: "2026-11-03T00:00:00Z" });
}
function yarn(vulnerable = true) {
	return [
		{ type: "info", data: "Audit started" },
		...(vulnerable
			? [
					{
						type: "auditAdvisory",
						data: {
							advisory: {
								id: 1234,
								module_name: "express",
								severity: "high",
								url: advisory.url,
								patched_versions: ">=5.3.0",
								findings: [{ version: "5.0.0" }],
							},
							resolution: { path: "express" },
						},
					},
				]
			: []),
		{ type: "auditSummary", data: { vulnerabilities: { ...counts, high: vulnerable ? 1 : 0 } } },
		{ type: "finished", data: 1 },
	]
		.map((event) => JSON.stringify(event))
		.join("\n");
}
function candidate(name: string, toVersion = "5.3.0"): DependencyCandidate {
	return { name, section: "dependencies", fromRange: "^5.0.0", fromVersion: "5.0.0", toRange: `^${toVersion}`, toVersion, kind: "minor" };
}

describe("audit normalization", () => {
	it("accepts npm's nonzero vulnerability exit, preserving advisory identity and explicit fixes", () => {
		expect(normalizeAudit("npm", JSON.stringify(npm()), 1, { express: "5.0.0" })).toMatchObject({ status: "completed", findings: [finding] });
		expect(normalizeAudit("npm", JSON.stringify(npm(false)), 0)).toMatchObject({ status: "completed", findings: [] });
	});
	it("does not invent an installed transitive version or a fixed version from a boolean remediation", () => {
		const raw = npm();
		const vulnerability = { ...raw.vulnerabilities.express, isDirect: false, fixAvailable: true };
		const result = normalizeAudit("npm", JSON.stringify({ ...raw, vulnerabilities: { express: vulnerability } }), 1);
		expect(result.findings).toEqual([{ ...finding, version: null, direct: false, fixVersions: [] }]);
	});
	it("retains the underlying advisory once through npm's transitive metadata", () => {
		const raw = npm();
		const meta = { name: "parent", isDirect: true, severity: "high", via: ["express"], fixAvailable: false };
		const result = normalizeAudit(
			"npm",
			JSON.stringify({
				...raw,
				vulnerabilities: { ...raw.vulnerabilities, parent: meta },
				metadata: { vulnerabilities: { ...counts, high: 2, total: 2 } },
			}),
			1,
		);
		expect(result.status).toBe("completed");
		expect(result.findings).toHaveLength(1);
	});
	it.each([
		[JSON.stringify({ error: { code: "ENOAUDIT", summary: "private response" } }), 1],
		[JSON.stringify(npm()), 0],
		[JSON.stringify(npm(false)), 1],
		['{"auditReportVersion":2', 0],
		[JSON.stringify({ ...npm(), metadata: { vulnerabilities: { ...counts, total: 1 } } }), 1],
		[JSON.stringify({ ...npm(), vulnerabilities: { express: { ...npm().vulnerabilities.express, via: ["missing"] } } }), 1],
		[JSON.stringify({ ...npm(), vulnerabilities: { express: { ...npm().vulnerabilities.express, via: ["express"] } } }), 1],
	])("refuses incomplete, inconsistent, or error npm output", (text, exitCode) => {
		const r = normalizeAudit("npm", text, exitCode);
		expect(r).toMatchObject({ status: "unavailable", findings: [], reason: "invalid_output" });
		expect(JSON.stringify(r)).not.toContain("private response");
	});
	it("requires Yarn's terminal summary and exact vulnerability severity mask", () => {
		expect(normalizeAudit("yarn1", yarn(), 8, { express: "5.0.0" })).toMatchObject({ status: "completed", findings: [finding] });
		expect(normalizeAudit("yarn1", yarn(false), 0)).toMatchObject({ status: "completed", findings: [] });
		for (const [text, code] of [
			[yarn(), 0],
			[yarn(false), 8],
			[yarn().split("\n").slice(0, 2).join("\n"), 8],
			[`${yarn()}\n{`, 8],
			[`${yarn()}\n${JSON.stringify({ type: "error", data: "upstream failure" })}`, 8],
		] as const) {
			expect(normalizeAudit("yarn1", text, code).status).toBe("unavailable");
		}
	});
	it("collapses duplicate Yarn paths and does not convert a complex patched range into a fixed version", () => {
		const lines = yarn().split("\n");
		const event = JSON.parse(lines[1]);
		event.data.advisory.patched_versions = ">=4.0.0 <5.0.0 || >=5.3.0";
		event.data.advisory.findings.push({ version: "5.1.0" });
		lines[1] = JSON.stringify(event);
		lines.splice(2, 0, lines[1]);
		const r = normalizeAudit("yarn1", lines.join("\n"), 8, { express: "5.0.0" });
		expect(r.findings).toEqual([{ ...finding, version: null, fixVersions: [] }]);
	});
	it("treats oversized output as unavailable, even if its prefix contains a valid clean report", () => {
		expect(normalizeAudit("npm", JSON.stringify(npm(false)) + " ".repeat(512_001), 0)).toMatchObject({
			status: "unavailable",
			reason: "output_too_large",
		});
	});
});

describe("audit policy", () => {
	it("compares advisory identity across versions and distinguishes fixed, remaining, and newly introduced findings", () => {
		const old = { ...finding, id: "GHSA-fixed-1234-5678" };
		const added = { ...finding, id: "GHSA-added-1234-5678", severity: "low" as const };
		const r = compareAuditReports(report([old, finding]), report([{ ...finding, version: "5.3.0" }, added]));
		expect(r).toMatchObject({ status: "passed", fixed: [old], introduced: [added], remaining: [{ ...finding, version: "5.3.0" }], blocking: [] });
	});
	it.each(["high", "critical", "unknown"] as const)("blocks newly introduced %s findings", (level) => {
		expect(compareAuditReports(report(), report([{ ...finding, severity: level }]))).toMatchObject({
			status: "blocked",
			blocking: [{ severity: level }],
		});
	});
	it("blocks severity escalation but allows an existing unknown finding to remain visible", () => {
		expect(compareAuditReports(report([{ ...finding, severity: "low" }]), report([finding])).status).toBe("blocked");
		const r = compareAuditReports(
			report([{ ...finding, severity: "unknown" }], "pip-audit"),
			report([{ ...finding, severity: "unknown", version: "5.3.0" }], "pip-audit"),
		);
		expect(r.status).toBe("passed");
		expect(r.remaining).toHaveLength(1);
	});
	it("cannot pass a comparison with a missing scanner result or a different scanner", () => {
		expect(compareAuditReports(unavailableAudit("npm", "execution_failed"), report()).status).toBe("unavailable");
		expect(compareAuditReports(report(), report([], "yarn1")).status).toBe("unavailable");
	});
	it("prioritizes explicit direct fixes, then affected direct packages, retaining deterministic original order", () => {
		const candidates = [candidate("unrelated"), candidate("affected"), candidate("express")];
		const audit = report([finding, { ...finding, package: "affected", fixVersions: [] }]);
		expect(prioritizeCandidates(candidates, audit).map((c) => c.name)).toEqual(["express", "affected", "unrelated"]);
		expect(prioritizeCandidates(candidates, report([{ ...finding, package: "unrelated", direct: false }]))).toEqual(candidates);
		expect(prioritizeCandidates(candidates, unavailableAudit("npm", "execution_failed"))).toEqual(candidates);
	});
	it("rejects reports which claim both completeness and failure, or retain findings from an incomplete scan", () => {
		expect(AuditReport.safeParse({ ...report(), reason: "execution_failed" }).success).toBe(false);
		expect(AuditReport.safeParse({ ...unavailableAudit("npm", "execution_failed"), findings: [finding] }).success).toBe(false);
	});
});

describe("sandbox audit boundary", () => {
	function sandbox(output = JSON.stringify(npm(false)), exitCode = 0): Sandbox {
		return {
			id: "sbx-audit",
			exec: vi.fn(async (command: string) => ({
				exitCode: command.includes("as-runner.sh") ? exitCode : 0,
				stdout: "truncated unrelated stream",
				stderr: "private stderr",
			})),
			upload: vi.fn(),
			download: vi.fn(async () => Buffer.from(output)),
			close: vi.fn(),
		};
	}
	it("uses the bounded downloaded result rather than the exec stream and runs through the scrubbed unprivileged wrapper", async () => {
		const s = sandbox();
		expect(await auditSandbox(s, "npm")).toMatchObject({ status: "completed", findings: [] });
		const call = vi.mocked(s.exec).mock.calls.find(([c]) => c.includes("as-runner.sh"));
		if (!call) throw new Error("Audit command missing");
		const [command, options] = call;
		expect(command).toContain("as-runner.sh");
		expect(command).toContain("https://registry.npmjs.org");
		expect(command).toContain("timeout -k 2 120");
		expect(options?.timeoutMs).toBeGreaterThan(120_000);
		expect(vi.mocked(s.download).mock.calls[0][0]).toMatch(/^\/opt\/factory\/app\/audit-[a-f0-9-]+\.json$/);
	});
	it("uses a protected pinned Yarn executable rather than repository or runner-cache binaries", async () => {
		const s = sandbox(yarn(), 8);
		expect((await auditSandbox(s, "yarn1", { express: "5.0.0" })).status).toBe("completed");
		const commands = vi.mocked(s.exec).mock.calls.map(([command]) => command);
		const prepare = commands.find((command) => command.includes("yarn@1.22.22"));
		expect(prepare).toContain("--ignore-scripts");
		expect(prepare).toContain("env -i");
		expect(prepare).toContain("chmod -R a+rX,go-w");
		const audit = commands.find((command) => command.includes("as-runner.sh"));
		expect(audit).toMatch(/\/opt\/factory\/app\/audit-tools-[a-f0-9-]+\/node_modules\/yarn\/bin\/yarn.js/);
		expect(audit).toContain("--no-default-rc");
		expect(audit).not.toContain("npm exec");
	});
	it("refuses to audit when protected tool/config preparation fails", async () => {
		const s = sandbox(yarn(false));
		vi.mocked(s.exec).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "private failure" });
		expect(await auditSandbox(s, "yarn1")).toMatchObject({ status: "unavailable", reason: "execution_failed" });
		expect(s.download).not.toHaveBeenCalled();
	});
	it("accepts a completed vulnerable audit without accepting a timeout as a clean scan", async () => {
		expect((await auditSandbox(sandbox(JSON.stringify(npm()), 1), "npm")).status).toBe("completed");
		const s = sandbox(JSON.stringify(npm(false)), 124);
		expect(await auditSandbox(s, "npm")).toMatchObject({ status: "unavailable", reason: "execution_failed" });
		expect(s.download).not.toHaveBeenCalled();
	});
	it("cannot turn malformed, oversized, invalid UTF-8, or missing downloaded results into a passing audit", async () => {
		for (const bytes of [Buffer.from('{"metadata":'), Buffer.alloc(512_001), Buffer.from([0xff])]) {
			const s = sandbox();
			vi.mocked(s.download).mockResolvedValue(bytes);
			expect((await auditSandbox(s, "npm")).status).toBe("unavailable");
		}
		const s = sandbox();
		vi.mocked(s.exec).mockRejectedValue(new Error("secret command failure"));
		const r = await auditSandbox(s, "npm");
		expect(r.status).toBe("unavailable");
		expect(JSON.stringify(r)).not.toContain("secret command failure");
	});
});
