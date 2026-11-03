import { afterEach, describe, expect, it, vi } from "vitest";
import { requireRepo } from "../app/config/index.js";
import { assertPublicMaintenanceRepo, maintenanceReporter, maintenanceRevision } from "../app/github/index.js";
import { runRepositoryVerification } from "../app/workflows/maintenance/verify.js";
import { REPO } from "./fixtures/config.js";

const SHA = "a".repeat(40);
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
function api(responses: unknown[]) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetch = (async (url, init) => {
		calls.push({ url: String(url), init });
		if (!responses.length) throw new Error("unexpected request");
		return new Response(JSON.stringify(responses.shift()), { status: 200 });
	}) as typeof globalThis.fetch;
	return { calls, fetch };
}

describe("PAT maintenance", () => {
	it("resolves a public commit without App credentials or installation lookup", async () => {
		vi.stubEnv("MAINTENANCE_GITHUB_TOKEN", "pat-test");
		vi.stubEnv("GITHUB_APP_ID", "");
		vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
		const a = api([{ private: false, full_name: REPO }, { sha: SHA }]);
		expect(await maintenanceRevision(REPO, "main", { fetch: a.fetch })).toEqual({ sha: SHA });
		expect(a.calls).toHaveLength(2);
		expect(a.calls.every((c) => !c.url.includes("installation"))).toBe(true);
		expect(a.calls[0].init?.headers).toMatchObject({ Authorization: "Bearer pat-test" });
	});
	it.each([{ private: true, full_name: REPO }, { private: false, full_name: "elsewhere/moved" }, { full_name: REPO }])(
		"rejects private, renamed, or malformed metadata before sandbox creation",
		async (metadata) => {
			vi.stubEnv("MAINTENANCE_GITHUB_TOKEN", "pat-test");
			const a = api([metadata]);
			vi.stubGlobal("fetch", a.fetch);
			const open = vi.fn();
			await expect(runRepositoryVerification({ repo: REPO, sha: SHA }, "run", { open })).rejects.toThrow();
			expect(open).not.toHaveBeenCalled();
		},
	);
	it("refuses to use a missing installation when PAT mode is not configured", async () => {
		vi.stubEnv("MAINTENANCE_GITHUB_TOKEN", "");
		await expect(runRepositoryVerification({ repo: REPO, sha: SHA }, "run")).rejects.toThrow("installationId");
	});
	it.each([
		["success", "success"],
		["failure", "failure"],
		["action_required", "error"],
	] as const)("publishes %s as a commit status without untrusted output or a Check Run", async (conclusion, state) => {
		vi.stubEnv("MAINTENANCE_GITHUB_TOKEN", "pat-test");
		const a = api([{ url: "https://api.github.com/status/1" }]);
		const reporter = maintenanceReporter(requireRepo(REPO, 0), { fetch: a.fetch });
		await reporter.createMaintenanceCheck({ headSha: SHA, externalId: "run-1", conclusion, summary: "untrusted output" });
		expect(a.calls[0].url).toContain(`/statuses/${SHA}`);
		expect(JSON.parse(String(a.calls[0].init?.body))).toMatchObject({ state, context: "examples-maintainer / health" });
		expect(String(a.calls[0].init?.body)).not.toContain("untrusted output");
	});
	it("never retries an ambiguous status write", async () => {
		vi.stubEnv("MAINTENANCE_GITHUB_TOKEN", "pat-test");
		const fetch = vi.fn(async () => {
			throw new Error("connection lost");
		});
		await expect(
			maintenanceReporter(requireRepo(REPO, 0), { fetch }).createMaintenanceCheck({
				headSha: SHA,
				externalId: "run-1",
				conclusion: "success",
				summary: "",
			}),
		).rejects.toThrow("connection lost");
		expect(fetch).toHaveBeenCalledOnce();
	});
	it("does not silently use ambient personal credentials", async () => {
		vi.stubEnv("MAINTENANCE_GITHUB_TOKEN", "");
		vi.stubEnv("GH_TOKEN", "ambient-token");
		await expect(assertPublicMaintenanceRepo(REPO)).rejects.toThrow("MAINTENANCE_GITHUB_TOKEN");
	});
});
