import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RepoContext } from "../config/index.js";
import { appJwt } from "./auth.js";
import { type GitHubClient, githubFor } from "./client.js";
import { GitHubHttp, type GitHubHttpOptions } from "./request.js";

/** Explicit maintenance-only credential; never falls back to a user's ambient GH_TOKEN. */
export function maintenanceMode(): "public" | "pat" | "app" {
	const explicit = process.env.MAINTENANCE_MODE?.trim();
	if (explicit) return z.enum(["public", "pat", "app"]).parse(explicit);
	return process.env.MAINTENANCE_GITHUB_TOKEN?.trim() ? "pat" : "app";
}

export function maintenanceUsesPat(): boolean {
	return maintenanceMode() === "pat";
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

function publicReadHttp(opts: GitHubHttpOptions): GitHubHttp {
	return maintenanceMode() === "public" ? new GitHubHttp(() => "", opts) : patHttp(opts);
}

/** Refuse private cloning in PAT mode: a long-lived user credential must never enter a sandbox. */
export async function assertPublicMaintenanceRepo(fullName: string, opts: GitHubHttpOptions = {}): Promise<void> {
	const repo = z.object({ private: z.boolean(), full_name: z.string() }).parse(await publicReadHttp(opts).json("GET", repoPath(fullName)));
	if (repo.private || repo.full_name.toLowerCase() !== fullName.toLowerCase()) {
		throw new Error("Public checkout requires a public repository with the configured name");
	}
}

export interface MaintenanceRevisionOptions extends GitHubHttpOptions {
	/** Test seam for the credential-free Git subprocess. */
	git?: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => Promise<string>;
}

/** Public mode uses anonymous Git; PAT/App modes retain their existing API authorization boundary. */
export async function maintenanceRevision(
	fullName: string,
	branch: string,
	opts: MaintenanceRevisionOptions = {},
): Promise<{ installationId?: number; sha: string }> {
	if (maintenanceMode() === "public") return { sha: await publicGitRevision(fullName, branch, opts) };
	const base = repoPath(fullName);
	let installationId: number | undefined;
	let http: GitHubHttp;
	if (maintenanceMode() !== "app") {
		await assertPublicMaintenanceRepo(fullName, opts);
		http = publicReadHttp(opts);
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

/** Exact public branch resolution, independent of unauthenticated REST metadata quota. */
async function publicGitRevision(fullName: string, branch: string, opts: MaintenanceRevisionOptions): Promise<string> {
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(fullName) || [".", ".."].includes(fullName.split("/")[1]))
		throw new Error("Unsupported public repository name");
	if (
		!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(branch) ||
		branch.includes("..") ||
		branch.includes("//") ||
		branch.endsWith(".") ||
		branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
	)
		throw new Error("Unsupported public branch name");
	const ref = `refs/heads/${branch}`;
	const args = [
		"-c",
		"credential.helper=",
		"-c",
		"credential.interactive=false",
		"-c",
		"core.askPass=/bin/false",
		"-c",
		"http.extraHeader=",
		"-c",
		"http.followRedirects=false",
		"-c",
		"protocol.allow=never",
		"-c",
		"protocol.https.allow=always",
		"-c",
		"http.lowSpeedLimit=1",
		"-c",
		"http.lowSpeedTime=15",
		"ls-remote",
		"--refs",
		"--exit-code",
		"--quiet",
		"--",
		`https://github.com/${fullName}.git`,
		ref,
	];
	const taskGitHome = await mkdtemp(join(tmpdir(), "maintenance-public-git-"));
	try {
		// An unset HOME can make libcurl consult the account's .netrc via getpwuid. Use an empty private home instead.
		// No user/system/local Git config, helpers, token variables, SSH agents, or remote rewrites enter this process.
		const env = {
			PATH: "/usr/bin:/bin",
			HOME: taskGitHome,
			XDG_CONFIG_HOME: taskGitHome,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "/bin/false",
			SSH_ASKPASS: "/bin/false",
			NETRC: "/dev/null",
		};
		const options = { cwd: taskGitHome, env, timeout: Math.max(1, Math.min(opts.timeoutMs ?? 30_000, 30_000)), maxBuffer: 4096 };
		const run =
			opts.git ??
			((argv, execution) =>
				new Promise<string>((resolve, reject) => {
					execFile("/usr/bin/git", argv, { ...execution, encoding: "utf8", killSignal: "SIGKILL" }, (error, stdout) => {
						if (error) reject(new Error("Anonymous Git revision lookup failed"));
						else resolve(stdout);
					});
				}));
		let output: string;
		try {
			output = await run(args, options);
		} catch {
			throw new Error("Anonymous Git revision lookup failed");
		}
		if (Buffer.byteLength(output) > 4096) throw new Error("Anonymous Git revision response was invalid");
		const lines = (output.endsWith("\n") ? output.slice(0, -1) : output).split("\n");
		const match = /^([0-9a-f]{40})\t([^\r\n]+)$/.exec(lines[0] ?? "");
		if (lines.length !== 1 || !match || match[2] !== ref) throw new Error("Anonymous Git revision response was invalid");
		return match[1];
	} finally {
		await rm(taskGitHome, { recursive: true, force: true });
	}
}

/** Controller-only publication. PATs use commit statuses; GitHub Apps retain detailed Check Runs. */
export function maintenanceReporter(repo: RepoContext, opts: GitHubHttpOptions = {}): Pick<GitHubClient, "createMaintenanceCheck"> {
	if (maintenanceMode() === "public") throw new Error("GitHub writes are disabled in public maintenance mode");
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
