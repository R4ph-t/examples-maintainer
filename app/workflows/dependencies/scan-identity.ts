import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoContext } from "../../config/index.js";

export function scanRecipeHash(repo: RepoContext): string {
	return createHash("sha256")
		.update(
			JSON.stringify({ recipe: repo.config.maintenance, manager: repo.config.dependencyUpdates?.packageManager, egress: repo.config.egress ?? [] }),
		)
		.digest("hex");
}

/** Source and lockfile changes invalidate prepared environments and retained selection evidence. */
export async function scanToolHash(): Promise<string> {
	const hash = createHash("sha256");
	async function visit(dir: string, prefix: string): Promise<void> {
		for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			const name = `${prefix}/${entry.name}`;
			if (entry.isDirectory()) await visit(join(dir, entry.name), name);
			else if (entry.isFile())
				hash
					.update(name)
					.update("\0")
					.update(await readFile(join(dir, entry.name)))
					.update("\0");
		}
	}
	for (const [path, prefix] of [
		["./", "dependencies"],
		["../../sandbox/", "sandbox-host"],
		["../../../sandbox/", "sandbox-guest"],
	])
		await visit(fileURLToPath(new URL(path, import.meta.url)), prefix);
	hash.update(await readFile(new URL("../../../package-lock.json", import.meta.url)));
	return hash.digest("hex");
}
