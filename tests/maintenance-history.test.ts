import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { catalogConfiguration } from "../app/catalog/index.js";
import { type HistorySettings, historySettings, maintenanceEnvelopes, retainMaintenanceRun } from "../app/maintenance-history/index.js";
import { parseMaintenanceBundle } from "../vendor/registry-maintenance/index.js";
import { testConfig as fixtureConfig } from "./fixtures/config.js";

const bundlePath = new URL("./fixtures/maintenance-history/bundle.json", import.meta.url);
const rawBundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const scan = JSON.parse(readFileSync(new URL("./fixtures/maintenance-history/scan.json", import.meta.url), "utf8"));
const settings: HistorySettings = {
	bundle: parseMaintenanceBundle(rawBundle, true),
	endpoint: "https://dx.example/api/maintenance/ingest",
	token: "secret".repeat(8),
	workflowId: "wfl-test",
};

describe("catalog-backed retained evidence", () => {
	it("keeps successful scanning separate from security findings", () => {
		const [envelope] = maintenanceEnvelopes("dependency-scan", scan, settings);
		expect(envelope.observation.result).toMatchObject({
			kind: "dependency-scan",
			completion: "completed",
			security: { findings: { high: 1 } },
			verification: "not-run",
		});
		expect(envelope.evidence.result).toEqual(scan);
	});
	it("separates passing baseline evidence from a failing exact candidate", () => {
		const binding = settings.bundle.targets[0].checks.find((c) => c.operation === "application-verification");
		if (!binding) throw new Error("Fixture is missing application verification");
		const check = {
			repo: scan.repo,
			sha: scan.sha,
			runId: "trn-review1",
			recipeHash: binding.recipeHash,
			smokeRunnerHash: binding.toolHash,
			sandboxId: "sbx-test",
			cleanup: "terminated",
			stages: [],
			reporting: "skipped",
		};
		const review = {
			repo: scan.repo,
			sha: scan.sha,
			runId: check.runId,
			status: "candidate_failed",
			publishing: "disabled",
			completedAt: scan.completedAt,
			baseline: { ...check, status: "passed" },
			verification: { ...check, status: "failed" },
			artifact: { id: "f".repeat(64), baseSha: scan.sha, files: [{ path: "package.json", before: "{}", after: "{}" }], patch: "test patch" },
		};
		const envelopes = maintenanceEnvelopes("dependency-review", review, settings);
		expect(envelopes.map((e) => e.observation.subject.kind)).toEqual(["branch-baseline", "branch-candidate"]);
		expect(envelopes[1].observation.subject).toMatchObject({ artifactDigest: `sha256:${"f".repeat(64)}` });
		expect(envelopes.map((e) => e.observation.result)).toEqual([
			{ kind: "application-verification", status: "passed" },
			{ kind: "application-verification", status: "failed" },
		]);
		expect(envelopes[0].observation.observationId).not.toBe(envelopes[1].observation.observationId);
	});

	it("rejects stale recipe and tool evidence instead of attributing it to the current profile", () => {
		expect(() => maintenanceEnvelopes("dependency-scan", { ...scan, toolHash: "0".repeat(64) }, settings)).toThrow();
		expect(() => maintenanceEnvelopes("dependency-scan", { ...scan, repo: "unapproved/repo" }, settings)).toThrow();
	});
	it("requires complete destination configuration and a pinned execution catalog", () => {
		expect(historySettings({})).toBeUndefined();
		expect(() => historySettings({ MAINTENANCE_HISTORY_TOKEN: settings.token })).toThrow(/incomplete/);
		expect(() => parseMaintenanceBundle({ ...rawBundle, mode: "preview" }, true)).toThrow();
		expect(() => catalogConfiguration(fixtureConfig, { MAINTENANCE_CATALOG_PATH: bundlePath.pathname, MAINTENANCE_CATALOG_DIGEST: "wrong" })).toThrow(
			/approved/,
		);
		const configured = catalogConfiguration(fixtureConfig, {
			MAINTENANCE_CATALOG_PATH: bundlePath.pathname,
			MAINTENANCE_CATALOG_DIGEST: rawBundle.contentHash,
		});
		expect(Object.keys(configured.repos)).toEqual(["test/maintenance"]);
		expect(configured.repos["test/maintenance"].dependencyUpdates?.publishDrafts).toBe(false);
	});
	it("loads only completed evidence from the configured Workflow and rejects redirects", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		fetch.mockResolvedValueOnce(
			Response.json({ id: scan.runId, taskId: "tsk-test", status: "completed", input: [{ repo: scan.repo, sha: scan.sha }], results: [scan] }),
		);
		fetch.mockResolvedValueOnce(Response.json({ id: "tsk-test", name: "dependency-scan", workflowId: "wfl-other" }));
		await expect(retainMaintenanceRun(scan.runId, settings, { fetch, renderToken: "render-secret" })).rejects.toThrow(
			/configured maintenance Workflow/,
		);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
	});
	it("retains complete evidence and checks the receiver's identity receipt", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		fetch.mockResolvedValueOnce(
			Response.json({ id: scan.runId, taskId: "tsk-test", status: "completed", input: [{ repo: scan.repo, sha: scan.sha }], results: [scan] }),
		);
		fetch.mockResolvedValueOnce(Response.json({ id: "tsk-test", name: "dependency-scan", workflowId: settings.workflowId }));
		fetch.mockResolvedValueOnce(
			Response.json({
				schemaVersion: 1,
				producer: "examples-maintainer",
				runId: scan.runId,
				observationId: `${scan.runId}:scan`,
				disposition: "stored",
				digest: `sha256:${"0".repeat(64)}`,
			}),
		);
		await expect(retainMaintenanceRun(scan.runId, settings, { fetch, renderToken: "render-secret" })).resolves.toHaveLength(1);
		const [url, request] = fetch.mock.calls[2];
		expect(url).toBe(settings.endpoint);
		const body = JSON.parse(request?.body as string);
		expect(body.evidence.result).toEqual(scan);
		expect(request?.headers).toMatchObject({ Authorization: `Bearer ${settings.token}` });
		expect(JSON.stringify(body)).not.toContain("render-secret");
	});
});
