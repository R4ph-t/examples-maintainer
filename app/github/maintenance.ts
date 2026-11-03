import { z } from "zod";
import type { RepoContext } from "../config/index.js";
import { appJwt } from "./auth.js";
import { type GitHubClient, githubFor } from "./client.js";
import { GitHubHttp, type GitHubHttpOptions } from "./request.js";

/** Explicit maintenance-only credential; never falls back to a user's ambient GH_TOKEN. */
export function maintenanceUsesPat(): boolean {
	return Boolean(process.env.MAINTENANCE_GITHUB_TOKEN?.trim());
}

function patHttp(opts: GitHubHttpOptions = {}): GitHubHttp {
	return new GitHubHttp(() => {
		const token = process.env.MAINTENANCE_GITHUB_TOKEN?.trim();
		if (!token) throw new Error("MAINTENANCE_GITHUB_TOKEN is required");
		return token;
	}, opts);
}

function repoPath(fullName: string): string {
	return `/repos/${fullName.split("/").map(encodeURIComponent).join("/")}`;
}

/** Refuse private cloning in PAT mode: a long-lived user credential must never enter a sandbox. */
export async function assertPublicMaintenanceRepo(fullName: string, opts: GitHubHttpOptions = {}): Promise<void> {
	const repo = z.object({ private: z.boolean(), full_name: z.string() }).parse(await patHttp(opts).json("GET", repoPath(fullName)));
	if (repo.private || repo.full_name.toLowerCase() !== fullName.toLowerCase()) {
		throw new Error("PAT maintenance currently requires a public repository with the configured name");
	}
}

/** PAT mode resolves a public revision directly; App mode retains installation-scoped access. */
export async function maintenanceRevision(
	fullName: string,
	branch: string,
	opts: GitHubHttpOptions = {},
): Promise<{ installationId?: number; sha: string }> {
	const base = repoPath(fullName);
	let installationId: number | undefined;
	let http: GitHubHttp;
	if (maintenanceUsesPat()) {
		await assertPublicMaintenanceRepo(fullName, opts);
		http = patHttp(opts);
	} else {
		const app = new GitHubHttp(() => appJwt(), opts);
		installationId = z.object({ id: z.number().int().positive() }).parse(await app.json("GET", `${base}/installation`)).id;
		const [owner, name] = fullName.split("/");
		http = githubFor({ owner, name, installationId }, opts).http;
	}
	const { sha } = z
		.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) })
		.parse(await http.json("GET", `${base}/commits/${encodeURIComponent(branch)}`));
	return installationId === undefined ? { sha } : { installationId, sha };
}

/** Controller-only publication. PATs use commit statuses; GitHub Apps retain detailed Check Runs. */
export function maintenanceReporter(repo: RepoContext, opts: GitHubHttpOptions = {}): Pick<GitHubClient, "createMaintenanceCheck"> {
	if (!maintenanceUsesPat()) return githubFor(repo, opts);
	const http = patHttp(opts);
	return {
		async createMaintenanceCheck(args) {
			const state = args.conclusion === "action_required" ? "error" : args.conclusion;
			const status = z.object({ url: z.url() }).parse(
				await http.json("POST", `${repoPath(repo.fullName)}/statuses/${args.headSha}`, {
					body: {
						state,
						context: "examples-maintainer / health",
						description: `Fresh sandbox verification: ${state}. Run ${args.externalId}`.slice(0, 140),
					},
				}),
			);
			return { htmlUrl: status.url };
		},
	};
}
