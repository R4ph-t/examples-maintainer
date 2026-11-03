import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskContext } from "@renderinc/sdk/workflows";
import { config } from "../app/config/index.js";
import type { ExecOptions, Sandbox } from "../app/sandbox/index.js";
import { MaintenanceRecipe } from "../app/schemas/index.js";
import { maintenanceSweep } from "../app/workflows/maintenance/index.js";
import { runRepositoryVerification } from "../app/workflows/maintenance/verify.js";
import { planMaintenance } from "../scripts/lib/maintenance.js";
import { REPO } from "./fixtures/config.js";

const SHA = "a".repeat(40);
const input = { repo: REPO, installationId: 7, sha: SHA };
function world() {
	const exec = vi.fn(async (_command: string, _opts?: ExecOptions) => ({ exitCode: 0, stdout: "untrusted @everyone output", stderr: "" }));
	const close = vi.fn(async () => {});
	const sandbox: Sandbox = { id: "sbx-test", exec, close, upload: vi.fn(async () => {}), download: vi.fn(async () => Buffer.alloc(0)) };
	const open = vi.fn(async () => sandbox);
	const prepare = vi.fn(async () => {});
	const report = vi.fn(async (_args: unknown) => ({ htmlUrl: "https://github.test/check/1" }));
	return { exec, close, open, prepare, report, deps: { open, prepare, github: () => ({ createMaintenanceCheck: report }) } };
}

beforeEach(() => vi.restoreAllMocks());

describe("repository verification", () => {
	it("checks the selected commit, records every stage, cleans up before reporting, and excludes guest output from GitHub", async () => {
		const w = world();
		w.report.mockImplementation(async () => {
			expect(w.close).toHaveBeenCalledOnce();
			return { htmlUrl: "https://github.test/check/1" };
		});
		const result = await runRepositoryVerification(input, "run-1", w.deps);
		expect(w.prepare).toHaveBeenCalledWith(expect.objectContaining({ id: "sbx-test" }), expect.objectContaining({ fullName: REPO }), SHA);
		expect(result).toMatchObject({ status: "passed", cleanup: "terminated", reporting: "published", sha: SHA, sandboxId: "sbx-test" });
		expect(result.stages.map((s) => s.name)).toEqual(["prepare", "runtime", "install", "build", "smoke"]);
		expect(result.recipeHash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.smokeRunnerHash).toMatch(/^[a-f0-9]{64}$/);
		expect(w.report).toHaveBeenCalledWith(expect.objectContaining({ headSha: SHA, conclusion: "success", externalId: "examples-maintainer:run-1" }));
		expect(JSON.stringify(w.report.mock.calls)).not.toContain("@everyone");
		for (const [command, options] of w.exec.mock.calls.filter(([, options]) => options?.asRunner)) {
			expect(command).toMatch(/^timeout -k 2 /);
			expect(options?.timeoutMs).toBeGreaterThan(0);
		}
	});

	it("stops at a failed install and reports its stage without running build or smoke", async () => {
		const w = world();
		w.exec.mockImplementation(async (command) => ({ exitCode: command.includes("npm ci") ? 1 : 0, stdout: "", stderr: "install failed" }));
		const result = await runRepositoryVerification(input, "run-2", w.deps);
		expect(result).toMatchObject({ status: "failed", cleanup: "terminated" });
		expect(result.stages.at(-1)).toMatchObject({ name: "install", exitCode: 1, status: "failed" });
		expect(w.exec.mock.calls.some(([command]) => command.includes("npm run build"))).toBe(false);
		expect(w.report).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "failure" }));
	});

	it("reports a lost exec stream as unknown, not a successful command", async () => {
		const w = world();
		w.exec.mockImplementation(async (command) => {
			if (command.includes("npm ci")) throw new Error("stream lost");
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const result = await runRepositoryVerification(input, "run-3", w.deps);
		expect(result.status).toBe("infrastructure_error");
		expect(result.stages.at(-1)).toMatchObject({ name: "install", exitCode: null, status: "unknown" });
		expect(w.close).toHaveBeenCalledOnce();
	});

	it("cleans up a partially prepared sandbox without publishing exception contents", async () => {
		const w = world();
		w.prepare.mockRejectedValue(new Error("secret material from clone failure"));
		const result = await runRepositoryVerification(input, "run-4", w.deps);
		expect(result).toMatchObject({ status: "infrastructure_error", cleanup: "terminated", stages: [{ name: "prepare", status: "unknown" }] });
		expect(w.close).toHaveBeenCalledOnce();
		expect(w.exec).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain("secret material");
	});

	it("cannot report green when termination fails", async () => {
		const w = world();
		w.close.mockRejectedValue(new Error("termination unavailable"));
		const result = await runRepositoryVerification(input, "run-5", w.deps);
		expect(result).toMatchObject({ status: "infrastructure_error", cleanup: "unconfirmed", sandboxId: "sbx-test" });
		expect(w.report).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "action_required" }));
	});

	it("does not claim cleanup when creation returns an ambiguous error", async () => {
		const w = world();
		w.open.mockRejectedValue(new Error("create response lost"));
		const result = await runRepositoryVerification(input, "run-unknown", w.deps);
		expect(result).toMatchObject({ status: "infrastructure_error", cleanup: "unconfirmed", sandboxId: null });
		expect(w.prepare).not.toHaveBeenCalled();
	});

	it("preserves results and cleanup when GitHub reporting fails", async () => {
		const w = world();
		w.report.mockRejectedValue(new Error("missing checks permission"));
		const result = await runRepositoryVerification(input, "run-6", w.deps);
		expect(result).toMatchObject({ status: "passed", cleanup: "terminated", reporting: "failed" });
	});

	it.each([
		{ ...input, repo: "outside/not-allowed" },
		{ ...input, repo: "acme/docs" },
		{ ...input, sha: "main" },
		{ ...input, command: "do something else" },
	])("rejects unconfigured recipes, mutable refs, and command overrides before creating resources", async (bad) => {
		const w = world();
		await expect(runRepositoryVerification(bad, "run-7", w.deps)).rejects.toThrow();
		expect(w.open).not.toHaveBeenCalled();
		expect(w.report).not.toHaveBeenCalled();
	});
});

describe("maintenance dispatch", () => {
	const resolve = async () => ({ installationId: 7, sha: SHA });
	it("deduplicates a daily sweep but tests an unchanged commit on a new day", async () => {
		const one = await planMaintenance(config, "2026-11-03", resolve);
		const same = await planMaintenance(config, "2026-11-03", resolve);
		const next = await planMaintenance(config, "2026-11-04", resolve);
		expect(one).toEqual(same);
		expect(one.idempotencyKey).not.toBe(next.idempotencyKey);
		expect(one.input.repositories).toEqual([input]);
	});
	it("invalidates the dispatch identity when the recipe or commit changes", async () => {
		const first = await planMaintenance(config, "2026-11-03", resolve);
		const next = await planMaintenance(config, "2026-11-03", async () => ({ installationId: 7, sha: "b".repeat(40) }));
		const modified = structuredClone(config);
		const recipe = modified.repos[REPO].maintenance;
		if (!recipe) throw new Error("fixture missing recipe");
		recipe.smoke.bodyIncludes = "changed";
		const changed = await planMaintenance(modified, "2026-11-03", resolve);
		expect(first.idempotencyKey).not.toBe(next.idempotencyKey);
		expect(first.idempotencyKey).not.toBe(changed.idempotencyKey);
	});
	it("bounds batch size and recipe duration", async () => {
		await expect(planMaintenance({ ...config, repos: {} }, "2026-11-03", resolve)).rejects.toThrow();
		const recipe = structuredClone(config.repos[REPO].maintenance);
		if (!recipe) throw new Error("fixture missing recipe");
		recipe.install.timeoutSeconds = 600;
		recipe.checks[0].timeoutSeconds = 600;
		expect(MaintenanceRecipe.safeParse(recipe).success).toBe(false);
	});
	it("runs one child at a time and continues after a failed repository", async () => {
		let active = 0;
		let peak = 0;
		let calls = 0;
		const run: TaskContext["run"] = async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active--;
			calls++;
			throw new Error("repository failed");
		};
		const result = await maintenanceSweep.func({ metadata: {}, run }, { repositories: [input, { ...input, sha: "b".repeat(40) }] });
		expect(peak).toBe(1);
		expect(calls).toBe(2);
		expect(result.results).toHaveLength(2);
	});
});
