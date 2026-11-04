import { isDeepStrictEqual } from "node:util";
import { type RepoContext, requireRepo } from "../../config/index.js";
import { GitHubError, maintenanceMode } from "../../github/index.js";
import { openFreshSandbox, prepareFreshCheckout, type Sandbox, SandboxClient, sandboxClient, withSandbox } from "../../sandbox/index.js";
import {
	type AuditReport,
	type DependencyCandidate,
	type DependencyDiscovery,
	DependencyReviewInput,
	DependencyReviewResult,
	type DependencySnapshot,
	type MaintenanceResult,
	VerifyRepositoryInput,
} from "../../schemas/index.js";
import { type MaintenanceDeps, runRepositoryVerification } from "../maintenance/verify.js";
import { type DependencyFileOps, dependencyAdapter } from "./adapters.js";
import { buildArtifact } from "./artifact.js";
import { compareAuditReports, prioritizeCandidates } from "./audit.js";

export interface DependencyReviewDeps {
	verify?: (input: unknown, runId: string, deps: MaintenanceDeps) => Promise<MaintenanceResult>;
	open?: (repo: RepoContext) => Promise<Sandbox>;
	prepare?: (sandbox: Sandbox, repo: RepoContext, sha: string) => Promise<void>;
	discover?: (snapshot: DependencySnapshot) => Promise<DependencyDiscovery>;
	audit?: (sandbox: Sandbox, installed: Record<string, string>) => Promise<AuditReport>;
	files?: DependencyFileOps;
}

/** One bounded candidate, with independent baseline, generation, and clean verification sandboxes. No publication. */
export async function runDependencyReview(raw: unknown, runId: string, deps: DependencyReviewDeps = {}): Promise<DependencyReviewResult> {
	const request = DependencyReviewInput.parse(raw);
	const input = VerifyRepositoryInput.parse({ repo: request.repo, sha: request.sha, installationId: request.installationId });
	const repo = requireRepo(input.repo, input.installationId ?? 0);
	const manager = repo.config.dependencyUpdates?.packageManager;
	if (!manager || !repo.config.maintenance) throw new Error("Dependency updates are not enabled for this repository");
	const result: DependencyReviewResult = {
		repo: input.repo,
		sha: input.sha,
		runId,
		status: "infrastructure_error",
		publishing: "disabled",
		completedAt: new Date().toISOString(),
	};
	const verify = deps.verify ?? runRepositoryVerification;
	const adapter = dependencyAdapter(manager);
	const files = deps.files ?? adapter.files;
	const audit = deps.audit ?? adapter.audit;
	let pristine: DependencySnapshot | undefined;
	let installed: DependencySnapshot | undefined;
	try {
		result.baseline = await verify(input, runId, {
			publish: false,
			beforeInstall: async (s) => {
				await files.install(s);
				pristine = await files.inspect(s, manager);
			},
			afterChecks: async (s) => {
				installed = await files.inspect(s, manager, true);
				result.audit = { baseline: await audit(s, installed.installed) };
				const afterAudit = await files.inspect(s, manager, true);
				if (!isDeepStrictEqual(installed, afterAudit)) throw new Error("Audit changed the baseline");
			},
		});
		assertIdentity(result.baseline, input, runId);
		if (result.baseline.status !== "passed" || result.baseline.cleanup !== "terminated") {
			result.status = result.baseline.status === "failed" ? "baseline_failed" : "infrastructure_error";
			result.reason = "baseline_unhealthy";
			return finish(result);
		}
		if (!pristine || !installed || !isDeepStrictEqual(pristine.files, installed.files)) throw new Error("Baseline changed its dependency files");
		if (result.audit?.baseline.status !== "completed") {
			result.reason = "audit_unavailable";
			return finish(result);
		}
		result.discovery = await (deps.discover ?? adapter.discover)(installed);
		result.discovery.candidates = prioritizeCandidates(result.discovery.candidates, result.audit.baseline);
		const candidate: DependencyCandidate | undefined = request.selectedCandidate
			? result.discovery.candidates.find((c) => isDeepStrictEqual(c, request.selectedCandidate))
			: result.discovery.candidates[0];
		if (request.selectedCandidate && !candidate) {
			result.status = "infrastructure_error";
			result.reason = "lookup_incomplete";
			return finish(result);
		}
		if (!candidate) {
			const incomplete = result.discovery.skipped.some((s) => ["registry_unavailable", "unresolved_version"].includes(s.reason));
			result.status = incomplete ? "infrastructure_error" : "no_eligible_update";
			if (incomplete) result.reason = "lookup_incomplete";
			return finish(result);
		}
		result.candidate = candidate;
		result.generation = { sandboxId: null, cleanup: "unconfirmed", output: "", exitCode: null };
		let client: SandboxClient | undefined;
		const getClient = () => (client ??= new SandboxClient(sandboxClient().api, { prepareTimeoutMs: 300_000, bootTimeoutMs: 60_000 }));
		try {
			await withSandbox(
				() => (deps.open ? deps.open(repo) : openFreshSandbox(repo, getClient())),
				async (s) => {
					if (!result.generation) throw new Error("Missing generation receipt");
					result.generation.sandboxId = s.id;
					if (deps.prepare) await deps.prepare(s, repo, input.sha);
					else await prepareFreshCheckout(getClient(), s.id, repo, input.sha, { publicCheckout: maintenanceMode() !== "app" });
					await files.install(s);
					const before = await files.inspect(s, manager);
					if (!isDeepStrictEqual(before.files, pristine?.files)) throw new Error("Generation checkout does not match baseline");
					await files.update(s, candidate);
					const generated = await files.lock(s, manager);
					result.generation.output = generated.output;
					result.generation.exitCode = generated.exitCode;
					if (generated.exitCode !== 0) throw new Error("Lockfile generation failed");
					const after = await files.inspect(s, manager);
					result.artifact = await buildArtifact(input.sha, manager, candidate, before, after);
				},
				(closed) => {
					if (result.generation) result.generation.cleanup = closed ? "terminated" : "unconfirmed";
				},
			);
		} catch {
			result.status = "generation_failed";
			result.reason = "generation_rejected";
			return finish(result);
		}
		if (result.generation.cleanup !== "terminated" || !result.artifact || result.generation.sandboxId === result.baseline.sandboxId)
			throw new Error("Generation cleanup or artifact unconfirmed");
		const artifact = result.artifact;
		let artifactVerified = false;
		result.verification = await verify(input, runId, {
			publish: false,
			beforeInstall: async (s) => {
				await files.install(s);
				await files.apply(s, artifact);
			},
			afterChecks: async (s) => {
				const beforeAudit = await files.inspect(s, manager, true);
				const candidateAudit = await audit(s, beforeAudit.installed);
				if (!result.audit) throw new Error("Missing baseline audit");
				result.audit.candidate = candidateAudit;
				result.audit.comparison = compareAuditReports(result.audit.baseline, candidateAudit);
				const checked = await files.inspect(s, manager, true);
				if (!isDeepStrictEqual(beforeAudit, checked)) throw new Error("Audit changed the candidate");
				if (
					!isDeepStrictEqual(
						checked.files,
						artifact.files.map((f) => ({ path: f.path, content: f.after })),
					) ||
					checked.installed[candidate.name] !== candidate.toVersion
				)
					throw new Error("Verified content differs from the proposal");
				if (Object.entries(installed?.installed ?? {}).some(([name, version]) => name !== candidate.name && checked.installed[name] !== version)) {
					throw new Error("Unrelated direct dependency changed");
				}
				artifactVerified = true;
			},
		});
		assertIdentity(result.verification, input, runId);
		if (result.verification.sandboxId === result.baseline.sandboxId || result.verification.sandboxId === result.generation.sandboxId)
			throw new Error("Candidate did not use a fresh sandbox");
		if (result.verification.status === "failed") {
			result.status = "candidate_failed";
			result.reason = "candidate_unhealthy";
		} else if (result.verification.status !== "passed" || result.verification.cleanup !== "terminated" || !artifactVerified) {
			result.status = "infrastructure_error";
			result.reason = "artifact_mismatch";
		} else if (
			result.baseline.recipeHash !== result.verification.recipeHash ||
			result.baseline.smokeRunnerHash !== result.verification.smokeRunnerHash ||
			runtime(result.baseline) !== runtime(result.verification)
		) {
			result.status = "infrastructure_error";
			result.reason = "artifact_mismatch";
		} else if (result.audit.comparison?.status === "unavailable" || !result.audit.comparison) {
			result.status = "infrastructure_error";
			result.reason = "audit_unavailable";
		} else if (result.audit.comparison.status === "blocked") {
			result.status = "security_blocked";
			result.reason = "security_regression";
		} else result.status = "ready_for_review";
	} catch (error) {
		result.status = "infrastructure_error";
		if (error instanceof GitHubError) {
			result.lookupHttpStatus = error.status;
			result.reason = "lookup_incomplete";
		} else result.reason ??= "unconfirmed_execution";
	}
	return finish(result);
}
function runtime(result: MaintenanceResult) {
	return result.stages.find((s) => s.name === "runtime")?.output;
}
function assertIdentity(result: MaintenanceResult, input: VerifyRepositoryInput, runId: string) {
	if (result.repo !== input.repo || result.sha !== input.sha || result.runId !== runId) throw new Error("Verification identity mismatch");
}
function finish(result: DependencyReviewResult) {
	return DependencyReviewResult.parse({ ...result, completedAt: new Date().toISOString() });
}
