import { task } from "@renderinc/sdk/workflows";
import { requireRepo, TASKS } from "../../config/index.js";
import { maintenanceMode } from "../../github/index.js";
import { DependencyPublishResult, DependencyReviewResult, DependencySweepResult, MaintenanceSweepInput } from "../../schemas/index.js";
import { dependencyPublish } from "./publish-task.js";
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
				let publication: DependencyPublishResult | undefined;
				if (
					result.status === "ready_for_review" &&
					process.env.MAINTENANCE_PUBLISH_DRAFTS === "true" &&
					maintenanceMode() !== "public" &&
					requireRepo(repo.repo, repo.installationId ?? 0).config.dependencyUpdates?.publishDrafts === true
				) {
					try {
						publication = DependencyPublishResult.parse(
							await ctx.run(dependencyPublish, { repo: repo.repo, reviewRunId: result.runId, installationId: repo.installationId }),
						);
						if (publication.repo !== repo.repo || publication.reviewRunId !== result.runId) throw new Error("Publication identity mismatch");
					} catch {
						publication = {
							repo: repo.repo,
							reviewRunId: result.runId,
							status: "unknown",
							reason: "publication_unconfirmed",
							completedAt: new Date().toISOString(),
						};
					}
				}
				results.push({
					repo: repo.repo,
					sha: repo.sha,
					status: result.status,
					runId: result.runId,
					candidate: result.candidate,
					artifactId: result.artifact?.id,
					reason: result.reason,
					publication,
				});
			} catch {
				results.push({ repo: repo.repo, sha: repo.sha, status: "infrastructure_error", reason: "child_run_failed" });
			}
		}
		return DependencySweepResult.parse({ completedAt: new Date().toISOString(), results });
	},
);
