import { parseArgs } from "node:util";
import { Render } from "@renderinc/sdk";
import { config, requireEnv, TASKS } from "../app/config/index.js";
import { maintenanceRevision } from "../app/github/index.js";
import { waitForMaintenance } from "./lib/maintenance-result.js";
import { planMaintenance } from "./lib/maintenance.js";

const { values } = parseArgs({
	options: { window: { type: "string" }, "dry-run": { type: "boolean", default: false }, wait: { type: "boolean", default: false } },
	strict: true,
});
const window = values.window ?? new Date().toISOString().slice(0, 10);
const plan = await planMaintenance(config, window, maintenanceRevision);
if (values["dry-run"]) {
	console.log(JSON.stringify(plan, null, 2));
} else {
	const render = new Render({ token: requireEnv("RENDER_API_KEY"), useLocalDev: false });
	const run = await render.workflows.startTask(`${requireEnv("RENDER_WORKFLOW_SLUG")}/${TASKS.maintenanceSweep}`, [plan.input], {
		idempotencyKey: plan.idempotencyKey,
		signal: AbortSignal.timeout(30_000),
	});
	console.log(
		JSON.stringify({
			taskRunId: run.taskRunId,
			window,
			repositories: plan.input.repositories.map((r) => r.repo),
			resolutionFailures: plan.input.resolutionFailures,
		}),
	);
	if (values.wait) {
		const result = await waitForMaintenance(() => render.workflows.getTaskRun(run.taskRunId));
		console.log(JSON.stringify({ taskRunId: run.taskRunId, ...result }, null, 2));
		process.exitCode = result.healthy ? 0 : 1;
	}
}
