import { z } from "zod";
import { VerifyRepositoryInput } from "./maintenance.js";

/** An operator selects a retained Workflow run, never supplies publishable files or review claims. */
export const DependencyPublishInput = z.strictObject({
	repo: VerifyRepositoryInput.shape.repo,
	reviewRunId: z
		.string()
		.regex(/^trn-[a-z0-9]+$/)
		.max(200),
	installationId: VerifyRepositoryInput.shape.installationId,
});
export type DependencyPublishInput = z.infer<typeof DependencyPublishInput>;
export const DependencyPublishResult = z.strictObject({
	repo: VerifyRepositoryInput.shape.repo,
	reviewRunId: DependencyPublishInput.shape.reviewRunId,
	status: z.enum(["disabled", "published", "reused", "suppressed", "stale", "rejected", "unknown"]),
	reason: z
		.enum([
			"publishing_disabled",
			"invalid_review",
			"audit_not_passed",
			"stale_evidence",
			"base_moved",
			"branch_modified",
			"pull_modified",
			"closed_proposal",
			"publication_unconfirmed",
		])
		.optional(),
	artifactId: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	branch: z.string().max(200).optional(),
	pullNumber: z.number().int().positive().optional(),
	pullUrl: z.url().optional(),
	completedAt: z.iso.datetime(),
});
export type DependencyPublishResult = z.infer<typeof DependencyPublishResult>;
