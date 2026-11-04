import { readFileSync } from "node:fs";
import type { FactoryConfig, RepoConfig } from "../../factory.config.js";
import { parseMaintenanceBundle } from "../../vendor/registry-maintenance/index.js";

/** A deployed, digest-approved execution export owns maintenance coverage when configured. */
export function catalogConfiguration(fallback: FactoryConfig, env: NodeJS.ProcessEnv = process.env): FactoryConfig {
	const path = env.MAINTENANCE_CATALOG_PATH;
	const digest = env.MAINTENANCE_CATALOG_DIGEST;
	if (!path && !digest) return fallback;
	if (!path || !digest) throw new Error("Maintenance catalog path and approved digest are both required");
	const bundle = parseMaintenanceBundle(JSON.parse(readFileSync(path, "utf8")), true);
	if (bundle.contentHash !== digest) throw new Error("Maintenance catalog does not match the approved digest");
	if (!bundle.targets.length || bundle.targets.length > 25) throw new Error("This maintainer requires between 1 and 25 catalog targets");
	const repos: Record<string, RepoConfig> = {};
	for (const target of bundle.targets) {
		// Current dispatchers operate both schedules. Refuse unsupported policies rather than broadening execution.
		if (
			!target.execution.candidateVerification ||
			!["dependency-scan", "application-verification"].every((operation) => target.checks.some((c) => c.operation === operation))
		)
			throw new Error("This maintainer requires approved scan and candidate verification profiles");
		const repo = new URL(target.source.repository).pathname.slice(1);
		if (repos[repo]) throw new Error("This maintainer supports one branch per repository");
		repos[repo] = {
			baseBranch: target.source.branch,
			maintenance: target.recipe,
			egress: target.egress,
			install: target.recipe.install.command,
			verify: target.recipe.checks.map((check) => check.command),
			dependencyUpdates: { packageManager: target.packageManager, publishDrafts: false },
		};
	}
	return { ...fallback, repos };
}
