import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { FactoryConfig } from "../../factory.config.js";
import { DependencySweepResult } from "../../app/schemas/index.js";
import { planMaintenance } from "./maintenance.js";

export async function planDependencyMaintenance(config: FactoryConfig, window: string, resolve: Parameters<typeof planMaintenance>[2]) {
	const enabled = { ...config, repos: Object.fromEntries(Object.entries(config.repos).filter(([, repo]) => repo.dependencyUpdates)) };
	const plan = await planMaintenance(enabled, window, resolve);
	const policy = createHash("sha256")
		.update(
			JSON.stringify({
				version: 1,
				repos: Object.entries(enabled.repos)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, repo]) => [name, repo.dependencyUpdates]),
			}),
		)
		.digest("hex");
	return { input: plan.input, idempotencyKey: `dependencies:${policy}:${plan.idempotencyKey}` };
}

export async function waitForDependencyMaintenance(
	get: () => Promise<unknown>,
	opts: { sleep?: (ms: number) => Promise<unknown>; timeoutMs?: number } = {},
) {
	const deadline = Date.now() + (opts.timeoutMs ?? 10 * 3600_000);
	while (Date.now() < deadline) {
		const run = z.object({ status: z.string(), results: z.unknown().optional() }).parse(await get());
		if (["failed", "canceled"].includes(run.status)) throw new Error(`Dependency sweep ${run.status}`);
		if (["completed", "succeeded"].includes(run.status)) {
			const [report] = z.tuple([DependencySweepResult]).parse(run.results);
			return { ...report, healthy: report.results.every((r) => ["ready_for_review", "no_eligible_update"].includes(r.status)) };
		}
		await (opts.sleep ?? sleep)(30_000);
	}
	throw new Error("Dependency sweep is still unconfirmed; inspect its run before retrying");
}
