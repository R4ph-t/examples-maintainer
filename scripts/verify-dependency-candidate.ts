import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { Render } from "@renderinc/sdk";
import { requireEnv, TASKS } from "../app/config/index.js";
import { SelectedDependencyInput, SelectedDependencyResult } from "../app/schemas/index.js";
import { waitForMaintenanceTask } from "./lib/dependency-scanning.js";

const { values } = parseArgs({
	options: { repo: { type: "string" }, "scan-run": { type: "string" }, candidate: { type: "string" }, wait: { type: "boolean" } },
	strict: true,
});
const input = SelectedDependencyInput.parse({ repo: values.repo, scanRunId: values["scan-run"], candidateName: values.candidate });
const render = new Render({ token: requireEnv("RENDER_API_KEY"), useLocalDev: false });
const run = await render.workflows.startTask(`${requireEnv("RENDER_WORKFLOW_SLUG")}/${TASKS.dependencyVerifySelected}`, [input], {
	idempotencyKey: `selected-dependency:v1:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`,
	signal: AbortSignal.timeout(30_000),
});
console.log(JSON.stringify({ taskRunId: run.taskRunId, ...input }));
if (values.wait) {
	const result = await waitForMaintenanceTask(() => render.workflows.getTaskRun(run.taskRunId), SelectedDependencyResult, {
		timeoutMs: 3 * 3600_000,
	});
	if (result.repo !== input.repo || result.scanRunId !== input.scanRunId || result.candidateName !== input.candidateName)
		throw new Error("Selection result identity mismatch");
	console.log(JSON.stringify({ taskRunId: run.taskRunId, ...result }, null, 2));
	process.exitCode = result.status === "verified" ? 0 : 1;
}
