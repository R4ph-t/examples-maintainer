import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { FactoryConfig } from "../../factory.config.js";
import { planDependencyMaintenance } from "./dependency-maintenance.js";

export async function planDependencyScan(config: FactoryConfig, window: string, resolve: Parameters<typeof planDependencyMaintenance>[2]) {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(window) || !Number.isFinite(Date.parse(window)))
		throw new Error("window must be a UTC ISO datetime");
	const bucket = new Date(Math.floor(Date.parse(window) / (6 * 3600_000)) * (6 * 3600_000)).toISOString();
	const plan = await planDependencyMaintenance(config, bucket.slice(0, 10), resolve);
	return { input: plan.input, window: bucket, idempotencyKey: `scan:v1:${bucket}:${plan.idempotencyKey}` };
}

export async function waitForMaintenanceTask<T>(
	get: () => Promise<unknown>,
	schema: z.ZodType<T>,
	opts: { sleep?: (ms: number) => Promise<unknown>; timeoutMs?: number } = {},
): Promise<T> {
	const deadline = Date.now() + (opts.timeoutMs ?? 23 * 3600_000);
	while (Date.now() < deadline) {
		const run = z.object({ status: z.string(), results: z.unknown().optional() }).parse(await get());
		if (["failed", "canceled"].includes(run.status)) throw new Error(`Maintenance task ${run.status}`);
		if (["completed", "succeeded"].includes(run.status)) return z.tuple([schema]).parse(run.results)[0];
		await (opts.sleep ?? sleep)(30_000);
	}
	throw new Error("Maintenance task is unconfirmed; inspect its run before retrying");
}
