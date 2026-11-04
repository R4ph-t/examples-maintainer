import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type RepoContext, requireRepo } from "../../config/index.js";
import { assertPublicMaintenanceRepo, maintenanceMode } from "../../github/index.js";
import { prepareFreshCheckout, type Sandbox, SandboxClient, sandboxClient, shq } from "../../sandbox/index.js";
import {
	type AuditReport,
	type DependencyDiscovery,
	DependencyScanResult,
	type DependencySnapshot,
	ScanSnapshotReceipt,
	VerifyRepositoryInput,
} from "../../schemas/index.js";
import { type DependencyFileOps, dependencyAdapter } from "./adapters.js";
import { withPreparedScanSandbox } from "./scan-cache.js";
import { scanRecipeHash, scanToolHash } from "./scan-identity.js";
import { auditPriority, rankScanCandidates } from "./scan-priority.js";

export interface DependencyScanDeps {
	withPrepared?: typeof withPreparedScanSandbox;
	prepare?: (sandbox: Sandbox, repo: RepoContext, sha: string) => Promise<void>;
	files?: DependencyFileOps;
	audit?: (sandbox: Sandbox, installed: Record<string, string>) => Promise<AuditReport>;
	discover?: (snapshot: DependencySnapshot) => Promise<DependencyDiscovery>;
	toolHash?: () => Promise<string>;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Refreshes advisory and version evidence only. A scan never claims the application builds or runs. */
export async function runDependencyScan(raw: unknown, runId: string, deps: DependencyScanDeps = {}): Promise<DependencyScanResult> {
	const input = VerifyRepositoryInput.parse(raw);
	const repo = requireRepo(input.repo, input.installationId ?? 0);
	const manager = repo.config.dependencyUpdates?.packageManager;
	const recipe = repo.config.maintenance;
	if (!manager || !recipe) throw new Error("Dependency scanning requires a configured package manager and install recipe");
	const mode = maintenanceMode();
	if (mode === "app" && !input.installationId) throw new Error("App scan requires an installationId");
	if (mode === "pat") await assertPublicMaintenanceRepo(repo.fullName);
	const adapter = dependencyAdapter(manager);
	const files = deps.files ?? adapter.files;
	const toolHash = await (deps.toolHash ?? scanToolHash)();
	const result: DependencyScanResult = {
		repo: input.repo,
		sha: input.sha,
		runId,
		status: "infrastructure_error",
		completedAt: new Date().toISOString(),
		recipeHash: scanRecipeHash(repo),
		toolHash,
		sandboxId: null,
		cleanup: "not_created",
		rankedCandidates: [],
		priority: "needs_triage",
		unratedFindings: 0,
		priorityBasis: "reported_severity_and_fix_metadata",
		exploitation: "not_assessed",
		reachability: "not_assessed",
		verification: "not_run",
		publishing: "disabled",
	};
	const key = digest({ repo: input.repo, sha: input.sha, recipeHash: result.recipeHash, toolHash });
	let client: SandboxClient | undefined;
	const getClient = () => (client ??= new SandboxClient(sandboxClient().api, { prepareTimeoutMs: 300_000, bootTimeoutMs: 60_000 }));
	let preparedInventory: DependencySnapshot | undefined;
	async function inspect(s: Sandbox): Promise<string> {
		const runtime = await s.exec(recipe?.runtime === "python" ? "python3 --version" : "node --version && npm --version", {
			asRunner: true,
			timeoutMs: 10_000,
		});
		if (runtime.exitCode !== 0) throw new Error("Runtime could not be identified");
		result.runtime = [runtime.stdout, runtime.stderr].join("\n").trim().slice(0, 1000);
		preparedInventory = await files.inspect(s, manager as "npm" | "yarn1" | "pip", true);
		result.inventoryHash = digest(preparedInventory);
		return digest({ runtime: result.runtime, inventory: preparedInventory });
	}
	try {
		await (deps.withPrepared ?? withPreparedScanSandbox)(
			repo,
			{
				key,
				sha: input.sha,
				publicCheckout: mode !== "app",
				prepare: async (s) => {
					if (deps.prepare) await deps.prepare(s, repo, input.sha);
					else await prepareFreshCheckout(getClient(), s.id, repo, input.sha, { publicCheckout: mode !== "app" });
					await files.install(s);
					const before = await files.inspect(s, manager);
					// Audit-only installation disables repository lifecycle scripts for Node; Python accepts wheels only.
					const command =
						recipe.install.command + (manager === "npm" ? " --ignore-scripts --no-audit --no-fund" : manager === "yarn1" ? " --ignore-scripts" : "");
					const installed = await s.exec(`timeout -k 2 ${recipe.install.timeoutSeconds}s bash -c ${shq(command)}`, {
						asRunner: true,
						timeoutMs: (recipe.install.timeoutSeconds + 10) * 1000,
					});
					if (installed.exitCode !== 0) {
						result.reason = "install_failed";
						throw new Error("Dependency inventory installation failed");
					}
					const after = await files.inspect(s, manager);
					if (!isDeepStrictEqual(before.files, after.files)) throw new Error("Scan installation changed dependency declarations");
				},
				inspect,
				onSandbox: (id) => {
					result.sandboxId = id;
					result.cleanup = "unconfirmed";
				},
				onCache: (receipt) => {
					result.snapshot = ScanSnapshotReceipt.parse(receipt);
				},
				onCleanup: (closed) => {
					result.cleanup = closed ? "terminated" : "unconfirmed";
				},
			},
			async (sandbox) => {
				// Inspect after every restore, and always run a new advisory scan even when source is unchanged.
				await inspect(sandbox);
				if (!preparedInventory) throw new Error("Prepared inventory missing");
				const inventory = preparedInventory;
				result.audit = await (deps.audit ?? adapter.audit)(sandbox, inventory.installed);
				if (!isDeepStrictEqual(inventory, await files.inspect(sandbox, manager, true))) throw new Error("Audit changed dependency inventory");
				if (result.audit.status !== "completed") {
					result.reason = "audit_unavailable";
					result.status = "incomplete";
					return;
				}
				result.discovery = await (deps.discover ?? adapter.discover)(inventory);
				result.rankedCandidates = rankScanCandidates(result.discovery.candidates, result.audit);
				result.priority = auditPriority(result.audit);
				result.unratedFindings = result.audit.findings.filter((f) => f.severity === "unknown").length;
				result.status = result.discovery.skipped.length ? "incomplete" : "completed";
				if (result.discovery.skipped.length) result.reason = "discovery_incomplete";
			},
		);
	} catch {
		result.status = "infrastructure_error";
		result.reason ??= "unconfirmed_execution";
	}
	if (result.cleanup !== "terminated") {
		result.status = "infrastructure_error";
		result.reason = "unconfirmed_execution";
	}
	return DependencyScanResult.parse({ ...result, completedAt: new Date().toISOString() });
}
