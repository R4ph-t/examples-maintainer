import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Render } from "@renderinc/sdk";
import { z } from "zod";
import { config, requireEnv, TASKS } from "../app/config/index.js";
import { maintenanceRevision } from "../app/github/index.js";
import { DependencyScanResult, DependencyScanSweepResult } from "../app/schemas/index.js";
import { planDependencyScan, waitForMaintenanceTask } from "./lib/dependency-scanning.js";

const { values } = parseArgs({
	options: { window: { type: "string" }, "dry-run": { type: "boolean" }, wait: { type: "boolean" }, out: { type: "string" } },
	strict: true,
});
if (values.out && !values.wait) throw new Error("--out requires --wait");
const plan = await planDependencyScan(config, values.window ?? new Date().toISOString(), maintenanceRevision);
if (values["dry-run"]) console.log(JSON.stringify(plan, null, 2));
else {
	const render = new Render({ token: requireEnv("RENDER_API_KEY"), useLocalDev: false });
	const run = await render.workflows.startTask(`${requireEnv("RENDER_WORKFLOW_SLUG")}/${TASKS.dependencyScanSweep}`, [plan.input], {
		idempotencyKey: plan.idempotencyKey,
		signal: AbortSignal.timeout(30_000),
	});
	console.log(JSON.stringify({ taskRunId: run.taskRunId, window: plan.window, repositories: plan.input.repositories.map((r) => r.repo) }));
	if (values.wait) {
		const result = await waitForMaintenanceTask(() => render.workflows.getTaskRun(run.taskRunId), DependencyScanSweepResult);
		console.log(JSON.stringify({ taskRunId: run.taskRunId, ...result }, null, 2));
		if (values.out) {
			const dir = resolve(values.out);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "scan-sweep.json"), JSON.stringify({ taskRunId: run.taskRunId, ...result }, null, 2));
			for (const row of result.results) {
				if (!row.runId) continue;
				const details = z.object({ results: z.tuple([DependencyScanResult]) }).parse(await render.workflows.getTaskRun(row.runId));
				const scan = details.results[0];
				if (scan.repo !== row.repo || scan.sha !== row.sha || scan.runId !== row.runId || scan.status !== row.status)
					throw new Error("Export identity mismatch");
				await writeFile(join(dir, `${scan.repo.replace("/", "--")}-scan.json`), JSON.stringify(scan, null, 2));
			}
		}
		process.exitCode = result.results.every((r) => r.status === "completed") ? 0 : 1;
	}
}
