import { z } from "zod";
import { appJwt } from "./auth.js";
import { githubFor } from "./client.js";
import { GitHubHttp, type GitHubHttpOptions } from "./request.js";

/** Resolves installation and branch head with App credentials; no broad user token enters maintenance. */
export async function maintenanceRevision(
	fullName: string,
	branch: string,
	opts: GitHubHttpOptions = {},
): Promise<{ installationId: number; sha: string }> {
	const [owner, name] = fullName.split("/");
	const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
	const app = new GitHubHttp(() => appJwt(), opts);
	const { id: installationId } = z.object({ id: z.number().int().positive() }).parse(await app.json("GET", `${base}/installation`));
	const gh = githubFor({ owner, name, installationId }, opts);
	const { sha } = z
		.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) })
		.parse(await gh.http.json("GET", `${base}/commits/${encodeURIComponent(branch)}`));
	return { installationId, sha };
}
