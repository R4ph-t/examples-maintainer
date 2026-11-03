import { task } from "@renderinc/sdk/workflows";
import { TASKS } from "../../config/index.js";
import { MaintenanceResult, MaintenanceSweepInput, MaintenanceSweepResult } from "../../schemas/index.js";
import { runRepositoryVerification } from "./verify.js";

export const verifyRepository = task(
	{ name: TASKS.verifyRepository, timeoutSeconds: 2400, retry: { maxRetries: 0, waitDurationMs: 1000 } },
	async (ctx, raw: unknown) => {
		const runId = ctx.metadata.taskRunId;
		if (!runId) throw new Error("maintenance requires a Workflow run ID");
		return runRepositoryVerification(raw, runId);
	},
);

/** Sequential child runs bound this sweep's sandbox concurrency to one. No automatic replay of side effects. */
export const maintenanceSweep = task(
	{ name: TASKS.maintenanceSweep, timeoutSeconds: 23 * 3600, retry: { maxRetries: 0, waitDurationMs: 1000 } },
	async (ctx, raw: unknown) => {
		const input = MaintenanceSweepInput.parse(raw);
		const results = [];
		for (const failure of input.resolutionFailures ?? []) {
			results.push({ ...failure, sha: null, status: "infrastructure_error", reporting: "skipped" });
		}
		for (const repo of input.repositories) {
			try {
				const result = MaintenanceResult.parse(await ctx.run(verifyRepository, repo));
				if (result.repo !== repo.repo || result.sha !== repo.sha) throw new Error("child result does not match requested revision");
				results.push({
					repo: repo.repo,
					sha: repo.sha,
					status: result.status,
					reporting: result.reporting,
					checkUrl: result.checkUrl,
					runId: result.runId,
					sandboxId: result.sandboxId,
					cleanup: result.cleanup,
					stages: result.stages.map(({ name, status, exitCode, durationMs }) => ({ name, status, exitCode, durationMs })),
				});
			} catch {
				results.push({ repo: repo.repo, sha: repo.sha, status: "infrastructure_error", reporting: "failed", reason: "child_run_failed" });
			}
		}
		return MaintenanceSweepResult.parse({ completedAt: new Date().toISOString(), results });
	},
);
