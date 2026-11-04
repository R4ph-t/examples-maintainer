import { codeSpan } from "../../format/index.js";
import type { AuditComparison, AuditFinding } from "../../schemas/audits.js";

const severities = ["critical", "high", "moderate", "low", "info", "unknown"] as const;
const icons = { critical: "🔴", high: "🟠", moderate: "🟡", low: "🔵", info: "⚪", unknown: "❔" };
function counts(findings: AuditFinding[]): string {
	if (!findings.length) return "—";
	const labels = severities.flatMap((severity) => {
		const count = findings.filter((finding) => finding.severity === severity).length;
		return count ? [`${icons[severity]} ${count} ${severity}`] : [];
	});
	return `**${findings.length}**<br>${labels.join(" · ")}`;
}
function advisory(id: string): string {
	if (/^GHSA-[a-z0-9-]+$/.test(id)) return `[${id}](https://github.com/advisories/${encodeURIComponent(id)})`;
	if (/^(PYSEC|CVE)-[0-9-]+$/.test(id)) return `[${id}](https://osv.dev/vulnerability/${encodeURIComponent(id)})`;
	return codeSpan(id);
}

/** Summarize recorded findings without inventing advisory titles, severity, or tested fixes. */
export function dependencyAuditSummary(audit: AuditComparison): string[] {
	const groups = new Map<string, { fixed: AuditFinding[]; remaining: AuditFinding[]; introduced: AuditFinding[] }>();
	for (const kind of ["fixed", "remaining", "introduced"] as const) {
		for (const finding of audit[kind]) {
			const group = groups.get(finding.package) ?? { fixed: [], remaining: [], introduced: [] };
			group[kind].push(finding);
			groups.set(finding.package, group);
		}
	}
	const packages = [...groups.entries()].sort(([nameA, a], [nameB, b]) =>
		Number(b.introduced.length > 0) - Number(a.introduced.length > 0) ||
		Number(b.remaining.length > 0) - Number(a.remaining.length > 0) || nameA.localeCompare(nameB),
	);
	const details = (["introduced", "remaining", "fixed"] as const).flatMap((kind) => audit[kind].map((finding) => ({ kind, finding })));
	const status = { introduced: "🆕 New", remaining: "⚠️ Remaining", fixed: "✅ Fixed" };
	return [
		`**${audit.fixed.length + audit.remaining.length} → ${audit.remaining.length + audit.introduced.length} findings** after this patch`,
		"",
		`✅ **${audit.fixed.length} fixed** · ⚠️ **${audit.remaining.length} still present** · ${audit.introduced.length ? "🆕" : "✅"} **${audit.introduced.length} introduced**`,
		"",
		...(packages.length ? [
			"| Package | ✅ Fixed by this PR | ⚠️ Still present | 🆕 Introduced |",
			"| --- | --- | --- | --- |",
			...packages.slice(0, 40).map(([name, group]) => `| ${codeSpan(name)} | ${counts(group.fixed)} | ${counts(group.remaining)} | ${counts(group.introduced)} |`),
			...(packages.length > 40 ? ["", `Showing 40 of ${packages.length} packages; the Render execution contains the full audit.`] : []),
		] : ["No findings were reported by these scans."]),
		"",
		...(audit.remaining.length || audit.introduced.length
			? ["**Follow-up:** Findings still present or introduced need a separate review and tested fix. This PR does not resolve every reported issue.", ""]
			: []),
		...(details.some(({ finding }) => finding.severity === "unknown")
			? ["❔ **Unknown severity** means the scanner did not supply a rating; it does not mean low risk.", ""]
			: []),
		...(details.length ? [
			"<details>",
			"<summary>🔎 Advisory links and reported fix versions</summary>",
			"",
			"Fix versions below are advisory metadata, not additional upgrades validated by this PR.",
			"",
			"| Status | Package | Advisory | Severity | Reported fix versions |",
			"| --- | --- | --- | --- | --- |",
			...details.slice(0, 80).map(({ kind, finding }) =>
				`| ${status[kind]} | ${codeSpan(finding.package)} | ${advisory(finding.id)} | ${icons[finding.severity]} ${finding.severity} | ${finding.fixVersions.length ? finding.fixVersions.slice(0, 3).map(codeSpan).join(", ") + (finding.fixVersions.length > 3 ? " (more in execution record)" : "") : "Not reported"} |`,
			),
			...(details.length > 80 ? ["", `Showing 80 of ${details.length} findings; the Render execution contains the complete list.`] : []),
			"",
			"</details>",
		] : []),
	];
}
