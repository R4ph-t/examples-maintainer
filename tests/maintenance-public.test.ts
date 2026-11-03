import { afterEach, describe, expect, it, vi } from "vitest";
import { config, requireRepo } from "../app/config/index.js";
import { maintenanceReporter, maintenanceRevision } from "../app/github/index.js";
import { runRepositoryVerification } from "../app/workflows/maintenance/verify.js";
import { planMaintenance } from "../scripts/lib/maintenance.js";
import { waitForMaintenance } from "../scripts/lib/maintenance-result.js";
import { inventoryMaintenance } from "../scripts/lib/maintenance-inventory.js";
import { REPO } from "./fixtures/config.js";
const SHA = "a".repeat(40);
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
function publicMode() {
	vi.stubEnv("MAINTENANCE_MODE", "public");
	vi.stubEnv("MAINTENANCE_GITHUB_TOKEN", "must-not-be-used");
	vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "must-not-be-used");
}

describe("public maintenance", () => {
	it("resolves revisions anonymously even when write credentials are present", async () => {
		publicMode();
		const requests: RequestInit[] = [];
		const fetch = (async (url, init) => {
			requests.push(init ?? {});
			return Response.json(String(url).includes("/commits/") ? { sha: SHA } : { private: false, full_name: REPO });
		}) as typeof globalThis.fetch;
		expect(await maintenanceRevision(REPO, "main", { fetch })).toEqual({ sha: SHA });
		expect(requests).toHaveLength(2);
		for (const req of requests) expect(new Headers(req.headers).has("Authorization")).toBe(false);
		expect(() => maintenanceReporter(requireRepo(REPO, 0))).toThrow("disabled");
	});
	it("records skipped publication after verification and cleanup without calling a reporter", async () => {
		publicMode();
		const fetch = vi.fn(async () => Response.json({ private: false, full_name: REPO }));
		vi.stubGlobal("fetch", fetch);
		const close = vi.fn(async () => {});
		const github = vi.fn();
		const result = await runRepositoryVerification({ repo: REPO, sha: SHA }, "public-run", {
			open: async () => ({
				id: "sbx-public",
				close,
				upload: async () => {},
				download: async () => Buffer.alloc(0),
				exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			}),
			prepare: async () => {},
			github,
		});
		expect(result).toMatchObject({ status: "passed", reporting: "skipped", cleanup: "terminated" });
		expect(close).toHaveBeenCalledOnce();
		expect(github).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledOnce();
	});
	it("continues planning when a repository cannot be resolved", async () => {
		const changed = structuredClone(config);
		changed.repos["acme/missing"] = changed.repos[REPO];
		const plan = await planMaintenance(changed, "2026-11-03", async (repo) => {
			if (repo === "acme/missing") throw new Error("untrusted API detail");
			return { sha: SHA };
		});
		expect(plan.input.repositories).toEqual([{ repo: REPO, sha: SHA }]);
		expect(plan.input.resolutionFailures).toEqual([{ repo: "acme/missing", reason: "revision_unavailable" }]);
		expect(JSON.stringify(plan)).not.toContain("untrusted API detail");
	});
	it("distinguishes Workflow completion from repository health", async () => {
		const report = { completedAt: new Date().toISOString(), results: [{ repo: REPO, sha: SHA, status: "failed", reporting: "skipped" }] };
		const get = vi
			.fn()
			.mockResolvedValueOnce({ status: "running" })
			.mockResolvedValue({ status: "succeeded", results: [report] });
		expect(await waitForMaintenance(get, { sleep: async () => {} })).toMatchObject({ healthy: false });
		expect(get).toHaveBeenCalledTimes(2);
	});
	it("accepts skipped GitHub reporting for healthy public runs and rejects malformed results", async () => {
		const report = { completedAt: new Date().toISOString(), results: [{ repo: REPO, sha: SHA, status: "passed", reporting: "skipped" }] };
		expect(await waitForMaintenance(async () => ({ status: "completed", results: [report] }))).toMatchObject({ healthy: true });
		await expect(waitForMaintenance(async () => ({ status: "succeeded", results: [] }))).rejects.toThrow();
	});
	it("inventories public repos without silently enabling unreviewed recipes", async () => {
		const rows = [REPO, "acme/unconfigured", "acme/archived"].map((name) => ({
			full_name: name,
			archived: name.endsWith("archived"),
			disabled: false,
			private: false,
			default_branch: "main",
			language: "JavaScript",
			html_url: `https://github.com/${name}`,
		}));
		const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(rows));
		const result = await inventoryMaintenance("acme", config, fetch);
		expect(result.repositories.map((r) => r.coverage)).toEqual(["configured", "needs_recipe", "excluded"]);
		expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
	});
});
