import { z } from "zod";
import { requireEnv, TASKS } from "../../config/index.js";
import { DependencyReviewResult, VerifyRepositoryInput } from "../../schemas/index.js";

const RunId = z
	.string()
	.regex(/^trn-[a-z0-9]+$/)
	.max(200);
const TaskId = z
	.string()
	.regex(/^tsk-[a-z0-9]+$/)
	.max(200);
const Run = z.object({ id: RunId, taskId: TaskId, status: z.string(), input: z.unknown().optional(), results: z.unknown().optional() });
const Task = z.object({ id: TaskId, name: z.string(), workflowId: z.string().regex(/^wfl-[a-z0-9]+$/) });

/** A user supplies only a run ID; evidence must come from our own registered review task. */
export async function loadDependencyReview(reviewRunId: string, publisherRunId: string, opts: { fetch?: typeof fetch; token?: string } = {}) {
	RunId.parse(reviewRunId);
	RunId.parse(publisherRunId);
	const fetchImpl = opts.fetch ?? fetch;
	const token = opts.token ?? requireEnv("RENDER_API_KEY");
	async function read(path: string): Promise<unknown> {
		const response = await fetchImpl(`https://api.render.com/v1${path}`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(15_000),
			redirect: "error",
		});
		if (!response.ok || !response.body) throw new Error("Workflow evidence lookup failed");
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > 1_500_000) throw new Error("Workflow evidence too large");
			chunks.push(chunk);
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	}
	const [reviewRun, publisherRun] = await Promise.all([
		read(`/task-runs/${reviewRunId}`).then((v) => Run.parse(v)),
		read(`/task-runs/${publisherRunId}`).then((v) => Run.parse(v)),
	]);
	if (reviewRun.id !== reviewRunId || publisherRun.id !== publisherRunId || reviewRun.status !== "completed")
		throw new Error("Review run is not confirmed complete");
	const [reviewTask, publisherTask] = await Promise.all([
		read(`/tasks/${reviewRun.taskId}`).then((v) => Task.parse(v)),
		read(`/tasks/${publisherRun.taskId}`).then((v) => Task.parse(v)),
	]);
	if (
		reviewTask.id !== reviewRun.taskId ||
		publisherTask.id !== publisherRun.taskId ||
		reviewTask.name !== TASKS.dependencyReview ||
		publisherTask.name !== TASKS.dependencyPublish ||
		reviewTask.workflowId !== publisherTask.workflowId
	)
		throw new Error("Review is not from this maintenance Workflow");
	const [input] = z.tuple([VerifyRepositoryInput]).parse(reviewRun.input);
	const [review] = z.tuple([DependencyReviewResult]).parse(reviewRun.results);
	if (review.runId !== reviewRunId || review.repo !== input.repo || review.sha !== input.sha) throw new Error("Review evidence identity mismatch");
	return { review, workflowId: reviewTask.workflowId };
}
