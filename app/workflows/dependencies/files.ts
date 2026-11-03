import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { APP_DIR, REPO_DIR, type Sandbox, shq } from "../../sandbox/index.js";
import { DependencyArtifact, type DependencyCandidate, DependencySnapshot } from "../../schemas/index.js";

const SCRIPT = `${APP_DIR}/dependency-files.mjs`;
const INPUT = `${APP_DIR}/dependency-input.json`;
const OUTPUT = `${APP_DIR}/dependency-output.json`;

export async function installFileHelper(sandbox: Sandbox): Promise<void> {
	const script = await readFile(new URL("../../../sandbox/dependency-files.mjs", import.meta.url));
	await sandbox.upload(`${SCRIPT}.gz`, gzipSync(script));
	const r = await sandbox.exec(`gzip -df ${SCRIPT}.gz && chmod 644 ${SCRIPT}`, { timeoutMs: 10_000 });
	if (r.exitCode !== 0) throw new Error("Could not install file helper");
}
export async function inspectFiles(sandbox: Sandbox, manager: "npm" | "yarn1", installed = false): Promise<DependencySnapshot> {
	const r = await sandbox.exec(`timeout -k 2 15 node ${SCRIPT} inspect ${REPO_DIR} ${manager} ${installed ? "installed" : "pristine"} ${OUTPUT}`, {
		timeoutMs: 20_000,
	});
	if (r.exitCode !== 0) throw new Error("Dependency files were rejected");
	const bytes = await sandbox.download(OUTPUT);
	if (bytes.length > 512_000) throw new Error("File snapshot too large");
	return DependencySnapshot.parse(JSON.parse(bytes.toString("utf8")));
}
export async function writeCandidateManifest(sandbox: Sandbox, candidate: DependencyCandidate): Promise<void> {
	await sandbox.upload(INPUT, JSON.stringify(candidate));
	const r = await sandbox.exec(`timeout -k 2 15 node ${SCRIPT} update ${REPO_DIR} unused ${INPUT}`, { timeoutMs: 20_000 });
	if (r.exitCode !== 0) throw new Error("Manifest update rejected");
}
export async function applyArtifact(sandbox: Sandbox, raw: unknown): Promise<void> {
	const artifact = DependencyArtifact.parse(raw);
	await sandbox.upload(`${INPUT}.gz`, gzipSync(JSON.stringify({ files: artifact.files })));
	const r = await sandbox.exec(`gzip -df ${INPUT}.gz && timeout -k 2 15 node ${SCRIPT} apply ${REPO_DIR} unused ${INPUT}`, { timeoutMs: 20_000 });
	if (r.exitCode !== 0) throw new Error("Candidate base or files did not match");
}
export async function regenerateLock(sandbox: Sandbox, manager: "npm" | "yarn1"): Promise<{ exitCode: number; output: string }> {
	const command =
		manager === "npm"
			? "npm install --package-lock-only --ignore-scripts --no-audit --no-fund"
			: "npm exec --yes --package=yarn@1.22.22 -- yarn install --ignore-scripts --non-interactive";
	const r = await sandbox.exec(`timeout -k 2 300 bash -c ${shq(command)}`, { asRunner: true, timeoutMs: 315_000 });
	return { exitCode: r.exitCode, output: [r.stdout, r.stderr].join("\n").slice(-4096) };
}
