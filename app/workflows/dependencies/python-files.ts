import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { APP_DIR, REPO_DIR, type Sandbox } from "../../sandbox/index.js";
import { DependencyArtifact, type DependencyCandidate, DependencySnapshot } from "../../schemas/index.js";

export const PYTHON_HELPER = `${APP_DIR}/python-dependency-files.py`;
const INPUT = `${APP_DIR}/python-dependency-input.json`;
const OUTPUT = `${APP_DIR}/python-dependency-output.json`;

export async function installPythonFileHelper(sandbox: Sandbox): Promise<void> {
	const script = await readFile(new URL("../../../sandbox/python-dependency-files.py", import.meta.url));
	await sandbox.upload(`${PYTHON_HELPER}.gz`, gzipSync(script));
	const r = await sandbox.exec(`gzip -df ${PYTHON_HELPER}.gz && chmod 644 ${PYTHON_HELPER}`, { timeoutMs: 10_000 });
	if (r.exitCode !== 0) throw new Error("Could not install Python file helper");
}
export async function inspectPythonFiles(sandbox: Sandbox, installed = false): Promise<DependencySnapshot> {
	const r = await sandbox.exec(
		`timeout -k 2 15 python3 -I -S ${PYTHON_HELPER} inspect ${REPO_DIR} ${installed ? "installed" : "pristine"} ${OUTPUT}`,
		{ timeoutMs: 20_000 },
	);
	if (r.exitCode !== 0) throw new Error("Python dependency files were rejected");
	const bytes = await sandbox.download(OUTPUT, AbortSignal.timeout(15_000));
	if (bytes.length > 512_000) throw new Error("Python snapshot too large");
	return DependencySnapshot.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
export async function writePythonCandidateManifest(sandbox: Sandbox, candidate: DependencyCandidate): Promise<void> {
	await sandbox.upload(INPUT, JSON.stringify(candidate));
	const r = await sandbox.exec(`timeout -k 2 15 python3 -I -S ${PYTHON_HELPER} update ${REPO_DIR} ${INPUT} unused`, { timeoutMs: 20_000 });
	if (r.exitCode !== 0) throw new Error("Python requirement update rejected");
}
export async function applyPythonArtifact(sandbox: Sandbox, raw: unknown): Promise<void> {
	const artifact = DependencyArtifact.parse(raw);
	await sandbox.upload(`${INPUT}.gz`, gzipSync(JSON.stringify({ files: artifact.files })));
	const r = await sandbox.exec(`gzip -df ${INPUT}.gz && timeout -k 2 15 python3 -I -S ${PYTHON_HELPER} apply ${REPO_DIR} ${INPUT} unused`, {
		timeoutMs: 20_000,
	});
	if (r.exitCode !== 0) throw new Error("Python candidate base or files did not match");
}
/** Exact requirements pins are the proposal file. Compatibility is resolved and checked in the clean candidate install. */
export async function regeneratePythonLock(sandbox: Sandbox): Promise<{ exitCode: number; output: string }> {
	await inspectPythonFiles(sandbox);
	return { exitCode: 0, output: "Validated exact requirements pins; this adapter does not generate a transitive lockfile." };
}
