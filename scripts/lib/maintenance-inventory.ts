import { z } from "zod";
import type { FactoryConfig } from "../../factory.config.js";

const Repository = z.object({
	full_name: z.string().max(200),
	archived: z.boolean(),
	disabled: z.boolean(),
	private: z.boolean(),
	default_branch: z.string(),
	language: z.string().nullable(),
	html_url: z.url(),
});

/** Public inventory never sends a token or turns repository content into executable recipes. */
export async function inventoryMaintenance(org: string, config: FactoryConfig, fetchImpl: typeof fetch = fetch) {
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org)) throw new Error("invalid GitHub organization");
	const repositories = [];
	for (let page = 1; page <= 100; page++) {
		const response = await fetchImpl(`https://api.github.com/orgs/${org}/repos?type=public&per_page=100&page=${page}`, {
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) throw new Error(`Public inventory failed (${response.status}); no repositories have been scheduled`);
		const batch = z.array(Repository).parse(await response.json());
		for (const repo of batch) {
			if (repo.private) throw new Error("public inventory unexpectedly included a private repository");
			repositories.push({
				repo: repo.full_name,
				url: repo.html_url,
				branch: repo.default_branch,
				language: repo.language,
				coverage: repo.archived || repo.disabled ? "excluded" : config.repos[repo.full_name]?.maintenance ? "configured" : "needs_recipe",
			});
		}
		if (batch.length < 100) return { organization: org, generatedAt: new Date().toISOString(), repositories };
	}
	throw new Error("inventory exceeded pagination limit");
}
