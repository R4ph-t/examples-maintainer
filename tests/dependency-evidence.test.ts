import { describe, expect, it, vi } from "vitest";
import { loadDependencyReview } from "../app/workflows/dependencies/load-review.js";
const sha = "a".repeat(40);
function world() {
	const review = {
		repo: "acme/widget",
		sha,
		runId: "trn-review",
		status: "infrastructure_error",
		publishing: "disabled",
		completedAt: new Date().toISOString(),
	};
	const data: Record<string, unknown> = {
		"/task-runs/trn-review": {
			id: "trn-review",
			taskId: "tsk-review",
			status: "completed",
			input: [{ repo: "acme/widget", sha }],
			results: [review],
		},
		"/task-runs/trn-publish": { id: "trn-publish", taskId: "tsk-publish", status: "running" },
		"/tasks/tsk-review": { id: "tsk-review", name: "dependency-review", workflowId: "wfl-maintenance" },
		"/tasks/tsk-publish": { id: "tsk-publish", name: "dependency-publish", workflowId: "wfl-maintenance" },
	};
	const fetch = vi.fn<typeof globalThis.fetch>(async (url) => Response.json(data[new URL(String(url)).pathname.replace(/^\/v1/, "")]));
	return { data, review, fetch, run: () => loadDependencyReview("trn-review", "trn-publish", { fetch, token: "test-scoped-token" }) };
}
describe("trusted dependency evidence", () => {
	it("loads provider-owned evidence with matching task and input identities", async () => {
		const w = world();
		expect(await w.run()).toEqual({ review: w.review, workflowId: "wfl-maintenance" });
		expect(w.fetch.mock.calls.every(([url, options]) => String(url).startsWith("https://api.render.com/v1/") && options?.redirect === "error")).toBe(
			true,
		);
	});
	it.each([
		["/tasks/tsk-review", { id: "tsk-review", name: "unrelated", workflowId: "wfl-maintenance" }],
		["/tasks/tsk-review", { id: "tsk-review", name: "dependency-review", workflowId: "wfl-other" }],
		["/task-runs/trn-review", { id: "trn-review", taskId: "tsk-review", status: "running" }],
	])("rejects the wrong authority or incomplete evidence", async (path, value) => {
		const w = world();
		w.data[path] = value;
		await expect(w.run()).rejects.toThrow();
	});
	it("rejects a review claiming a different repository than its operator input", async () => {
		const w = world();
		w.review.repo = "elsewhere/repo";
		await expect(w.run()).rejects.toThrow("identity mismatch");
	});
	it("does not interpolate arbitrary URLs or paths into credentialed requests", async () => {
		const w = world();
		await expect(loadDependencyReview("../secrets", "trn-publish", { fetch: w.fetch, token: "test" })).rejects.toThrow();
		expect(w.fetch).not.toHaveBeenCalled();
	});
	it("rejects provider errors without retaining their response body", async () => {
		await expect(
			loadDependencyReview("trn-review", "trn-publish", { fetch: async () => new Response("secret", { status: 403 }), token: "test" }),
		).rejects.toThrow("Workflow evidence lookup failed");
	});
});
