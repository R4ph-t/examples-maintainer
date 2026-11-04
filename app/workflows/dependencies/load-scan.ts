import { z } from "zod";
import { requireEnv, TASKS } from "../../config/index.js";
import { DependencyScanResult, VerifyRepositoryInput } from "../../schemas/index.js";

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

/** Accept evidence only from a completed scan owned by this verification Workflow. */
export async function loadDependencyScan(scanRunId: string, verifierRunId: string, opts: { fetch?: typeof fetch; token?: string } = {}) {
	RunId.parse(scanRunId);
	RunId.parse(verifierRunId);
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
	const [scanRun, verifierRun] = await Promise.all([
		read(`/task-runs/${scanRunId}`).then((v) => Run.parse(v)),
		read(`/task-runs/${verifierRunId}`).then((v) => Run.parse(v)),
	]);
	if (scanRun.id !== scanRunId || verifierRun.id !== verifierRunId || scanRun.status !== "completed")
		throw new Error("Scan is not confirmed complete");
	const [scanTask, verifierTask] = await Promise.all([
		read(`/tasks/${scanRun.taskId}`).then((v) => Task.parse(v)),
		read(`/tasks/${verifierRun.taskId}`).then((v) => Task.parse(v)),
	]);
	if (
		scanTask.id !== scanRun.taskId ||
		verifierTask.id !== verifierRun.taskId ||
		scanTask.name !== TASKS.dependencyScan ||
		verifierTask.name !== TASKS.dependencyVerifySelected ||
		scanTask.workflowId !== verifierTask.workflowId
	)
		throw new Error("Scan is not from this maintenance Workflow");
	const [input] = z.tuple([VerifyRepositoryInput]).parse(scanRun.input);
	const [scan] = z.tuple([DependencyScanResult]).parse(scanRun.results);
	if (scan.runId !== scanRunId || scan.repo !== input.repo || scan.sha !== input.sha) throw new Error("Scan identity mismatch");
	return { scan, input };
}
