import { readFileSync } from "node:fs";
import { z } from "zod";
import {
	checkDigest,
	type MaintenanceBundle,
	type MaintenanceObservation,
	parseMaintenanceBundle,
	validateMaintenanceObservation,
} from "../../vendor/registry-maintenance/index.js";
import { DependencyReviewResult, DependencyScanResult } from "../schemas/index.js";

const RunId = z
	.string()
	.regex(/^trn-[a-z0-9]+$/)
	.max(200);
const WorkflowId = z
	.string()
	.regex(/^wfl-[a-z0-9]+$/)
	.max(200);
const Receipt = z.strictObject({
	schemaVersion: z.literal(1),
	producer: z.literal("examples-maintainer"),
	runId: RunId,
	observationId: z.string().max(200),
	disposition: z.enum(["stored", "reused"]),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export interface HistorySettings {
	bundle: MaintenanceBundle;
	endpoint: string;
	token: string;
	workflowId: string;
}

/** Controller-only configuration. Never included in a task input or Sandbox environment. */
export function historySettings(env: NodeJS.ProcessEnv = process.env): HistorySettings | undefined {
	const keys = [
		"MAINTENANCE_CATALOG_PATH",
		"MAINTENANCE_CATALOG_DIGEST",
		"MAINTENANCE_HISTORY_URL",
		"MAINTENANCE_HISTORY_TOKEN",
		"MAINTENANCE_WORKFLOW_ID",
	];
	if (keys.every((key) => !env[key])) return undefined;
	if (keys.some((key) => !env[key])) throw new Error("Maintenance history configuration is incomplete");
	const bundle = parseMaintenanceBundle(JSON.parse(readFileSync(env.MAINTENANCE_CATALOG_PATH as string, "utf8")), true);
	if (bundle.contentHash !== env.MAINTENANCE_CATALOG_DIGEST) throw new Error("Maintenance catalog digest does not match approval");
	const endpoint = new URL(env.MAINTENANCE_HISTORY_URL as string);
	if (
		endpoint.protocol !== "https:" ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		endpoint.pathname !== "/api/maintenance/ingest"
	)
		throw new Error("Expected an HTTPS maintenance ingestion endpoint without credentials or query");
	if ((env.MAINTENANCE_HISTORY_TOKEN as string).length < 32) throw new Error("Maintenance history credential is too short");
	return {
		bundle,
		endpoint: endpoint.href,
		token: env.MAINTENANCE_HISTORY_TOKEN as string,
		workflowId: WorkflowId.parse(env.MAINTENANCE_WORKFLOW_ID),
	};
}

export function maintenanceEnvelopes(task: "dependency-scan" | "dependency-review", raw: unknown, settings: HistorySettings) {
	const result = task === "dependency-scan" ? DependencyScanResult.parse(raw) : DependencyReviewResult.parse(raw);
	const target = settings.bundle.targets.find((t) => t.source.repository === `https://github.com/${result.repo}`);
	if (!target) throw new Error("Run repository is absent from the approved catalog");
	const evidenceUrl = `https://dashboard.render.com/wf/${settings.workflowId}/runs/${RunId.parse(result.runId)}`;
	const observations: MaintenanceObservation[] = [];
	const common = {
		schemaVersion: 2 as const,
		producer: "examples-maintainer",
		runId: result.runId,
		entry: target.entry,
		catalog: { ...settings.bundle.catalog, contractDigest: settings.bundle.contentHash },
		targetDigest: target.targetDigest,
		completedAt: result.completedAt,
		evidenceUrl,
	};
	// workingTree belongs to the bundle receipt, not the observation contract.
	const catalog = { revision: common.catalog.revision, inputDigest: common.catalog.inputDigest, contractDigest: common.catalog.contractDigest };
	if (task === "dependency-scan") {
		const scan = DependencyScanResult.parse(result);
		const binding = target.checks.find((c) => c.operation === "dependency-scan");
		if (!binding) throw new Error("Catalog has no scan profile");
		const findings = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, unknown: 0 };
		for (const finding of scan.audit?.findings ?? []) findings[finding.severity]++;
		observations.push(
			validateMaintenanceObservation(
				{
					...common,
					catalog,
					observationId: `${result.runId}:scan`,
					profile: binding.profile.id,
					profileDigest: checkDigest(binding.profile),
					subject: { kind: "branch-baseline", sourceRevision: scan.sha },
					recipeHash: scan.recipeHash,
					toolHash: scan.toolHash,
					cleanup: scan.cleanup,
					...(scan.inventoryHash ? { inventoryHash: scan.inventoryHash } : {}),
					result: {
						kind: "dependency-scan",
						completion: scan.status,
						candidates: scan.rankedCandidates.length,
						verification: "not-run",
						security:
							scan.audit?.status === "completed"
								? { status: "completed", findings, scannedAt: scan.audit.scannedAt, exploitation: "not-assessed", reachability: "not-assessed" }
								: { status: "unavailable", reason: scan.audit?.reason ?? "audit_unavailable" },
					},
				},
				settings.bundle,
			),
		);
	} else {
		const review = DependencyReviewResult.parse(result);
		const binding = target.checks.find((c) => c.operation === "application-verification");
		if (!binding) throw new Error("Catalog has no verification profile");
		for (const [phase, check] of [
			["baseline", review.baseline],
			["candidate", review.verification],
		] as const) {
			if (!check) continue;
			if (check.repo !== review.repo || check.sha !== review.sha || check.runId !== review.runId)
				throw new Error("Verification evidence identity mismatch");
			if (phase === "candidate" && !review.artifact) throw new Error("Candidate check lacks an exact patch identity");
			observations.push(
				validateMaintenanceObservation(
					{
						...common,
						catalog,
						observationId: `${result.runId}:${phase}`,
						profile: binding.profile.id,
						profileDigest: checkDigest(binding.profile),
						subject:
							phase === "baseline"
								? { kind: "branch-baseline", sourceRevision: review.sha }
								: { kind: "branch-candidate", sourceRevision: review.sha, artifactDigest: `sha256:${review.artifact?.id}` },
						recipeHash: check.recipeHash,
						toolHash: check.smokeRunnerHash,
						cleanup: check.cleanup,
						result: { kind: "application-verification", status: check.status },
					},
					settings.bundle,
				),
			);
		}
	}
	if (!observations.length) throw new Error("Run contains no attributable check evidence; inspect it manually");
	return observations.map((observation) => ({ schemaVersion: 1 as const, workflowId: settings.workflowId, observation, evidence: { task, result } }));
}

export async function retainMaintenanceRun(runId: string, settings: HistorySettings, opts: { fetch?: typeof fetch; renderToken?: string } = {}) {
	RunId.parse(runId);
	const request = opts.fetch ?? fetch;
	async function read(path: string) {
		const response = await request(`https://api.render.com/v1${path}`, {
			headers: { Authorization: `Bearer ${opts.renderToken ?? process.env.RENDER_API_KEY ?? ""}` },
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok || !response.body) throw new Error("Maintenance evidence lookup failed");
		let size = 0;
		const chunks: Uint8Array[] = [];
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > 1_500_000) throw new Error("Maintenance evidence exceeds retention limit");
			chunks.push(chunk);
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	}
	const run = z
		.object({
			id: RunId,
			taskId: z.string().regex(/^tsk-[a-z0-9]+$/),
			status: z.literal("completed"),
			input: z.tuple([z.object({ repo: z.string(), sha: z.string() })]),
			results: z.tuple([z.unknown()]),
		})
		.parse(await read(`/task-runs/${runId}`));
	const task = z
		.object({ id: z.string(), name: z.enum(["dependency-scan", "dependency-review"]), workflowId: WorkflowId })
		.parse(await read(`/tasks/${run.taskId}`));
	if (run.id !== runId || task.id !== run.taskId || task.workflowId !== settings.workflowId)
		throw new Error("Evidence is not from the configured maintenance Workflow");
	const envelopes = maintenanceEnvelopes(task.name, run.results[0], settings);
	const receipts = [];
	for (const envelope of envelopes) {
		if (
			envelope.observation.runId !== runId ||
			envelope.evidence.result.repo !== run.input[0].repo ||
			envelope.evidence.result.sha !== run.input[0].sha
		)
			throw new Error("Workflow evidence does not match its input");
		const body = JSON.stringify(envelope);
		if (Buffer.byteLength(body) > 1_500_000) throw new Error("Maintenance evidence exceeds retention limit");
		const response = await request(settings.endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
			body,
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`Maintenance evidence retention failed (HTTP ${response.status}); replay this run ID`);
		if (!response.body) throw new Error("Missing maintenance retention receipt");
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > 2000) throw new Error("Invalid maintenance retention receipt");
			chunks.push(chunk);
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
		const receipt = Receipt.parse(JSON.parse(text));
		if (receipt.runId !== runId || receipt.observationId !== envelope.observation.observationId)
			throw new Error("Maintenance retention receipt identity mismatch");
		receipts.push(receipt);
	}
	return receipts;
}

/** Finish retaining other repositories even if one delivery fails; retry by immutable run ID. */
export async function retainMaintenanceRuns(runIds: string[], settings: HistorySettings) {
	const receipts = [];
	const failed: string[] = [];
	for (const runId of runIds) {
		try {
			receipts.push(...(await retainMaintenanceRun(runId, settings)));
		} catch {
			failed.push(runId);
		}
	}
	if (failed.length) throw new Error(`Maintenance retention incomplete; replay --run for: ${failed.join(", ")}`);
	return receipts;
}
