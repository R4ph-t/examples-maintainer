import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { requireRepo, type RepoContext } from "../../config/index.js";
import { assertPublicMaintenanceRepo, type GitHubClient, maintenanceMode, maintenanceReporter } from "../../github/index.js";
import {
	APP_DIR,
	openFreshSandbox,
	prepareFreshCheckout,
	type Sandbox,
	SandboxClient,
	sandboxClient,
	shq,
	withSandbox,
} from "../../sandbox/index.js";
import { MaintenanceRecipe, MaintenanceResult, type MaintenanceStage, VerifyRepositoryInput } from "../../schemas/index.js";

export interface MaintenanceDeps {
	open?: (repo: RepoContext) => Promise<Sandbox>;
	prepare?: (sandbox: Sandbox, repo: RepoContext, sha: string) => Promise<void>;
	github?: (repo: RepoContext) => Pick<GitHubClient, "createMaintenanceCheck">;
}

/** Plain maintenance work: only an operator with Workflow access may invoke this, using deployed recipes. */
export async function runRepositoryVerification(raw: unknown, runId: string, deps: MaintenanceDeps = {}): Promise<MaintenanceResult> {
	const input = VerifyRepositoryInput.parse(raw);
	const mode = maintenanceMode();
	const publicCheckout = mode !== "app";
	if (!publicCheckout && !input.installationId)
		throw new Error("App maintenance requires an installationId; alternatively configure MAINTENANCE_GITHUB_TOKEN");
	const repo = requireRepo(input.repo, input.installationId ?? 0);
	const recipe = MaintenanceRecipe.parse(repo.config.maintenance);
	if (publicCheckout) await assertPublicMaintenanceRepo(repo.fullName);
	const script = await readFile(fileURLToPath(new URL("../../../sandbox/maintenance-smoke.mjs", import.meta.url)));
	const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
	const result: MaintenanceResult = {
		repo: repo.fullName,
		sha: input.sha,
		runId,
		recipeHash: digest(JSON.stringify(recipe)),
		smokeRunnerHash: digest(script),
		status: "infrastructure_error",
		sandboxId: null,
		cleanup: "not_created",
		stages: [],
		reporting: "pending",
	};
	// A separate client bounds bootstrap calls; no model credentials or dependency snapshots enter this path.
	let client: SandboxClient | undefined;
	const getClient = () => (client ??= new SandboxClient(sandboxClient().api, { prepareTimeoutMs: 300_000, bootTimeoutMs: 60_000 }));
	try {
		await withSandbox(
			() => {
				// A lost create response can still leave a sandbox running until its provider timeout.
				result.cleanup = "unconfirmed";
				return deps.open ? deps.open(repo) : openFreshSandbox(repo, getClient());
			},
			async (sandbox) => {
				result.sandboxId = sandbox.id;
				result.cleanup = "unconfirmed";
				const started = Date.now();
				try {
					if (deps.prepare) await deps.prepare(sandbox, repo, input.sha);
					else await prepareFreshCheckout(getClient(), sandbox.id, repo, input.sha, { publicCheckout });
					// This file is root-owned outside the checkout. Repository commands cannot replace the verifier.
					await sandbox.upload(`${APP_DIR}/maintenance-smoke.mjs.gz`, gzipSync(script));
					await sandbox
						.exec(`gzip -df ${APP_DIR}/maintenance-smoke.mjs.gz && chmod 644 ${APP_DIR}/maintenance-smoke.mjs`, { timeoutMs: 10_000 })
						.then((r) => {
							if (r.exitCode !== 0) throw new Error("could not prepare smoke runner");
						});
					result.stages.push({ name: "prepare", status: "passed", exitCode: 0, durationMs: Date.now() - started, output: "" });
				} catch {
					result.stages.push({
						name: "prepare",
						status: "unknown",
						exitCode: null,
						durationMs: Date.now() - started,
						output: "Checkout or sandbox preparation did not complete.",
					});
					return;
				}
				const steps = [
					{ name: "runtime", command: "node --version && npm --version", timeoutSeconds: 10 },
					recipe.install,
					...recipe.checks,
					{
						name: "smoke",
						command: `node ${APP_DIR}/maintenance-smoke.mjs ${shq(JSON.stringify(recipe.smoke))}`,
						timeoutSeconds: recipe.smoke.timeoutSeconds + 5,
					},
				];
				for (const step of steps) {
					const stage = await runStage(sandbox, step);
					result.stages.push(stage);
					if (stage.status !== "passed") {
						result.status = stage.status === "failed" ? "failed" : "infrastructure_error";
						return;
					}
				}
				result.status = "passed";
			},
			(closed) => {
				result.cleanup = closed ? "terminated" : "unconfirmed";
			},
		);
	} catch {
		result.status = "infrastructure_error";
	}
	if (result.cleanup !== "terminated") result.status = "infrastructure_error";
	if (mode === "public") {
		result.reporting = "skipped";
		return MaintenanceResult.parse(result);
	}

	// Only controller-owned metadata leaves for GitHub; repository stdout cannot inject mentions or leak credentials.
	try {
		const gh = (deps.github ?? maintenanceReporter)(repo);
		const check = await gh.createMaintenanceCheck({
			headSha: input.sha,
			externalId: `examples-maintainer:${runId}`,
			conclusion: result.status === "passed" ? "success" : result.status === "failed" ? "failure" : "action_required",
			summary: checkSummary(result),
		});
		result.reporting = "published";
		result.checkUrl = check.htmlUrl;
	} catch {
		result.reporting = "failed";
	}
	return MaintenanceResult.parse(result);
}

async function runStage(sandbox: Sandbox, step: { name: string; command: string; timeoutSeconds: number }): Promise<MaintenanceStage> {
	const started = Date.now();
	try {
		// Client cancellation alone does not stop guest processes. A guest timeout also bounds the command.
		const res = await sandbox.exec(`timeout -k 2 ${step.timeoutSeconds}s bash -c ${shq(step.command)}`, {
			asRunner: true,
			timeoutMs: (step.timeoutSeconds + 10) * 1000,
		});
		return {
			name: step.name,
			status: res.exitCode === 0 ? "passed" : "failed",
			exitCode: res.exitCode,
			durationMs: Date.now() - started,
			output: [res.stdout, res.stderr].join("\n").slice(-4096),
		};
	} catch {
		return {
			name: step.name,
			status: "unknown",
			exitCode: null,
			durationMs: Date.now() - started,
			output: "No confirmed command exit was received.",
		};
	}
}

function checkSummary(result: MaintenanceResult): string {
	return [
		`Commit: ${result.sha}`,
		`Recipe: ${result.recipeHash}`,
		`Smoke runner: ${result.smokeRunnerHash}`,
		`Run: ${result.runId}`,
		`Sandbox: ${result.sandboxId ?? "ID unavailable"}`,
		`Cleanup: ${result.cleanup}`,
		"",
		...result.stages.map((stage) => `- ${stage.name}: ${stage.status} (exit ${stage.exitCode ?? "unknown"}, ${stage.durationMs} ms)`),
		"",
		"Fresh sandbox installation. See the Render Workflow result for bounded command output. This does not verify a Render deployment.",
	].join("\n");
}
