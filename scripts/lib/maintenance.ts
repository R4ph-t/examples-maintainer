import { createHash } from "node:crypto";
import type { FactoryConfig } from "../../factory.config.js";
import { MaintenanceRecipe, MaintenanceSweepInput } from "../../app/schemas/index.js";

/** The window distinguishes recurring checks of unchanged commits. Sort to make discovery order irrelevant. */
export async function planMaintenance(
	config: FactoryConfig,
	window: string,
	resolve: (repo: string, branch: string) => Promise<{ installationId: number; sha: string }>,
) {
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(window) ||
		Number.isNaN(Date.parse(`${window}T00:00:00Z`)) ||
		new Date(`${window}T00:00:00Z`).toISOString().slice(0, 10) !== window
	)
		throw new Error("window must be a UTC date (YYYY-MM-DD)");
	const repos = Object.entries(config.repos)
		.filter(([, settings]) => settings.maintenance)
		.sort(([a], [b]) => a.localeCompare(b));
	if (repos.length === 0 || repos.length > 25) throw new Error("configure between 1 and 25 maintenance repositories per sweep");
	const repositories = [];
	const recipes = [];
	for (const [repo, settings] of repos) {
		recipes.push(MaintenanceRecipe.parse(settings.maintenance));
		repositories.push({ repo, ...(await resolve(repo, settings.baseBranch)) });
	}
	const input = MaintenanceSweepInput.parse({ repositories });
	const hash = createHash("sha256").update(JSON.stringify({ input, recipes })).digest("hex");
	return { input, idempotencyKey: `maintenance:${window}:${hash}` };
}
