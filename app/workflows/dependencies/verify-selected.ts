import { isDeepStrictEqual } from "node:util";
import { requireRepo } from "../../config/index.js";
import { maintenanceRevision } from "../../github/index.js";
import {
	type DependencyReviewInput,
	DependencyReviewResult,
	DependencyScanResult,
	SelectedDependencyInput,
	SelectedDependencyResult,
	VerifyRepositoryInput,
} from "../../schemas/index.js";
import { scanRecipeHash, scanToolHash } from "./scan-identity.js";

export interface SelectedDependencyDeps {
	loadScan: (runId: string) => Promise<{ scan: unknown; input: unknown }>;
	runReview: (input: DependencyReviewInput) => Promise<unknown>;
	resolveRevision?: typeof maintenanceRevision;
	toolHash?: () => Promise<string>;
	now?: () => number;
}

/** Selection authorizes work, never publication; the full review still performs independent clean installs. */
export async function verifySelectedDependency(raw: unknown, deps: SelectedDependencyDeps): Promise<SelectedDependencyResult> {
	const input = SelectedDependencyInput.parse(raw);
	const result: SelectedDependencyResult = { ...input, status: "rejected" };
	let scan: DependencyScanResult;
	let source: VerifyRepositoryInput;
	try {
		const retained = await deps.loadScan(input.scanRunId);
		scan = DependencyScanResult.parse(retained.scan);
		source = VerifyRepositoryInput.parse(retained.input);
		if (
			scan.repo !== input.repo ||
			source.repo !== input.repo ||
			source.sha !== scan.sha ||
			scan.runId !== input.scanRunId ||
			scan.status !== "completed"
		)
			throw new Error("Unusable scan");
	} catch {
		return SelectedDependencyResult.parse({ ...result, reason: "scan_unavailable" });
	}
	const now = (deps.now ?? Date.now)();
	const fresh = (date: string) => Date.parse(date) <= now + 60_000 && now - Date.parse(date) <= 6 * 3600_000;
	if (!fresh(scan.completedAt) || !scan.audit || !fresh(scan.audit.scannedAt)) return { ...result, status: "stale", reason: "scan_stale" };
	const repo = requireRepo(input.repo, source.installationId ?? 0);
	if (scan.recipeHash !== scanRecipeHash(repo) || scan.toolHash !== (await (deps.toolHash ?? scanToolHash)()))
		return { ...result, status: "stale", reason: "configuration_changed" };
	const candidate = scan.discovery?.candidates.find((c) => c.name === input.candidateName);
	if (!candidate || scan.discovery?.candidates.filter((c) => c.name === input.candidateName).length !== 1)
		return { ...result, reason: "candidate_unavailable" };
	if ((await (deps.resolveRevision ?? maintenanceRevision)(repo.fullName, repo.config.baseBranch)).sha !== scan.sha)
		return { ...result, status: "stale", reason: "source_changed" };
	try {
		const review = DependencyReviewResult.parse(await deps.runReview({ ...source, selectedCandidate: candidate }));
		if (review.repo !== input.repo || review.sha !== scan.sha || (review.candidate && !isDeepStrictEqual(review.candidate, candidate)))
			throw new Error("Review target mismatch");
		return SelectedDependencyResult.parse({
			...result,
			reviewRunId: review.runId,
			reviewStatus: review.status,
			status: review.status === "ready_for_review" && review.candidate ? "verified" : "rejected",
			reason: review.status === "ready_for_review" && review.candidate ? undefined : "verification_failed",
		});
	} catch {
		return { ...result, reason: "verification_failed" };
	}
}
