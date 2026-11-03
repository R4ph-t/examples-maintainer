import { parseArgs } from "node:util";
import { Render } from "@renderinc/sdk";
import { z } from "zod";
import { requireEnv, TASKS } from "../app/config/index.js";
import { DependencyPublishInput, DependencyPublishResult } from "../app/schemas/dependency-publishing.js";
const { values } = parseArgs({
	options: { repo: { type: "string" }, "review-run": { type: "string" }, "installation-id": { type: "string" } },
	strict: true,
});
const input = DependencyPublishInput.parse({
	repo: values.repo,
	reviewRunId: values["review-run"],
	...(values["installation-id"] ? { installationId: Number(values["installation-id"]) } : {}),
});
const render = new Render({ token: requireEnv("RENDER_API_KEY"), useLocalDev: false });
// Do not reuse a disabled attempt after the operator enables publishing. GitHub artifact markers deduplicate permanent effects.
const run = await render.workflows.runTask(`${requireEnv("RENDER_WORKFLOW_SLUG")}/${TASKS.dependencyPublish}`, [input], {
	signal: AbortSignal.timeout(660_000),
});
if (run.status !== "completed") throw new Error("Publication task did not complete; inspect its run before retrying");
const [result] = z.tuple([DependencyPublishResult]).parse(run.results);
if (result.repo !== input.repo || result.reviewRunId !== input.reviewRunId) throw new Error("Publication result identity mismatch");
console.log(JSON.stringify({ taskRunId: run.id, ...result }, null, 2));
if (!["published", "reused", "suppressed", "disabled"].includes(result.status)) process.exitCode = 1;
