import { dependencyAuditSummary } from "./audit-summary.js";
import { codeSpan } from "../../format/index.js";
import type { DependencyReviewResult } from "../../schemas/dependencies.js";
import type { MaintenanceRecipe, MaintenanceResult } from "../../schemas/maintenance.js";

/** Render only validated evidence and operator-owned commands, never sandbox log output. */
export function dependencyProposalBody(review: DependencyReviewResult, recipe: MaintenanceRecipe, workflowId: string): string {
	const { candidate, artifact, baseline, verification, generation } = review;
	if (!candidate || !artifact || !baseline || !verification || !generation || !review.audit?.comparison)
		throw new Error("Proposal requires complete verified evidence");
	if (!/^wfl-[a-z0-9]+$/.test(workflowId) || !/^trn-[a-z0-9]+$/.test(review.runId)) throw new Error("Invalid execution identity");
	const cell = (value: string) => codeSpan(value).replaceAll("|", "\\|");
	const result = (run: MaintenanceResult, name: string) => {
		const stage = run.stages.find((s) => s.name === name);
		if (!stage) return "⏭️ Not run";
		return `${stage.status === "passed" ? "✅ Passed" : stage.status === "failed" ? "❌ Failed" : "⚠️ Unknown"} (exit ${stage.exitCode ?? "unknown"}, ${(stage.durationMs / 1000).toFixed(2)}s)`;
	};
	const commands = [recipe.install, ...recipe.checks, { name: "smoke", command: recipe.smoke.start }];
	const audit = review.audit.comparison;
	const runUrl = `https://dashboard.render.com/wf/${workflowId}/runs/${review.runId}`;
	return [
		`<!-- examples-maintainer:dependency:${artifact.id} -->`,
		"",
		`Updates ${codeSpan(candidate.name)} from ${codeSpan(candidate.fromVersion)} to ${codeSpan(candidate.toVersion)}.`,
		"",
		"## Verified in Render Sandboxes",
		"",
		"The unchanged baseline and the exact proposed files passed the following checks in separate fresh Render Sandboxes.",
		"",
		"| Check | Command | Baseline | Proposed patch |",
		"| --- | --- | --- | --- |",
		...commands.map((step) =>
			`| ${step.name === "smoke" ? "Startup + HTTP smoke" : cell(step.name)} | ${cell(step.command)} | ${result(baseline, step.name)} | ${result(verification, step.name)} |`,
		),
		"",
		`HTTP assertion: ${codeSpan(`GET http://127.0.0.1:${recipe.smoke.port}${recipe.smoke.path}`)} returned ${recipe.smoke.expectedStatus} and contained ${codeSpan(recipe.smoke.bodyIncludes)} on both runs.`,
		...(!recipe.checks.some((step) => step.name === "build")
			? ["", "**Build coverage:** No separate build step is configured for this recipe. The results above establish installation, configured checks, and startup/HTTP behavior; they are not a production-build certification."]
			: []),
		...(commands.some((step) => step.command.includes("DATABASE_URL=sqlite:"))
			? ["", "**Database coverage:** This recipe uses SQLite. PostgreSQL integration was not tested."]
			: []),
		"",
		`[View execution evidence in Render](${runUrl}) — requires access to the Render workspace.`,
		"",
		`- Review run: ${codeSpan(review.runId)}; completed ${codeSpan(review.completedAt)}.`,
		`- Tested base: ${codeSpan(review.sha)}.`,
		`- Tested patch artifact: ${codeSpan(artifact.id)}.`,
		`- Baseline sandbox: ${codeSpan(baseline.sandboxId ?? "unknown")}; cleanup: ${codeSpan(baseline.cleanup)}.`,
		`- Patch-generation sandbox: ${codeSpan(generation.sandboxId ?? "unknown")}; cleanup: ${codeSpan(generation.cleanup)}.`,
		`- Patched sandbox: ${codeSpan(verification.sandboxId ?? "unknown")}; cleanup: ${codeSpan(verification.cleanup)}.`,
		"",
		"## Dependency audit",
		"",
		...dependencyAuditSummary(audit),
		"",
		"This is a draft for human review. The checks cover the configured recipe, not every application behavior. The base may advance after publication; revalidate before merging.",
	].join("\n");
}
