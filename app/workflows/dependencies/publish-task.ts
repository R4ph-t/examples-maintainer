import { task } from "@renderinc/sdk/workflows";
import { TASKS } from "../../config/index.js";
import { loadDependencyReview } from "./load-review.js";
import { runDependencyPublication } from "./publish.js";

export const dependencyPublish = task(
	{ name: TASKS.dependencyPublish, timeoutSeconds: 600, retry: { maxRetries: 0, waitDurationMs: 1000 } },
	async (ctx, input: unknown) => {
		const publisherRunId = ctx.metadata.taskRunId;
		if (!publisherRunId) throw new Error("Publication requires a Workflow run ID");
		return runDependencyPublication(input, { loadReview: (id) => loadDependencyReview(id, publisherRunId) });
	},
);
