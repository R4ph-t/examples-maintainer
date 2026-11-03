import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Render } from "@renderinc/sdk";
import { z } from "zod";
import { config, requireEnv, TASKS } from "../app/config/index.js";
import { GitHubError, maintenanceRevision } from "../app/github/index.js";
import { DependencyReviewResult } from "../app/schemas/index.js";
import { planDependencyMaintenance, waitForDependencyMaintenance } from "./lib/dependency-maintenance.js";

const { values } = parseArgs({
	options: {
		window: { type: "string" },
		"dry-run": { type: "boolean" },
		wait: { type: "boolean" },
		out: { type: "string" },
	},
	strict: true,
});
if (values.out && !values.wait) throw new Error("--out requires --wait");
const plan = await planDependencyMaintenance(config, values.window ?? new Date().toISOString().slice(0, 10), async (repo, branch) => {
	try {
		return await maintenanceRevision(repo, branch);
	} catch (e) {
		console.error(JSON.stringify({ event: "dependency_revision_unavailable", repo, status: e instanceof GitHubError ? e.status : null }));
		throw e;
	}
});
if (values["dry-run"]) console.log(JSON.stringify(plan, null, 2));
else {
	const render = new Render({ token: requireEnv("RENDER_API_KEY"), useLocalDev: false });
	const run = await render.workflows.startTask(`${requireEnv("RENDER_WORKFLOW_SLUG")}/${TASKS.dependencySweep}`, [plan.input], {
		idempotencyKey: plan.idempotencyKey,
		signal: AbortSignal.timeout(30_000),
	});
	console.log(JSON.stringify({ taskRunId: run.taskRunId, repositories: plan.input.repositories.map((r) => r.repo) }));
	if (values.wait) {
		const result = await waitForDependencyMaintenance(() => render.workflows.getTaskRun(run.taskRunId));
		console.log(JSON.stringify({ taskRunId: run.taskRunId, ...result }, null, 2));
		if (values.out) {
			const dir = resolve(values.out);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "sweep.json"), JSON.stringify({ taskRunId: run.taskRunId, ...result }, null, 2));
			for (const row of result.results) {
				if (!row.runId) continue;
				const details = z.object({ results: z.tuple([DependencyReviewResult]) }).parse(await render.workflows.getTaskRun(row.runId));
				const review = details.results[0];
				if (review.repo !== row.repo || review.sha !== row.sha || review.runId !== row.runId || review.status !== row.status)
					throw new Error("Export identity mismatch");
				const name = `${review.repo.replace("/", "--")}-${review.status}`;
				await writeFile(join(dir, `${name}.json`), JSON.stringify(review, null, 2));
				if (review.artifact) await writeFile(join(dir, `${name}.patch`), review.artifact.patch);
			}
		}
		process.exitCode = result.healthy ? 0 : 1;
	}
}
