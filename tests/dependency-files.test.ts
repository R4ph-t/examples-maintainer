import { mkdtemp, writeFile, readFile, mkdir, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildArtifact } from "../app/workflows/dependencies/artifact.js";
import type { DependencyCandidate, DependencySnapshot } from "../app/schemas/index.js";

const helper: {
	snapshot: (root: string, manager: string, installed?: boolean) => Promise<DependencySnapshot>;
	applyFiles: (root: string, files: unknown) => Promise<void>;
	updateManifest: (root: string, candidate: unknown) => Promise<void>;
} = await import(new URL("../sandbox/dependency-files.mjs", import.meta.url).href);
const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture(manager = "npm") {
	const root = await mkdtemp(join(tmpdir(), "dependency-files-test-"));
	dirs.push(root);
	await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "node app.js" }, dependencies: { express: "^5.0.0" } }));
	await writeFile(
		join(root, manager === "npm" ? "package-lock.json" : "yarn.lock"),
		manager === "npm" ? '{"lockfileVersion":3}' : "# yarn lockfile v1\n",
	);
	return root;
}
const candidate: DependencyCandidate = {
	name: "express",
	section: "dependencies",
	fromRange: "^5.0.0",
	fromVersion: "5.0.1",
	toVersion: "5.2.0",
	toRange: "^5.2.0",
	kind: "minor",
};

describe("dependency file boundary", () => {
	it.each(["npm", "yarn1"])("inspects and updates %s files without running package scripts", async (manager) => {
		const root = await fixture(manager);
		await helper.updateManifest(root, candidate);
		const result = await helper.snapshot(root, manager);
		expect(JSON.parse(result.files[0].content)).toEqual({ scripts: { start: "node app.js" }, dependencies: { express: "^5.2.0" } });
	});
	it("reads installed package versions without importing package code", async () => {
		const root = await fixture();
		await mkdir(join(root, "node_modules/express"), { recursive: true });
		await writeFile(join(root, "node_modules/express/package.json"), '{"version":"5.0.1","main":"must-not-run.js"}');
		expect((await helper.snapshot(root, "npm", true)).installed).toEqual({ express: "5.0.1" });
	});
	it("rejects symlinked manifests, lockfiles and installed packages", async () => {
		for (const file of ["package.json", "package-lock.json", "node_modules/express/package.json"]) {
			const root = await fixture();
			const outside = await fixture();
			await mkdir(join(root, "node_modules/express"), { recursive: true });
			await rm(join(root, file), { force: true });
			await symlink(join(outside, "package.json"), join(root, file));
			await expect(helper.snapshot(root, "npm", file.startsWith("node_modules"))).rejects.toThrow();
		}
	});
	it("rejects hard links, mixed lockfiles, workspaces and oversized files", async () => {
		const hard = await fixture();
		await link(join(hard, "package.json"), join(hard, "duplicate"));
		await expect(helper.snapshot(hard, "npm")).rejects.toThrow();
		const mixed = await fixture();
		await writeFile(join(mixed, "yarn.lock"), "lock");
		await expect(helper.snapshot(mixed, "npm")).rejects.toThrow();
		const workspace = await fixture();
		await writeFile(join(workspace, "package.json"), '{"workspaces":["packages/*"]}');
		await expect(helper.snapshot(workspace, "npm")).rejects.toThrow();
		const big = await fixture();
		await writeFile(join(big, "package-lock.json"), "x".repeat(180001));
		await expect(helper.snapshot(big, "npm")).rejects.toThrow();
	});
	it("rejects path traversal and mismatched bases before writing any file", async () => {
		const root = await fixture();
		const before = await helper.snapshot(root, "npm");
		const files = before.files.map((f) => ({ path: f.path, before: f.content, after: f.content }));
		files[1].before = "different base";
		await expect(helper.applyFiles(root, files)).rejects.toThrow();
		expect(await readFile(join(root, "package.json"), "utf8")).toBe(before.files[0].content);
		await expect(helper.applyFiles(root, [{ path: "../../escape", before: "", after: "bad" }, files[1]])).rejects.toThrow();
	});
	it("exports a patch that applies cleanly to the original files and reproduces the reviewed content", async () => {
		const root = await fixture();
		const before = await helper.snapshot(root, "npm");
		await helper.updateManifest(root, candidate);
		await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
		const after = await helper.snapshot(root, "npm");
		const artifact = await buildArtifact("a".repeat(40), "npm", candidate, before, after);
		const clean = await fixture();
		for (const f of before.files) await writeFile(join(clean, f.path), f.content);
		await writeFile(join(clean, "candidate.patch"), artifact.patch);
		await promisify(execFile)("git", ["apply", "--check", "candidate.patch"], { cwd: clean });
		await promisify(execFile)("git", ["apply", "candidate.patch"], { cwd: clean });
		expect((await helper.snapshot(clean, "npm")).files).toEqual(after.files);
		const second = await fixture();
		for (const f of before.files) await writeFile(join(second, f.path), f.content);
		await helper.applyFiles(second, artifact.files);
		expect((await helper.snapshot(second, "npm")).files).toEqual(after.files);
	});
});
