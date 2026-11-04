import { describe, expect, it } from "vitest";
import type { AuditComparison, AuditFinding } from "../app/schemas/audits.js";
import { dependencyAuditSummary } from "../app/workflows/dependencies/audit-summary.js";

const finding = (id: string, name: string, severity: AuditFinding["severity"]): AuditFinding => ({
	id, package: name, severity, version: "1.0.0", direct: false, fixVersions: ["2.0.0"],
});
const audit = (data: Partial<AuditComparison> = {}): AuditComparison => ({
	status: "passed", fixed: [], remaining: [], introduced: [], blocking: [], ...data,
});
describe("dependency audit summary", () => {
	it("groups findings by package and surfaces unresolved risk ahead of fixed issues", () => {
		const body = dependencyAuditSummary(audit({
			fixed: [finding("GHSA-aaaa-bbbb-cccc", "fixed-package", "critical"), finding("GHSA-dddd-eeee-ffff", "fixed-package", "low")],
			remaining: [finding("GHSA-gggg-hhhh-iiii", "remaining-package", "high")],
			introduced: [finding("GHSA-jjjj-kkkk-llll", "new-package", "moderate")],
		})).join("\n");
		expect(body).toContain("**3 → 2 findings**");
		expect(body).toContain("**1 introduced**");
		expect(body).toContain("| `fixed-package` | **2**<br>🔴 1 critical · 🔵 1 low | — | — |");
		expect(body.indexOf("| `new-package`")).toBeLessThan(body.indexOf("| `remaining-package`"));
		expect(body.indexOf("| `remaining-package`")).toBeLessThan(body.indexOf("| `fixed-package`"));
		expect(body.indexOf("https://github.com/advisories/")).toBeGreaterThan(body.indexOf("<details>"));
		expect(body).toContain("not additional upgrades validated by this PR");
	});
	it("preserves unknown severity and missing fixes without claiming safety", () => {
		const unknown = { ...finding("PYSEC-2026-123", "django", "unknown"), fixVersions: [] };
		const body = dependencyAuditSummary(audit({ remaining: [unknown] })).join("\n");
		expect(body).toContain("❔ 1 unknown");
		expect(body).toContain("does not mean low risk");
		expect(body).toContain("https://osv.dev/vulnerability/PYSEC-2026-123");
		expect(body).toContain("Not reported");
		expect(body).toContain("separate review and tested fix");
	});
	it("keeps full counts and explicitly labels truncated display lists", () => {
		const body = dependencyAuditSummary(audit({ remaining: Array.from({ length: 81 }, (_, i) => finding(`CVE-2026-${i}`, `package-${i}`, "high")) })).join("\n");
		expect(body).toContain("**81 still present**");
		expect(body).toContain("Showing 40 of 81 packages");
		expect(body).toContain("Showing 80 of 81 findings");
	});
});
