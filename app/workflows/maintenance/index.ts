import { task } from "@renderinc/sdk/workflows";
import { TASKS } from "../../config/index.js";
import { MaintenanceResult, MaintenanceSweepInput } from "../../schemas/index.js";
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
		for (const repo of input.repositories) {
			try {
				const result = MaintenanceResult.parse(await ctx.run(verifyRepository, repo));
				results.push({ repo: repo.repo, sha: repo.sha, status: result.status, reporting: result.reporting, checkUrl: result.checkUrl });
			} catch {
				results.push({ repo: repo.repo, sha: repo.sha, status: "infrastructure_error", reporting: "failed" });
			}
		}
		return { results };
	},
);
