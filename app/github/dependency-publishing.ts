import { z } from "zod";
import type { RepoContext } from "../config/index.js";
import { githubToken } from "./auth.js";
import { githubFor } from "./client.js";
import { maintenanceMode } from "./maintenance.js";
import { encodePath, GitHubHttp, type GitHubHttpOptions } from "./request.js";
import { GitHubError } from "./types.js";

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const RootEntry = z
	.object({
		path: z
			.string()
			.min(1)
			.max(1000)
			.refine((s) => !s.includes("/") && !s.includes("\0") && s !== "." && s !== ".."),
		mode: z.enum(["100644", "100755", "040000", "160000", "120000"]),
		type: z.enum(["blob", "tree", "commit"]),
		sha: Sha,
	})
	.refine((e) => (e.mode === "040000" ? e.type === "tree" : e.mode === "160000" ? e.type === "commit" : e.type === "blob"));
export type DependencyRootEntry = z.infer<typeof RootEntry>;
export interface DependencyCommit {
	sha: string;
	treeSha: string;
	parents: string[];
	message: string;
}
export interface DependencyPull {
	number: number;
	url: string;
	state: "open" | "closed";
	draft: boolean;
	headSha: string;
	headRef: string;
	headRepo: string;
	baseSha: string;
	baseRef: string;
	baseRepo: string;
	body: string;
	author: string;
}
export interface DependencyPublishingClient {
	actorLogin(): Promise<string>;
	getRef(branch: string): Promise<string | null>;
	getCommit(sha: string): Promise<DependencyCommit>;
	getTree(sha: string): Promise<DependencyRootEntry[]>;
	createBlob(content: string): Promise<string>;
	createTree(baseTree: string, entries: DependencyRootEntry[]): Promise<string>;
	createCommit(tree: string, parent: string, message: string): Promise<string>;
	createRef(branch: string, sha: string): Promise<void>;
	listPulls(branch: string): Promise<DependencyPull[]>;
	createDraft(args: { branch: string; base: string; title: string; body: string }): Promise<DependencyPull>;
}
const RawPull = z.object({
	number: z.number().int().positive(),
	html_url: z.url(),
	state: z.enum(["open", "closed"]),
	draft: z.boolean(),
	body: z.string().max(100_000).nullable(),
	user: z.object({ login: z.string().min(1).max(100) }),
	head: z.object({ sha: Sha, ref: z.string().max(200), repo: z.object({ full_name: z.string().max(200) }) }),
	base: z.object({ sha: Sha, ref: z.string().max(200), repo: z.object({ full_name: z.string().max(200) }) }),
});
function pull(raw: unknown): DependencyPull {
	const p = RawPull.parse(raw);
	return {
		number: p.number,
		url: p.html_url,
		state: p.state,
		draft: p.draft,
		body: p.body ?? "",
		author: p.user.login,
		headSha: p.head.sha,
		headRef: p.head.ref,
		headRepo: p.head.repo.full_name,
		baseSha: p.base.sha,
		baseRef: p.base.ref,
		baseRepo: p.base.repo.full_name,
	};
}

/** No ambient GH_TOKEN fallback; write credentials stay in the Workflows controller. */
export function dependencyPublishingClient(repo: RepoContext, opts: GitHubHttpOptions = {}): DependencyPublishingClient {
	const mode = maintenanceMode();
	if (mode === "public") throw new Error("GitHub publication is disabled in public mode");
	if (mode === "app" && !repo.installationId) throw new Error("App publication requires an installation ID");
	const token =
		mode === "pat"
			? () => {
					const value = process.env.MAINTENANCE_GITHUB_TOKEN?.trim();
					if (!value) throw new Error("MAINTENANCE_GITHUB_TOKEN is required");
					return value;
				}
			: () =>
					githubToken({
						installationId: repo.installationId,
						repo: repo.name,
						permissions: { contents: "write", pull_requests: "write" },
						fetch: opts.fetch,
					});
	const http = new GitHubHttp(token, opts);
	const prefix = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
	const refPath = (branch: string) => `${prefix}/git/ref/heads/${encodePath(branch)}`;
	return {
		async actorLogin() {
			if (mode === "app") return githubFor(repo, opts).botLogin();
			return z.object({ login: z.string().min(1).max(100) }).parse(await http.json("GET", "/user")).login;
		},
		async getRef(branch) {
			try {
				const r = z
					.object({ ref: z.literal(`refs/heads/${branch}`), object: z.object({ type: z.literal("commit"), sha: Sha }) })
					.parse(await http.json("GET", refPath(branch)));
				return r.object.sha;
			} catch (e) {
				if (e instanceof GitHubError && e.status === 404) return null;
				throw e;
			}
		},
		async getCommit(sha) {
			const r = z
				.object({
					sha: z.literal(Sha.parse(sha)),
					tree: z.object({ sha: Sha }),
					parents: z.array(z.object({ sha: Sha })).max(100),
					message: z.string().max(100_000),
				})
				.parse(await http.json("GET", `${prefix}/git/commits/${sha}`));
			return { sha: r.sha, treeSha: r.tree.sha, parents: r.parents.map((p) => p.sha), message: r.message };
		},
		async getTree(sha) {
			const r = z
				.object({ sha: z.literal(Sha.parse(sha)), truncated: z.literal(false), tree: z.array(RootEntry).max(10_000) })
				.parse(await http.json("GET", `${prefix}/git/trees/${sha}`));
			if (new Set(r.tree.map((e) => e.path)).size !== r.tree.length) throw new Error("Duplicate root tree path");
			return r.tree;
		},
		async createBlob(content) {
			return z.object({ sha: Sha }).parse(
				await http.json("POST", `${prefix}/git/blobs`, {
					body: { content: Buffer.from(content).toString("base64"), encoding: "base64" },
					idempotent: true,
				}),
			).sha;
		},
		async createTree(baseTree, entries) {
			return z
				.object({ sha: Sha })
				.parse(await http.json("POST", `${prefix}/git/trees`, { body: { base_tree: baseTree, tree: entries }, idempotent: true })).sha;
		},
		async createCommit(tree, parent, message) {
			// A lost commit response can leave an unreachable object, but cannot move a branch or create a PR.
			return z.object({ sha: Sha }).parse(await http.json("POST", `${prefix}/git/commits`, { body: { tree, parents: [parent], message } })).sha;
		},
		async createRef(branch, sha) {
			// Ref/PR writes are never blindly retried: the caller reconciles their durable identities.
			await http.json("POST", `${prefix}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha } });
		},
		async listPulls(branch) {
			return (await http.paginate<unknown>(`${prefix}/pulls`, { query: { head: `${repo.owner}:${branch}`, state: "all" }, maxPages: 5 })).map(pull);
		},
		async createDraft(args) {
			return pull(
				await http.json("POST", `${prefix}/pulls`, {
					body: { head: args.branch, base: args.base, title: args.title, body: args.body, draft: true, maintainer_can_modify: false },
				}),
			);
		},
	};
}
