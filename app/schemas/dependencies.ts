import { z } from "zod";
import { DependencyPublishResult } from "./dependency-publishing.js";
import { AuditReport, AuditComparison } from "./audits.js";
import { MaintenanceResult, VerifyRepositoryInput } from "./maintenance.js";

export const DependencyName = z
	.string()
	.regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
	.max(214);
export const StableVersion = z
	.string()
	.regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
	.max(50);
export const DependencyCandidate = z.strictObject({
	name: DependencyName,
	section: z.enum(["dependencies", "devDependencies", "requirements"]),
	fromRange: z.string().max(100),
	fromVersion: StableVersion,
	toVersion: StableVersion,
	toRange: z.string().max(100),
	kind: z.enum(["patch", "minor"]),
});
export type DependencyCandidate = z.infer<typeof DependencyCandidate>;

export const DependencyFile = z.strictObject({
	path: z.enum(["package.json", "package-lock.json", "yarn.lock", "requirements.txt"]),
	content: z.string().max(180_000),
});
export const DependencySnapshot = z.strictObject({
	files: z.array(DependencyFile).min(1).max(2),
	installed: z.record(DependencyName, z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.!+_-]{0,99}$/)).refine((v) => Object.keys(v).length <= 100),
});
export type DependencySnapshot = z.infer<typeof DependencySnapshot>;
export const DependencyArtifact = z.strictObject({
	id: z.string().regex(/^[a-f0-9]{64}$/),
	baseSha: VerifyRepositoryInput.shape.sha,
	files: z
		.array(z.strictObject({ path: DependencyFile.shape.path, before: DependencyFile.shape.content, after: DependencyFile.shape.content }))
		.min(1)
		.max(2),
	patch: z.string().min(1).max(360_000),
});
export type DependencyArtifact = z.infer<typeof DependencyArtifact>;
export const DependencyDiscovery = z.strictObject({
	candidates: z.array(DependencyCandidate).max(100),
	skipped: z
		.array(z.strictObject({ name: DependencyName, reason: z.enum(["unsupported_range", "unresolved_version", "registry_unavailable"]) }))
		.max(100),
});
export type DependencyDiscovery = z.infer<typeof DependencyDiscovery>;

export const DependencyReviewResult = z
	.strictObject({
		repo: VerifyRepositoryInput.shape.repo,
		sha: VerifyRepositoryInput.shape.sha,
		runId: z.string().min(1).max(200),
		status: z.enum([
			"ready_for_review",
			"no_eligible_update",
			"baseline_failed",
			"candidate_failed",
			"generation_failed",
			"security_blocked",
			"infrastructure_error",
		]),
		publishing: z.literal("disabled"),
		audit: z.strictObject({ baseline: AuditReport, candidate: AuditReport.optional(), comparison: AuditComparison.optional() }).optional(),
		baseline: MaintenanceResult.optional(),
		verification: MaintenanceResult.optional(),
		discovery: DependencyDiscovery.optional(),
		candidate: DependencyCandidate.optional(),
		artifact: DependencyArtifact.optional(),
		generation: z
			.strictObject({
				sandboxId: z.string().max(200).nullable(),
				cleanup: z.enum(["not_created", "terminated", "unconfirmed"]),
				output: z.string().max(4096),
				exitCode: z.number().int().nullable(),
			})
			.optional(),
		reason: z
			.enum([
				"baseline_unhealthy",
				"candidate_unhealthy",
				"generation_rejected",
				"artifact_mismatch",
				"lookup_incomplete",
				"unconfirmed_execution",
				"audit_unavailable",
				"security_regression",
			])
			.optional(),
		lookupHttpStatus: z.number().int().min(400).max(599).optional(),
		completedAt: z.iso.datetime(),
	})
	.superRefine((r, ctx) => {
		if (r.status !== "ready_for_review") return;
		const checks = [r.baseline, r.verification];
		const ids = [r.baseline?.sandboxId, r.generation?.sandboxId, r.verification?.sandboxId];
		if (
			r.audit?.baseline.status !== "completed" ||
			r.audit?.candidate?.status !== "completed" ||
			r.audit?.comparison?.status !== "passed" ||
			!r.candidate ||
			!r.artifact ||
			r.artifact.baseSha !== r.sha ||
			r.generation?.cleanup !== "terminated" ||
			ids.some((id) => !id) ||
			new Set(ids).size !== 3 ||
			checks.some((c) => c?.status !== "passed" || c.cleanup !== "terminated" || c.repo !== r.repo || c.sha !== r.sha || c.runId !== r.runId)
		) {
			ctx.addIssue({ code: "custom", message: "A ready proposal requires a matching artifact, passing comparisons, and three terminated sandboxes" });
		}
	});
export type DependencyReviewResult = z.infer<typeof DependencyReviewResult>;

export const DependencySweepResult = z.strictObject({
	completedAt: z.iso.datetime(),
	results: z
		.array(
			z.strictObject({
				repo: VerifyRepositoryInput.shape.repo,
				sha: VerifyRepositoryInput.shape.sha.nullable(),
				status: DependencyReviewResult.shape.status,
				runId: z.string().max(200).optional(),
				candidate: DependencyCandidate.optional(),
				artifactId: DependencyArtifact.shape.id.optional(),
				publication: DependencyPublishResult.optional(),
				reason: z.string().max(100).optional(),
			}),
		)
		.max(25),
});
export type DependencySweepResult = z.infer<typeof DependencySweepResult>;
