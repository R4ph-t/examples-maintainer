import { isDeepStrictEqual } from "node:util";
import { requireRepo, type RepoContext } from "../../config/index.js";
import { maintenanceMode } from "../../github/index.js";
import { openFreshSandbox, prepareFreshCheckout, type Sandbox, SandboxClient, sandboxClient, withSandbox } from "../../sandbox/index.js";
import {
	DependencyReviewResult,
	type DependencySnapshot,
	type DependencyCandidate,
	type DependencyDiscovery,
	type MaintenanceResult,
	VerifyRepositoryInput,
} from "../../schemas/index.js";
import { type MaintenanceDeps, runRepositoryVerification } from "../maintenance/verify.js";
import { buildArtifact } from "./artifact.js";
import { discoverUpdates } from "./discovery.js";
import { applyArtifact, inspectFiles, installFileHelper, regenerateLock, writeCandidateManifest } from "./files.js";

export interface DependencyReviewDeps {
	verify?: (input: unknown, runId: string, deps: MaintenanceDeps) => Promise<MaintenanceResult>;
	open?: (repo: RepoContext) => Promise<Sandbox>;
	prepare?: (sandbox: Sandbox, repo: RepoContext, sha: string) => Promise<void>;
	discover?: (snapshot: DependencySnapshot) => Promise<DependencyDiscovery>;
	files?: {
		install: typeof installFileHelper;
		inspect: typeof inspectFiles;
		apply: typeof applyArtifact;
		update: typeof writeCandidateManifest;
		lock: typeof regenerateLock;
	};
}

/** One bounded candidate, with independent baseline, generation, and clean verification sandboxes. No publication. */
export async function runDependencyReview(raw: unknown, runId: string, deps: DependencyReviewDeps = {}): Promise<DependencyReviewResult> {
	const input = VerifyRepositoryInput.parse(raw);
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
	const files = deps.files ?? {
		install: installFileHelper,
		inspect: inspectFiles,
		apply: applyArtifact,
		update: writeCandidateManifest,
		lock: regenerateLock,
	};
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
			},
		});
		assertIdentity(result.baseline, input, runId);
		if (result.baseline.status !== "passed" || result.baseline.cleanup !== "terminated") {
			result.status = result.baseline.status === "failed" ? "baseline_failed" : "infrastructure_error";
			result.reason = "baseline_unhealthy";
			return finish(result);
		}
		if (!pristine || !installed || !isDeepStrictEqual(pristine.files, installed.files)) throw new Error("Baseline changed its dependency files");
		result.discovery = await (deps.discover ?? discoverUpdates)(installed);
		const candidate: DependencyCandidate | undefined = result.discovery.candidates[0];
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
				const checked = await files.inspect(s, manager, true);
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
		} else result.status = "ready_for_review";
	} catch {
		result.status = "infrastructure_error";
		result.reason ??= "unconfirmed_execution";
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
