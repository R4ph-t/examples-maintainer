import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../app/config/index.js";
import {
	type DependencyCommit,
	type DependencyPublishingClient,
	type DependencyPull,
	type DependencyRootEntry,
	dependencyPublishingClient,
} from "../app/github/dependency-publishing.js";
import { GitHubError } from "../app/github/index.js";
import type { AuditReport } from "../app/schemas/audits.js";
import type { DependencyCandidate, DependencyReviewResult, MaintenanceResult } from "../app/schemas/index.js";
import { buildArtifact } from "../app/workflows/dependencies/artifact.js";
import { compareAuditReports } from "../app/workflows/dependencies/audit.js";
import { runDependencyPublication } from "../app/workflows/dependencies/publish.js";
import { REPO } from "./fixtures/config.js";

function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("Missing fixture value");
	return value;
}

const SHA = "a".repeat(40);
const RUN = "trn-review1";
const input = { repo: REPO, reviewRunId: RUN };
const now = () => new Date("2026-11-03T21:00:00Z");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
let gitDir: string;
beforeAll(async () => {
	gitDir = await mkdtemp(join(tmpdir(), "publisher-fixture-"));
	execFileSync("git", ["init", "-q", gitDir]);
});
afterAll(async () => {
	await rm(gitDir, { recursive: true, force: true });
});
beforeEach(() => {
	required(config.repos[REPO].dependencyUpdates).publishDrafts = true;
});
afterEach(() => {
	delete required(config.repos[REPO].dependencyUpdates).publishDrafts;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
function blob(value: string) {
	return execFileSync("git", ["hash-object", "--stdin"], { cwd: gitDir, input: value, encoding: "utf8" }).trim();
}
function tree(entries: DependencyRootEntry[]) {
	return execFileSync("git", ["mktree", "--missing", "-z"], {
		cwd: gitDir,
		input: entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}\0`).join(""),
		encoding: "utf8",
	}).trim();
}
async function world() {
	const candidate: DependencyCandidate = {
		name: "express",
		section: "dependencies",
		fromRange: "^5.0.0",
		fromVersion: "5.0.0",
		toVersion: "5.2.0",
		toRange: "^5.2.0",
		kind: "minor",
	};
	const snapshot = (after: boolean) => ({
		files: [
			{ path: "package.json" as const, content: JSON.stringify({ name: "app", dependencies: { express: after ? "^5.2.0" : "^5.0.0" } }) },
			{
				path: "package-lock.json" as const,
				content: JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/express": { version: after ? "5.2.0" : "5.0.0" } } }),
			},
		],
		installed: {},
	});
	const artifact = await buildArtifact(SHA, "npm", candidate, snapshot(false), snapshot(true));
	const recipe = required(config.repos[REPO].maintenance);
	const recipeHash = digest(JSON.stringify(recipe));
	const smokeRunnerHash = digest(await readFile(new URL("../sandbox/maintenance-smoke.mjs", import.meta.url)));
	const check = (id: string): MaintenanceResult => ({
		repo: REPO,
		sha: SHA,
		runId: RUN,
		recipeHash,
		smokeRunnerHash,
		status: "passed",
		sandboxId: id,
		cleanup: "terminated",
		reporting: "skipped",
		stages: ["prepare", "runtime", "install", "build", "smoke"].map((name) => ({
			name,
			status: "passed",
			exitCode: 0,
			durationMs: 100,
			output: name === "runtime" ? "v24.22.1\n11.19.1" : "",
		})),
	});
	const baselineAudit: AuditReport = { tool: "npm", status: "completed", findings: [], scannedAt: now().toISOString() };
	const candidateAudit = structuredClone(baselineAudit);
	const review: DependencyReviewResult = {
		repo: REPO,
		sha: SHA,
		runId: RUN,
		status: "ready_for_review",
		publishing: "disabled",
		baseline: check("sbx-before"),
		verification: check("sbx-after"),
		candidate,
		artifact,
		generation: { sandboxId: "sbx-generate", cleanup: "terminated", output: "", exitCode: 0 },
		audit: { baseline: baselineAudit, candidate: candidateAudit, comparison: compareAuditReports(baselineAudit, candidateAudit) },
		completedAt: now().toISOString(),
	};
	const entries: DependencyRootEntry[] = [
		...artifact.files.map((f) => ({ path: f.path, mode: "100644" as const, type: "blob" as const, sha: blob(f.before) })),
		{ path: "src", mode: "040000", type: "tree", sha: "b".repeat(40) },
		{ path: "src.js", mode: "100755", type: "blob", sha: "c".repeat(40) },
	];
	const baseTree = tree(entries);
	const refs = new Map([["main", SHA]]);
	const commits = new Map<string, DependencyCommit>([[SHA, { sha: SHA, treeSha: baseTree, parents: [], message: "baseline" }]]);
	const pulls: DependencyPull[] = [];
	const writes: string[] = [];
	const gh: DependencyPublishingClient = {
		actorLogin: vi.fn(async () => "maintainer-bot"),
		getRef: vi.fn(async (branch) => refs.get(branch) ?? null),
		getCommit: vi.fn(async (sha) => {
			const c = commits.get(sha);
			if (!c) throw new Error("Missing commit");
			return c;
		}),
		getTree: vi.fn(async () => entries),
		createBlob: vi.fn(async (content) => {
			writes.push("blob");
			return blob(content);
		}),
		createTree: vi.fn(async (_base: string, changed: DependencyRootEntry[]) => {
			writes.push("tree");
			return tree(entries.map((e) => changed.find((f) => f.path === e.path) ?? e));
		}),
		createCommit: vi.fn(async (treeSha, parent, message) => {
			writes.push("commit");
			const sha = String(commits.size).padStart(40, "0");
			commits.set(sha, { sha, treeSha, parents: [parent], message });
			return sha;
		}),
		createRef: vi.fn(async (branch, sha) => {
			writes.push("ref");
			if (refs.has(branch)) throw new Error("Ref exists");
			refs.set(branch, sha);
		}),
		listPulls: vi.fn(async () => [...pulls]),
		createDraft: vi.fn(async ({ branch, base, body }) => {
			writes.push("pull");
			if (pulls.length) throw new Error("Already exists");
			const p: DependencyPull = {
				number: 1,
				url: "https://github.com/acme/widget/pull/1",
				state: "open",
				draft: true,
				body,
				author: "maintainer-bot",
				headSha: required(refs.get(branch)),
				headRef: branch,
				headRepo: REPO,
				baseSha: required(refs.get(base)),
				baseRef: base,
				baseRepo: REPO,
			};
			pulls.push(p);
			return p;
		}),
	};
	const loadReview = vi.fn(async () => review);
	return { review, refs, commits, entries, pulls, writes, gh, loadReview, deps: { loadReview, github: () => gh, enabled: true, now } };
}

describe("dependency draft publication", () => {
	it("is disabled without both controller and repository opt-in", async () => {
		const w = await world();
		expect((await runDependencyPublication(input, { ...w.deps, enabled: false })).status).toBe("disabled");
		delete required(config.repos[REPO].dependencyUpdates).publishDrafts;
		expect((await runDependencyPublication(input, w.deps)).status).toBe("disabled");
		expect(w.loadReview).not.toHaveBeenCalled();
		expect(w.writes).toEqual([]);
	});
	it("accepts only a retained review run ID, not client-supplied files", async () => {
		const w = await world();
		await expect(runDependencyPublication({ ...input, review: w.review }, w.deps)).rejects.toThrow();
		expect(w.loadReview).not.toHaveBeenCalled();
	});
	it("publishes exact tested files as one draft and reuses it without additional writes", async () => {
		const w = await world();
		const result = await runDependencyPublication(input, w.deps);
		expect(result).toMatchObject({ status: "published", pullNumber: 1, artifactId: required(w.review.artifact).id });
		expect(w.loadReview).toHaveBeenCalledWith(RUN);
		expect(w.pulls[0]).toMatchObject({ draft: true, baseRef: "main" });
		expect(w.pulls[0].body).toContain(SHA);
		const count = w.writes.length;
		expect((await runDependencyPublication(input, w.deps)).status).toBe("reused");
		expect(w.writes).toHaveLength(count);
	});
	it.each(["repo", "runId", "artifact", "patch", "recipe", "smoke", "runtime", "exit", "audit", "age"])(
		"rejects tampered or stale %s evidence before writes",
		async (field) => {
			const w = await world();
			if (field === "repo") w.review.repo = "acme/elsewhere";
			if (field === "runId") w.review.runId = "trn-other";
			if (field === "artifact") required(w.review.artifact).files[0].after += "tamper";
			if (field === "patch") required(w.review.artifact).patch += "tamper";
			if (field === "recipe") required(w.review.baseline).recipeHash = "f".repeat(64);
			if (field === "smoke") required(w.review.verification).smokeRunnerHash = "f".repeat(64);
			if (field === "runtime") required(w.review.verification).stages[1].output = "different runtime";
			if (field === "exit") required(w.review.generation).exitCode = 1;
			if (field === "audit") {
				required(required(w.review.audit).candidate).findings = [
					{ id: "GHSA-new", package: "express", version: "5.2.0", severity: "critical", direct: true, fixVersions: [] },
				];
			}
			if (field === "age") w.review.completedAt = "2026-11-01T00:00:00Z";
			expect((await runDependencyPublication(input, w.deps)).status).toBe("rejected");
			expect(w.writes).toEqual([]);
		},
	);
	it("refuses a moved base without any writes", async () => {
		const w = await world();
		w.refs.set("main", "d".repeat(40));
		expect(await runDependencyPublication(input, w.deps)).toMatchObject({ status: "stale", reason: "base_moved" });
		expect(w.writes).toEqual([]);
	});
	it("stops a base change between object creation and branch creation", async () => {
		const w = await world();
		const original = w.gh.createCommit;
		w.gh.createCommit = vi.fn(async (treeSha: string, parent: string, message: string) => {
			const sha = await original(treeSha, parent, message);
			w.refs.set("main", "d".repeat(40));
			return sha;
		});
		expect(await runDependencyPublication(input, w.deps)).toMatchObject({ status: "stale", reason: "base_moved" });
		expect(w.gh.createRef).not.toHaveBeenCalled();
		expect(w.gh.createDraft).not.toHaveBeenCalled();
	});
	it("rejects old audit evidence even when the review itself is recent", async () => {
		const w = await world();
		required(w.review.audit).baseline.scannedAt = "2026-11-01T00:00:00Z";
		expect(await runDependencyPublication(input, w.deps)).toMatchObject({ status: "rejected", reason: "stale_evidence" });
		expect(w.writes).toEqual([]);
	});
	it("requires GitHub to reproduce the independently computed complete tree", async () => {
		const w = await world();
		vi.mocked(w.gh.createTree).mockResolvedValue("f".repeat(40));
		expect((await runDependencyPublication(input, w.deps)).status).toBe("rejected");
		expect(w.gh.createRef).not.toHaveBeenCalled();
		expect(w.gh.createDraft).not.toHaveBeenCalled();
	});
	it("refuses a mismatched baseline file blob before writes", async () => {
		const w = await world();
		w.entries[0].sha = "f".repeat(40);
		required(w.commits.get(SHA)).treeSha = tree(w.entries);
		expect((await runDependencyPublication(input, w.deps)).status).toBe("rejected");
		expect(w.writes).toEqual([]);
	});
	it("reconciles lost create-ref and create-PR responses without blindly retrying writes", async () => {
		const w = await world();
		const originalRef = w.gh.createRef;
		const originalPull = w.gh.createDraft;
		w.gh.createRef = vi.fn(async (branch: string, sha: string) => {
			await originalRef(branch, sha);
			throw new Error("response lost secret");
		});
		w.gh.createDraft = vi.fn(async (args: Parameters<typeof originalPull>[0]) => {
			await originalPull(args);
			throw new Error("response lost secret");
		});
		const result = await runDependencyPublication(input, w.deps);
		expect(result.status).toBe("reused");
		expect(w.gh.createRef).toHaveBeenCalledOnce();
		expect(w.gh.createDraft).toHaveBeenCalledOnce();
		expect(JSON.stringify(result)).not.toContain("secret");
	});
	it("leaves ambiguous writes unconfirmed when reconciliation cannot find a durable artifact", async () => {
		const w = await world();
		w.gh.createDraft = vi.fn(async () => {
			throw new Error("secret response");
		});
		const result = await runDependencyPublication(input, w.deps);
		expect(result).toMatchObject({ status: "unknown", reason: "publication_unconfirmed" });
		expect(w.gh.createDraft).toHaveBeenCalledOnce();
		expect(JSON.stringify(result)).not.toContain("secret");
	});
	it("logs only HTTP status when GitHub refuses a draft, preserving reconciliation", async () => {
		const w = await world();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		w.gh.createDraft = vi.fn(async () => {
			throw new GitHubError(403, "credential-secret", "repository-secret");
		});
		const result = await runDependencyPublication(input, w.deps);
		expect(result).toMatchObject({ status: "unknown", reason: "publication_unconfirmed" });
		expect(w.gh.createDraft).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith("Dependency draft creation unconfirmed", { httpStatus: 403 });
		expect(JSON.stringify([result, warn.mock.calls])).not.toContain("secret");
	});
	it("overlapping publishers converge on one immutable branch and one draft", async () => {
		const w = await world();
		const results = await Promise.all([runDependencyPublication(input, w.deps), runDependencyPublication(input, w.deps)]);
		expect(results.map((r) => r.status).sort()).toEqual(["published", "reused"]);
		expect(w.pulls).toHaveLength(1);
		expect(w.refs.size).toBe(2);
	});
	it.each(["branch", "marker", "author", "ready", "base"])("preserves human changes to %s instead of overwriting", async (field) => {
		const w = await world();
		const first = await runDependencyPublication(input, w.deps);
		expect(first.status).toBe("published");
		const count = w.writes.length;
		if (field === "branch") required(w.commits.get(required(w.refs.get(required(first.branch))))).parents.push("f".repeat(40));
		if (field === "marker") w.pulls[0].body = "Human rewritten body";
		if (field === "author") w.pulls[0].author = "someone-else";
		if (field === "ready") w.pulls[0].draft = false;
		if (field === "base") w.pulls[0].baseRef = "release";
		expect((await runDependencyPublication(input, w.deps)).status).toBe("rejected");
		expect(w.writes).toHaveLength(count);
	});
	it("suppresses a closed proposal even after its branch was deleted", async () => {
		const w = await world();
		const first = await runDependencyPublication(input, w.deps);
		w.pulls[0].state = "closed";
		w.refs.delete(required(first.branch));
		const count = w.writes.length;
		expect(await runDependencyPublication(input, w.deps)).toMatchObject({ status: "suppressed", reason: "closed_proposal", pullNumber: 1 });
		expect(w.writes).toHaveLength(count);
	});
	it("reports a base-change race after creating a draft and never merges or deletes it", async () => {
		const w = await world();
		const original = w.gh.createDraft;
		w.gh.createDraft = vi.fn(async (args: Parameters<typeof original>[0]) => {
			const p = await original(args);
			w.refs.set("main", "f".repeat(40));
			return p;
		});
		expect(await runDependencyPublication(input, w.deps)).toMatchObject({ status: "stale", reason: "base_moved", pullNumber: 1 });
		expect(w.pulls[0].draft).toBe(true);
	});
});

describe("dedicated GitHub publication transport", () => {
	it("never uses an ambient token or enables writes in public mode", async () => {
		vi.stubEnv("MAINTENANCE_MODE", "public");
		vi.stubEnv("GH_TOKEN", "ambient");
		const repo = { owner: "acme", name: "widget", fullName: REPO, installationId: 0, config: config.repos[REPO] };
		expect(() => dependencyPublishingClient(repo)).toThrow("disabled");
		vi.stubEnv("MAINTENANCE_MODE", "pat");
		vi.stubEnv("MAINTENANCE_GITHUB_TOKEN", "");
		await expect(dependencyPublishingClient(repo, { maxAttempts: 1 }).actorLogin()).rejects.toThrow("MAINTENANCE_GITHUB_TOKEN");
	});
	it("uses the dedicated PAT, requests only drafts, and does not retry an ambiguous PR POST", async () => {
		vi.stubEnv("MAINTENANCE_MODE", "pat");
		vi.stubEnv("MAINTENANCE_GITHUB_TOKEN", "dedicated");
		vi.stubEnv("GH_TOKEN", "ambient");
		const fetch = vi.fn(async (_url, init: RequestInit | undefined) => {
			expect(init?.headers).toMatchObject({ Authorization: "Bearer dedicated" });
			expect(JSON.parse(String(init?.body))).toMatchObject({ draft: true, maintainer_can_modify: false });
			throw new Error("lost");
		});
		const gh = dependencyPublishingClient(
			{ owner: "acme", name: "widget", fullName: REPO, installationId: 0, config: config.repos[REPO] },
			{ fetch },
		);
		await expect(gh.createDraft({ branch: "maintenance/example", base: "main", title: "Update", body: "Evidence" })).rejects.toThrow();
		expect(fetch).toHaveBeenCalledOnce();
	});
});
