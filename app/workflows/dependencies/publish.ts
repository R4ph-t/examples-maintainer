import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { type RepoContext, requireRepo } from "../../config/index.js";
import { codeSpan, sanitizeInline } from "../../format/index.js";
import {
	type DependencyPublishingClient,
	type DependencyPull,
	type DependencyRootEntry,
	dependencyPublishingClient,
} from "../../github/dependency-publishing.js";
import { maintenanceMode } from "../../github/index.js";
import { AuditReport } from "../../schemas/audits.js";
import { DependencyReviewResult } from "../../schemas/dependencies.js";
import { DependencyPublishInput, DependencyPublishResult } from "../../schemas/dependency-publishing.js";
import { MaintenanceRecipe } from "../../schemas/maintenance.js";
import { buildArtifact } from "./artifact.js";
import { compareAuditReports } from "./audit.js";

export interface DependencyPublicationDeps {
	/** Must fetch a completed dependency-review from the configured Workflow and verify its task/run identity. Never accepts request-supplied review content. */
	loadReview: (runId: string) => Promise<unknown>;
	github?: (repo: RepoContext) => DependencyPublishingClient;
	/** Controller-only test seam. Production requires MAINTENANCE_PUBLISH_DRAFTS=true as well as repo opt-in. */
	enabled?: boolean;
	now?: () => Date;
}
class Refusal extends Error {
	constructor(
		readonly status: "stale" | "rejected" | "suppressed",
		readonly reason: NonNullable<DependencyPublishResult["reason"]>,
	) {
		super(reason);
	}
}
const MAX_EVIDENCE_AGE_MS = 24 * 3600_000;

/** Publishes immutable tested files as a draft; never edits a branch, PR, or merge state. */
export async function runDependencyPublication(raw: unknown, deps: DependencyPublicationDeps): Promise<DependencyPublishResult> {
	const input = DependencyPublishInput.parse(raw);
	const repo = requireRepo(input.repo, input.installationId ?? 0);
	const now = deps.now ?? (() => new Date());
	const result: DependencyPublishResult = {
		repo: repo.fullName,
		reviewRunId: input.reviewRunId,
		status: "disabled",
		reason: "publishing_disabled",
		completedAt: now().toISOString(),
	};
	const enabled = deps.enabled ?? (process.env.MAINTENANCE_PUBLISH_DRAFTS === "true" && maintenanceMode() !== "public");
	if (!enabled || repo.config.dependencyUpdates?.publishDrafts !== true) return DependencyPublishResult.parse(result);
	delete result.reason;
	result.status = "unknown";
	try {
		const loaded = await deps.loadReview(input.reviewRunId);
		const parsed = DependencyReviewResult.safeParse(loaded);
		if (!parsed.success) throw new Refusal("rejected", "invalid_review");
		const review = parsed.data;
		if (
			review.repo !== repo.fullName ||
			review.runId !== input.reviewRunId ||
			review.status !== "ready_for_review" ||
			!review.artifact ||
			!review.candidate
		)
			throw new Refusal("rejected", "invalid_review");
		await validateEvidence(review, repo, now());
		const artifact = review.artifact;
		result.artifactId = artifact.id;
		const branch = `maintenance/deps-${artifact.id}`;
		result.branch = branch;
		const marker = `<!-- examples-maintainer:dependency:${artifact.id} -->`;
		const gh = (deps.github ?? dependencyPublishingClient)(repo);
		const actor = await gh.actorLogin();
		const assertBase = async () => {
			if ((await gh.getRef(repo.config.baseBranch)) !== review.sha) throw new Refusal("stale", "base_moved");
		};
		await assertBase();
		const base = await gh.getCommit(review.sha);
		if (base.sha !== review.sha) throw new Refusal("rejected", "invalid_review");
		const entries = await gh.getTree(base.treeSha);
		if (treeSha(entries) !== base.treeSha) throw new Refusal("rejected", "invalid_review");
		const changed = artifact.files.map((file) => {
			const existing = entries.find((e) => e.path === file.path);
			if (existing?.type !== "blob" || !["100644", "100755"].includes(existing.mode) || existing.sha !== blobSha(file.before))
				throw new Refusal("rejected", "invalid_review");
			return { ...existing, sha: blobSha(file.after) };
		});
		const expectedTree = treeSha(entries.map((e) => changed.find((c) => c.path === e.path) ?? e));
		if (expectedTree === base.treeSha) throw new Refusal("rejected", "invalid_review");
		const checkBranch = async (sha: string) => {
			const commit = await gh.getCommit(sha);
			if (
				commit.sha !== sha ||
				commit.treeSha !== expectedTree ||
				!isDeepStrictEqual(commit.parents, [review.sha]) ||
				!commit.message.includes(marker)
			)
				throw new Refusal("rejected", "branch_modified");
		};
		const existingPull = async (head: string | null): Promise<DependencyPull | undefined> => {
			const pulls = await gh.listPulls(branch);
			if (pulls.length > 1) throw new Refusal("rejected", "pull_modified");
			const pull = pulls[0];
			if (!pull) return;
			validatePull(pull, repo, branch, marker, actor);
			result.pullNumber = pull.number;
			result.pullUrl = pull.url;
			if (pull.state === "closed") throw new Refusal("suppressed", "closed_proposal");
			if (!head || pull.headSha !== head || !pull.draft) throw new Refusal("rejected", "pull_modified");
			await checkBranch(head);
			return pull;
		};
		let head = await gh.getRef(branch);
		if (head) await checkBranch(head);
		if (await existingPull(head)) {
			await assertBase();
			result.status = "reused";
			return finish(result, now());
		}
		if (!head) {
			for (const file of artifact.files) {
				if ((await gh.createBlob(file.after)) !== blobSha(file.after)) throw new Refusal("rejected", "invalid_review");
			}
			// GitHub must reproduce the locally derived full tree before any reachable branch exists.
			if ((await gh.createTree(base.treeSha, changed)) !== expectedTree) throw new Refusal("rejected", "invalid_review");
			const created = await gh.createCommit(
				expectedTree,
				review.sha,
				`Update ${review.candidate.name} to ${review.candidate.toVersion}\n\n${marker}`,
			);
			await checkBranch(created);
			await assertBase();
			try {
				await gh.createRef(branch, created);
			} catch {
				// A timeout or 422 can mean another caller (or this request) already created the ref.
				const reconciled = await gh.getRef(branch);
				if (!reconciled) throw new Error("Reference creation is unconfirmed");
				await checkBranch(reconciled);
			}
			head = await gh.getRef(branch);
			if (!head) throw new Error("Reference creation is unconfirmed");
			await checkBranch(head);
		}
		await assertBase();
		// Reconcile after branch creation too: concurrent callers share one immutable branch.
		if (await existingPull(head)) result.status = "reused";
		else {
			let pull: DependencyPull;
			try {
				pull = await gh.createDraft({
					branch,
					base: repo.config.baseBranch,
					title: sanitizeInline(`Update ${review.candidate.name} to ${review.candidate.toVersion}`).slice(0, 200),
					body: proposalBody(review, marker),
				});
				validatePull(pull, repo, branch, marker, actor);
				if (pull.state !== "open" || !pull.draft || pull.headSha !== head) throw new Refusal("rejected", "pull_modified");
				result.status = "published";
			} catch (e) {
				if (e instanceof Refusal) throw e;
				const reconciled = await existingPull(head);
				if (!reconciled) throw new Error("Draft creation is unconfirmed");
				pull = reconciled;
				result.status = "reused";
			}
			result.pullNumber = pull.number;
			result.pullUrl = pull.url;
		}
		// A base update cannot be atomically excluded by GitHub's PR-create API. Report the race, leave the draft for human review.
		await assertBase();
		if ((await gh.getRef(branch)) !== head) throw new Refusal("rejected", "branch_modified");
	} catch (e) {
		result.status = e instanceof Refusal ? e.status : "unknown";
		result.reason = e instanceof Refusal ? e.reason : "publication_unconfirmed";
	}
	return finish(result, now());
}

async function validateEvidence(review: DependencyReviewResult, repo: RepoContext, now: Date) {
	if (!review.artifact || !review.candidate || !repo.config.dependencyUpdates || !repo.config.maintenance)
		throw new Refusal("rejected", "invalid_review");
	const fresh = (date: string) => {
		const age = now.getTime() - Date.parse(date);
		if (age < -60_000 || age > MAX_EVIDENCE_AGE_MS) throw new Refusal("rejected", "stale_evidence");
	};
	fresh(review.completedAt);
	if (!review.audit?.candidate) throw new Refusal("rejected", "audit_not_passed");
	const baselineAudit = AuditReport.parse(review.audit.baseline);
	const candidateAudit = AuditReport.parse(review.audit.candidate);
	fresh(baselineAudit.scannedAt);
	fresh(candidateAudit.scannedAt);
	const expectedTool = repo.config.dependencyUpdates.packageManager === "pip" ? "pip-audit" : repo.config.dependencyUpdates.packageManager;
	const compared = compareAuditReports(baselineAudit, candidateAudit);
	if (
		baselineAudit.tool !== expectedTool ||
		candidateAudit.tool !== expectedTool ||
		compared.status !== "passed" ||
		!isDeepStrictEqual(compared, review.audit.comparison)
	)
		throw new Refusal("rejected", "audit_not_passed");
	const recipe = MaintenanceRecipe.parse(repo.config.maintenance);
	const recipeHash = digest(JSON.stringify(recipe));
	const smokeHash = digest(await readFile(new URL("../../../sandbox/maintenance-smoke.mjs", import.meta.url)));
	const stageNames = ["prepare", "runtime", recipe.install.name, ...recipe.checks.map((s) => s.name), "smoke"];
	for (const check of [review.baseline, review.verification]) {
		if (
			!check ||
			check.recipeHash !== recipeHash ||
			check.smokeRunnerHash !== smokeHash ||
			!isDeepStrictEqual(
				check.stages.map((s) => s.name),
				stageNames,
			) ||
			check.stages.some((s) => s.status !== "passed" || s.exitCode !== 0)
		)
			throw new Refusal("rejected", "invalid_review");
	}
	const runtime = (r: typeof review.baseline) => r?.stages.find((s) => s.name === "runtime")?.output;
	if (!runtime(review.baseline)?.trim() || runtime(review.baseline) !== runtime(review.verification) || review.generation?.exitCode !== 0)
		throw new Refusal("rejected", "invalid_review");
	const before = { files: review.artifact.files.map((f) => ({ path: f.path, content: f.before })), installed: {} };
	const after = { files: review.artifact.files.map((f) => ({ path: f.path, content: f.after })), installed: {} };
	let rebuilt: typeof review.artifact;
	try {
		rebuilt = await buildArtifact(review.sha, repo.config.dependencyUpdates.packageManager, review.candidate, before, after);
	} catch {
		throw new Refusal("rejected", "invalid_review");
	}
	if (!isDeepStrictEqual(rebuilt, review.artifact)) throw new Refusal("rejected", "invalid_review");
}
function validatePull(p: DependencyPull, repo: RepoContext, branch: string, marker: string, actor: string) {
	if (
		p.headRef !== branch ||
		p.baseRef !== repo.config.baseBranch ||
		p.headRepo.toLowerCase() !== repo.fullName.toLowerCase() ||
		p.baseRepo.toLowerCase() !== repo.fullName.toLowerCase() ||
		p.author.toLowerCase() !== actor.toLowerCase() ||
		!p.body.includes(marker)
	)
		throw new Refusal("rejected", "pull_modified");
}
function proposalBody(review: DependencyReviewResult, marker: string): string {
	const c = review.candidate;
	if (!c || !review.artifact || !review.audit?.comparison) throw new Refusal("rejected", "invalid_review");
	const audit = review.audit.comparison;
	return [
		marker,
		"",
		`Updates ${codeSpan(c.name)} from ${codeSpan(c.fromVersion)} to ${codeSpan(c.toVersion)}.`,
		"",
		`Tested base: ${codeSpan(review.sha)}`,
		`Artifact: ${codeSpan(review.artifact.id)}`,
		`Review run: ${codeSpan(review.runId)}`,
		"",
		"Baseline and the exact proposed files passed installation, configured checks, and HTTP smoke checks in separate fresh sandboxes. All three sandboxes were confirmed terminated.",
		"",
		`Audit comparison: ${audit.fixed.length} fixed, ${audit.remaining.length} remaining, ${audit.introduced.length} introduced; no newly introduced high/critical or unknown-severity findings.`,
		"",
		...audit.fixed.slice(0, 20).map((f) => `- Fixed ${codeSpan(f.id)} in ${codeSpan(f.package)}.`),
		"",
		"This is a draft for human review. The checks cover the configured recipe, not every application behavior. The base may advance after publication; revalidate before merging.",
	].join("\n");
}
function digest(value: string | Buffer) {
	return createHash("sha256").update(value).digest("hex");
}
function blobSha(content: string) {
	const b = Buffer.from(content);
	return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
}
function treeSha(entries: DependencyRootEntry[]): string {
	const sorted = [...entries].sort((a, b) =>
		Buffer.compare(Buffer.from(a.path + (a.type === "tree" ? "/" : "")), Buffer.from(b.path + (b.type === "tree" ? "/" : ""))),
	);
	const body = Buffer.concat(
		sorted.map((e) => Buffer.concat([Buffer.from(`${e.mode === "040000" ? "40000" : e.mode} ${e.path}\0`), Buffer.from(e.sha, "hex")])),
	);
	return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex");
}
function finish(result: DependencyPublishResult, now: Date) {
	return DependencyPublishResult.parse({ ...result, completedAt: now.toISOString() });
}
