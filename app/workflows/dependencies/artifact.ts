import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DependencyArtifact, type DependencyCandidate, DependencySnapshot } from "../../schemas/index.js";

/** Validate the complete files, not a sandbox-provided diff or its claimed list of changes. */
export async function buildArtifact(
	sha: string,
	manager: "npm" | "yarn1",
	candidate: DependencyCandidate,
	rawBefore: unknown,
	rawAfter: unknown,
): Promise<DependencyArtifact> {
	const before = DependencySnapshot.parse(rawBefore);
	const after = DependencySnapshot.parse(rawAfter);
	const paths = ["package.json", manager === "npm" ? "package-lock.json" : "yarn.lock"];
	if (
		!isDeepStrictEqual(
			before.files.map((f) => f.path),
			paths,
		) ||
		!isDeepStrictEqual(
			after.files.map((f) => f.path),
			paths,
		)
	)
		throw new Error("Unexpected artifact paths");
	const original = JSON.parse(before.files[0].content);
	const expected = structuredClone(original);
	if (!Object.hasOwn(expected[candidate.section] ?? {}, candidate.name) || expected[candidate.section][candidate.name] !== candidate.fromRange)
		throw new Error("Manifest base mismatch");
	expected[candidate.section][candidate.name] = candidate.toRange;
	if (!isDeepStrictEqual(JSON.parse(after.files[0].content), expected)) throw new Error("Update changed unrelated manifest fields");
	if (manager === "npm") {
		const lock = JSON.parse(after.files[1].content);
		if (![1, 2, 3].includes(lock.lockfileVersion)) throw new Error("Invalid npm lockfile");
	}
	const files = before.files.map((f, i) => ({ path: f.path, before: f.content, after: after.files[i].content }));
	if (files.every((f) => f.before === f.after)) throw new Error("Empty proposal");
	const dir = await mkdtemp(join(tmpdir(), "maintenance-diff-"));
	let patch: string;
	try {
		await mkdir(join(dir, "a"));
		await mkdir(join(dir, "b"));
		for (const file of files) {
			await writeFile(join(dir, "a", file.path), file.before);
			await writeFile(join(dir, "b", file.path), file.after);
		}
		// Data-only temporary directories. No downloaded code, repository config, or credentials are executed.
		patch = await new Promise<string>((resolve, reject) =>
			execFile(
				"git",
				["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "a", "b"],
				{
					cwd: dir,
					timeout: 10_000,
					maxBuffer: 512_000,
					env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
				},
				(error, stdout) => {
					if (error && error.code !== 1) reject(new Error("Could not generate bounded patch"));
					else resolve(stdout);
				},
			),
		);
		patch = patch
			.replace(/^diff --git a\/a\/(\S+) b\/b\/(\S+)$/gm, "diff --git a/$1 b/$2")
			.replace(/^--- a\/a\//gm, "--- a/")
			.replace(/^\+\+\+ b\/b\//gm, "+++ b/");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	const id = createHash("sha256").update(JSON.stringify({ sha, candidate, files })).digest("hex");
	const artifact = DependencyArtifact.parse({ id, baseSha: sha, files, patch });
	if (Buffer.byteLength(JSON.stringify(artifact)) > 512_000) throw new Error("Proposal exceeds retained artifact budget");
	return artifact;
}
