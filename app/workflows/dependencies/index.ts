import { task } from "@renderinc/sdk/workflows";
import { requireRepo, TASKS } from "../../config/index.js";
import { DependencyReviewResult, DependencySweepResult, MaintenanceSweepInput } from "../../schemas/index.js";
import { runDependencyReview } from "./review.js";

export const dependencyReview = task(
	{ name: TASKS.dependencyReview, timeoutSeconds: 7200, retry: { maxRetries: 0, waitDurationMs: 1000 } },
	async (ctx, input: unknown) => {
		const id = ctx.metadata.taskRunId;
		if (!id) throw new Error("Dependency review requires a Workflow run ID");
		return runDependencyReview(input, id);
	},
);
export const dependencySweep = task(
	{ name: TASKS.dependencySweep, timeoutSeconds: 23 * 3600, retry: { maxRetries: 0, waitDurationMs: 1000 } },
	async (ctx, raw: unknown) => {
		const input = MaintenanceSweepInput.parse(raw);
		// Reject wrong targets before starting any child work.
		for (const repo of input.repositories) {
			if (!requireRepo(repo.repo, repo.installationId ?? 0).config.dependencyUpdates)
				throw new Error("Repository is not enabled for dependency updates");
		}
		const results: DependencySweepResult["results"] = (input.resolutionFailures ?? []).map((f) => ({
			repo: f.repo,
			sha: null,
			status: "infrastructure_error",
			reason: f.reason,
		}));
		for (const repo of input.repositories) {
			try {
				const result = DependencyReviewResult.parse(await ctx.run(dependencyReview, repo));
				if (result.repo !== repo.repo || result.sha !== repo.sha) throw new Error("Mismatched child result");
				results.push({
					repo: repo.repo,
					sha: repo.sha,
					status: result.status,
					runId: result.runId,
					candidate: result.candidate,
					artifactId: result.artifact?.id,
					reason: result.reason,
				});
			} catch {
				results.push({ repo: repo.repo, sha: repo.sha, status: "infrastructure_error", reason: "child_run_failed" });
			}
		}
		return DependencySweepResult.parse({ completedAt: new Date().toISOString(), results });
	},
);
