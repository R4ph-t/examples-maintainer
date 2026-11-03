import { z } from "zod";

const Command = z.string().trim().min(1).max(4000);
const Step = z.strictObject({
	name: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
	command: Command,
	timeoutSeconds: z.number().int().min(1).max(600),
});

/** Operator-owned recipes. Task inputs and repository content cannot override them. */
export const MaintenanceRecipe = z
	.strictObject({
		install: Step,
		checks: z.array(Step).max(12),
		smoke: z.strictObject({
			start: Command,
			port: z.number().int().min(1024).max(65535),
			path: z
				.string()
				.regex(/^\/(?!\/)[^\r\n]*$/)
				.max(1000),
			expectedStatus: z.number().int().min(200).max(599),
			bodyIncludes: z.string().min(1).max(1000),
			timeoutSeconds: z.number().int().min(1).max(120),
		}),
	})
	.superRefine((recipe, ctx) => {
		const steps = [recipe.install, ...recipe.checks];
		if (new Set(steps.map((s) => s.name)).size !== steps.length || steps.some((s) => ["prepare", "runtime", "smoke"].includes(s.name))) {
			ctx.addIssue({ code: "custom", message: "step names must be unique and cannot be prepare, runtime, or smoke" });
		}
		if (steps.reduce((sum, s) => sum + s.timeoutSeconds, recipe.smoke.timeoutSeconds) > 900) {
			ctx.addIssue({ code: "custom", message: "recipe command timeouts must total at most 900 seconds" });
		}
	});
export type MaintenanceRecipe = z.infer<typeof MaintenanceRecipe>;

export const VerifyRepositoryInput = z.strictObject({
	repo: z
		.string()
		.regex(/^[\w.-]+\/[\w.-]+$/)
		.max(200),
	installationId: z.number().int().positive().optional(),
	sha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type VerifyRepositoryInput = z.infer<typeof VerifyRepositoryInput>;

/** A batch is an operator request, not a repository-provided list or an issue/PR task. */
export const MaintenanceSweepInput = z
	.strictObject({
		repositories: z.array(VerifyRepositoryInput).max(25),
		resolutionFailures: z
			.array(z.strictObject({ repo: z.string().max(200), reason: z.literal("revision_unavailable") }))
			.max(25)
			.optional(),
	})
	.refine((input) => {
		const count = input.repositories.length + (input.resolutionFailures?.length ?? 0);
		return count > 0 && count <= 25;
	}, "a sweep must contain between 1 and 25 repositories");

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export const MaintenanceResult = z.strictObject({
	repo: z.string().max(200),
	sha: z.string().regex(/^[0-9a-f]{40}$/),
	recipeHash: Hash,
	smokeRunnerHash: Hash,
	runId: z.string().min(1).max(200),
	status: z.enum(["passed", "failed", "infrastructure_error"]),
	sandboxId: z.string().max(200).nullable(),
	cleanup: z.enum(["not_created", "terminated", "unconfirmed"]),
	stages: z
		.array(
			z.strictObject({
				name: z.string().max(40),
				status: z.enum(["passed", "failed", "unknown"]),
				exitCode: z.number().int().nullable(),
				durationMs: z.number().nonnegative(),
				output: z.string().max(4096),
			}),
		)
		.max(16),
	reporting: z.enum(["pending", "published", "failed", "skipped"]),
	checkUrl: z.string().url().optional(),
});
export type MaintenanceResult = z.infer<typeof MaintenanceResult>;
export type MaintenanceStage = MaintenanceResult["stages"][number];

export const MaintenanceSweepResult = z.strictObject({
	completedAt: z.iso.datetime(),
	results: z
		.array(
			z.strictObject({
				repo: z.string().max(200),
				sha: z
					.string()
					.regex(/^[0-9a-f]{40}$/)
					.nullable(),
				status: z.enum(["passed", "failed", "infrastructure_error"]),
				reporting: z.enum(["pending", "published", "failed", "skipped"]),
				checkUrl: z.url().optional(),
				runId: z.string().max(200).optional(),
				sandboxId: z.string().max(200).nullable().optional(),
				cleanup: z.enum(["not_created", "terminated", "unconfirmed"]).optional(),
				reason: z.enum(["revision_unavailable", "child_run_failed"]).optional(),
				stages: z
					.array(MaintenanceResult.shape.stages.element.omit({ output: true }))
					.max(16)
					.optional(),
			}),
		)
		.max(25),
});
