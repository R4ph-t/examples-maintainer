import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { MaintenanceSweepResult } from "../../app/schemas/index.js";

const Run = z.object({ status: z.string(), results: z.unknown().optional() });

/** A successful Workflow invocation can contain failed repository checks. Inspect both levels. */
export async function waitForMaintenance(
	getRun: () => Promise<unknown>,
	opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<unknown> } = {},
) {
	const until = Date.now() + (opts.timeoutMs ?? 10 * 3600_000);
	while (Date.now() < until) {
		const run = Run.parse(await getRun());
		if (["failed", "canceled"].includes(run.status)) throw new Error(`Maintenance Workflow ${run.status}; inspect its run in Render`);
		if (["succeeded", "completed"].includes(run.status)) {
			const [result] = z.tuple([MaintenanceSweepResult]).parse(run.results);
			return { ...result, healthy: result.results.every((r) => r.status === "passed" && r.reporting !== "failed") };
		}
		await (opts.sleep ?? sleep)(opts.pollMs ?? 30_000);
	}
	throw new Error("Timed out waiting for maintenance; the Workflow may still be running. Inspect it before starting another run.");
}
