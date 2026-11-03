import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, requireRepo } from "../app/config/index.js";
import { maintenanceReporter, maintenanceRevision } from "../app/github/index.js";
import { runRepositoryVerification } from "../app/workflows/maintenance/verify.js";
import { planMaintenance } from "../scripts/lib/maintenance.js";
import { inventoryMaintenance } from "../scripts/lib/maintenance-inventory.js";
import { waitForMaintenance } from "../scripts/lib/maintenance-result.js";
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
	it("resolves an exact public branch without REST metadata or ambient credentials/configuration", async () => {
		publicMode();
		vi.stubEnv("GH_TOKEN", "ambient-secret");
		vi.stubEnv("GIT_CONFIG_COUNT", "1");
		vi.stubEnv("GIT_CONFIG_KEY_0", "http.extraHeader");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "Authorization: secret");
		const fetch = vi.fn(async () => {
			throw new Error("REST must not be used");
		});
		let taskGitHome = "";
		const git = vi.fn(async (args: string[], execution: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => {
			taskGitHome = execution.cwd;
			expect(execution.env.HOME).toBe(taskGitHome);
			expect(execution.env.HOME).not.toBe(process.env.HOME);
			expect(execution.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
			expect(execution.env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
			expect(execution.env.GIT_CONFIG_NOSYSTEM).toBe("1");
			expect(execution.env.NETRC).toBe("/dev/null");
			expect(execution.env.GIT_TERMINAL_PROMPT).toBe("0");
			expect(execution.env.GIT_ASKPASS).toBe("/bin/false");
			expect(execution.env.GH_TOKEN).toBeUndefined();
			expect(execution.env.MAINTENANCE_GITHUB_TOKEN).toBeUndefined();
			expect(execution.env.GIT_CONFIG_COUNT).toBeUndefined();
			expect(JSON.stringify(execution)).not.toContain("ambient-secret");
			expect(execution.timeout).toBe(30_000);
			expect(execution.maxBuffer).toBe(4096);
			expect(args).toContain("http.followRedirects=false");
			expect(args).toContain("credential.helper=");
			expect(args).toContain("http.extraHeader=");
			expect(args).toContain("protocol.allow=never");
			expect(args.slice(-7)).toEqual([
				"ls-remote",
				"--refs",
				"--exit-code",
				"--quiet",
				"--",
				`https://github.com/${REPO}.git`,
				"refs/heads/release/next",
			]);
			return `${SHA}\trefs/heads/release/next\n`;
		});
		expect(await maintenanceRevision(REPO, "release/next", { fetch, git, timeoutMs: 90_000 })).toEqual({ sha: SHA });
		expect(fetch).not.toHaveBeenCalled();
		expect(git).toHaveBeenCalledOnce();
		await expect(stat(taskGitHome)).rejects.toMatchObject({ code: "ENOENT" });
		expect(() => maintenanceReporter(requireRepo(REPO, 0))).toThrow("disabled");
	});
	it.each([
		"",
		`${SHA}\trefs/tags/main\n`,
		`${SHA}\trefs/heads/main\n${SHA}\trefs/heads/main\n`,
		`${SHA}\trefs/heads/main\n\n`,
		`not-a-sha\trefs/heads/main\n`,
		"x".repeat(4097),
	])("rejects missing, wrong, duplicate, or malformed advertised refs", async (output) => {
		publicMode();
		await expect(maintenanceRevision(REPO, "main", { git: async () => output })).rejects.toThrow("invalid");
	});
	it.each(["--upload-pack=evil", "main*", "refs/../main", "main.lock", "main//next", "main/"])(
		"rejects unsafe or ambiguous branch %s",
		async (branch) => {
			publicMode();
			const git = vi.fn(async () => "");
			await expect(maintenanceRevision(REPO, branch, { git })).rejects.toThrow("Unsupported");
			expect(git).not.toHaveBeenCalled();
		},
	);
	it.each(["https://elsewhere/repo", "owner/../repo", "owner/repo?token=secret", "owner/.."])(
		"rejects noncanonical repository target %s",
		async (repo) => {
			publicMode();
			const git = vi.fn(async () => "");
			await expect(maintenanceRevision(repo, "main", { git })).rejects.toThrow("Unsupported");
			expect(git).not.toHaveBeenCalled();
		},
	);
	it("fails closed on private, moved, timed-out, or otherwise inaccessible public Git requests without returning stderr", async () => {
		publicMode();
		let taskGitHome = "";
		const git = vi.fn(async (_args: string[], execution: { cwd: string }) => {
			taskGitHome = execution.cwd;
			throw new Error("HTTP 403 or credential secret detail");
		});
		await expect(maintenanceRevision(REPO, "main", { git })).rejects.toThrow(/^Anonymous Git revision lookup failed$/);
		await expect(stat(taskGitHome)).rejects.toMatchObject({ code: "ENOENT" });
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
		expect(fetch).not.toHaveBeenCalled();
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
