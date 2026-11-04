import { z } from "zod";
import { AuditReport } from "./audits.js";
import { DependencyCandidate, DependencyDiscovery, DependencyName } from "./dependencies.js";
import { VerifyRepositoryInput } from "./maintenance.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const RunId = z
	.string()
	.regex(/^trn-[a-z0-9]+$/)
	.max(200);
export const ScanPriority = z.enum(["critical", "high", "needs_triage", "moderate", "low", "info", "maintenance"]);
export type ScanPriority = z.infer<typeof ScanPriority>;
export const RankedDependencyCandidate = z.strictObject({
	candidate: DependencyCandidate,
	priority: ScanPriority,
	relatedFindings: z.number().int().min(0).max(200),
	fixEvidence: z.enum(["reported_version", "not_reported"]),
});
export type RankedDependencyCandidate = z.infer<typeof RankedDependencyCandidate>;
export const ScanSnapshotReceipt = z.strictObject({
	status: z.enum(["hit", "created", "disabled", "unavailable"]),
	key: Hash,
	snapshotId: z.string().max(200).optional(),
	createdAt: z.iso.datetime().optional(),
	expiresAt: z.iso.datetime().optional(),
});
export const DependencyScanResult = z
	.strictObject({
		repo: VerifyRepositoryInput.shape.repo,
		sha: VerifyRepositoryInput.shape.sha,
		runId: RunId,
		status: z.enum(["completed", "incomplete", "infrastructure_error"]),
		completedAt: z.iso.datetime(),
		recipeHash: Hash,
		toolHash: Hash,
		inventoryHash: Hash.optional(),
		runtime: z.string().max(1000).optional(),
		sandboxId: z.string().max(200).nullable(),
		cleanup: z.enum(["not_created", "terminated", "unconfirmed"]),
		snapshot: ScanSnapshotReceipt.optional(),
		audit: AuditReport.optional(),
		discovery: DependencyDiscovery.optional(),
		rankedCandidates: z.array(RankedDependencyCandidate).max(100),
		priority: ScanPriority,
		unratedFindings: z.number().int().min(0).max(200),
		priorityBasis: z.literal("reported_severity_and_fix_metadata"),
		exploitation: z.literal("not_assessed"),
		reachability: z.literal("not_assessed"),
		verification: z.literal("not_run"),
		publishing: z.literal("disabled"),
		reason: z.enum(["audit_unavailable", "discovery_incomplete", "install_failed", "unconfirmed_execution"]).optional(),
	})
	.superRefine((r, ctx) => {
		if (
			r.status === "completed" &&
			(r.cleanup !== "terminated" ||
				!r.sandboxId ||
				!r.inventoryHash ||
				!r.runtime ||
				r.audit?.status !== "completed" ||
				!r.discovery ||
				r.discovery.skipped.length)
		)
			ctx.addIssue({
				code: "custom",
				message: "A completed scan needs current audit, complete discovery, inventory identity, and confirmed cleanup",
			});
	});
export type DependencyScanResult = z.infer<typeof DependencyScanResult>;

export const DependencyScanSweepResult = z.strictObject({
	completedAt: z.iso.datetime(),
	results: z
		.array(
			z.strictObject({
				repo: VerifyRepositoryInput.shape.repo,
				sha: VerifyRepositoryInput.shape.sha.nullable(),
				runId: RunId.optional(),
				status: DependencyScanResult.shape.status,
				priority: ScanPriority,
				findings: z.number().int().min(0).max(200),
				unratedFindings: z.number().int().min(0).max(200),
				candidates: z.number().int().min(0).max(100),
				reason: z.string().max(100).optional(),
			}),
		)
		.max(25),
});
export type DependencyScanSweepResult = z.infer<typeof DependencyScanSweepResult>;
export const SelectedDependencyInput = z.strictObject({
	repo: VerifyRepositoryInput.shape.repo,
	scanRunId: RunId,
	candidateName: DependencyName,
});
export type SelectedDependencyInput = z.infer<typeof SelectedDependencyInput>;
export const SelectedDependencyResult = z.strictObject({
	repo: VerifyRepositoryInput.shape.repo,
	scanRunId: RunId,
	candidateName: DependencyName,
	status: z.enum(["verified", "rejected", "stale"]),
	reviewRunId: z.string().max(200).optional(),
	reviewStatus: z.string().max(100).optional(),
	reason: z
		.enum(["scan_unavailable", "scan_stale", "source_changed", "configuration_changed", "candidate_unavailable", "verification_failed"])
		.optional(),
});
export type SelectedDependencyResult = z.infer<typeof SelectedDependencyResult>;
