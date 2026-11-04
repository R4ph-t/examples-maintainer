import { AuditReport, type DependencyCandidate, RankedDependencyCandidate, type ScanPriority } from "../../schemas/index.js";

export const scanPriorityOrder: Record<ScanPriority, number> = {
	critical: 0,
	high: 1,
	needs_triage: 2,
	moderate: 3,
	low: 4,
	info: 5,
	maintenance: 6,
};
export function auditPriority(raw: unknown): ScanPriority {
	const audit = AuditReport.parse(raw);
	if (audit.status !== "completed") return "needs_triage";
	return audit.findings.reduce<ScanPriority>((best, finding) => {
		const priority = finding.severity === "unknown" ? "needs_triage" : finding.severity;
		return scanPriorityOrder[priority] < scanPriorityOrder[best] ? priority : best;
	}, "maintenance");
}

/** Direct advisory matches guide selection; we do not infer transitive reachability or exploitation. */
export function rankScanCandidates(candidates: DependencyCandidate[], raw: unknown): RankedDependencyCandidate[] {
	const audit = AuditReport.parse(raw);
	return candidates
		.map((candidate) => {
			const findings = audit.findings.filter((finding) => finding.package === candidate.name && finding.direct === true);
			return RankedDependencyCandidate.parse({
				candidate,
				priority: auditPriority({ ...audit, findings }),
				relatedFindings: findings.length,
				fixEvidence: findings.some((finding) => finding.fixVersions.includes(candidate.toVersion)) ? "reported_version" : "not_reported",
			});
		})
		.sort(
			(a, b) =>
				scanPriorityOrder[a.priority] - scanPriorityOrder[b.priority] ||
				Number(b.fixEvidence === "reported_version") - Number(a.fixEvidence === "reported_version") ||
				Number(a.candidate.section === "devDependencies") - Number(b.candidate.section === "devDependencies") ||
				a.candidate.name.localeCompare(b.candidate.name),
		);
}
