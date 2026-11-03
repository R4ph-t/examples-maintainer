import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { DependencyCandidate, DependencySnapshot } from "../app/schemas/index.js";
import type { Sandbox } from "../app/sandbox/index.js";
import { discoverPythonUpdates, parsePythonRequirements, validatePythonChange } from "../app/workflows/dependencies/python.js";
import { auditPythonSandbox, normalizePythonAudit } from "../app/workflows/dependencies/python-audit.js";

const helper = fileURLToPath(new URL("../sandbox/python-dependency-files.py", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const candidate: DependencyCandidate = {
	name: "django",
	section: "requirements",
	fromRange: "==5.0.1",
	fromVersion: "5.0.1",
	toRange: "==5.2.9",
	toVersion: "5.2.9",
	kind: "minor",
};
const snapshot = (content = "Django==5.0.1\n"): DependencySnapshot => ({
	files: [{ path: "requirements.txt", content }],
	installed: { django: "5.0.1" },
});
function setup(content = "Django==5.0.1\n") {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "python-maintenance-")));
	dirs.push(dir);
	const repo = join(dir, "repo");
	mkdirSync(repo);
	writeFileSync(join(repo, "requirements.txt"), content);
	const input = join(dir, "input.json"),
		output = join(dir, "output.json");
	function run(mode: string, value: unknown = {}, installed = false) {
		writeFileSync(input, JSON.stringify(value));
		execFileSync(
			"python3",
			["-I", "-S", helper, mode, repo, mode === "inspect" ? (installed ? "installed" : "pristine") : mode === "inventory" ? "unused" : input, output],
			{ env: { PATH: process.env.PATH }, stdio: "pipe" },
		);
		return existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : undefined;
	}
	function distribution(name: string, version: string) {
		const path = join(repo, ".venv/lib/python3.11/site-packages", `${name}-${version}.dist-info`);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "METADATA"), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`);
		return path;
	}
	return { dir, repo, run, distribution };
}

describe("Python exact-pin dependency format", () => {
	it("preserves comments, extras, casing, CRLF, and unrelated pins when changing one requirement", () => {
		const content = "# pinned\r\nDjango == 5.0.1 # app\r\nuvicorn[standard]==0.27.0.post1\r\npackaging==23.2\r\n";
		const w = setup(content);
		expect(parsePythonRequirements(content).map((r) => [r.name, r.version])).toEqual([
			["django", "5.0.1"],
			["uvicorn", "0.27.0.post1"],
			["packaging", "23.2"],
		]);
		w.run("update", candidate);
		const updated = readFileSync(join(w.repo, "requirements.txt"), "utf8");
		expect(updated).toBe(content.replace("5.0.1", "5.2.9"));
		expect(() => validatePythonChange(candidate, snapshot(content), snapshot(updated))).not.toThrow();
		expect(() => validatePythonChange(candidate, snapshot(content), snapshot(updated.replace("23.2", "24.1")))).toThrow("unrelated");
	});
	it.each([
		"-r other.txt",
		"--index-url https://evil.test",
		"-e .",
		"Django @ https://evil.test/django.whl",
		"Django>=5.0",
		"Django==5.0.1; python_version>'3'",
		"Django==5.0.1\\\n --hash=sha256:abc",
		"Django==5.0.1\ndjango==5.0.2",
		"Django==5.0.1\u0000",
	])("rejects unsupported requirements %s on both boundaries", (content) => {
		expect(() => parsePythonRequirements(content)).toThrow();
		const w = setup(content);
		expect(() => w.run("inspect")).toThrow();
	});
	it("reads actual installed metadata without importing packages or project startup hooks", () => {
		const w = setup();
		w.distribution("Django", "5.0.1");
		w.distribution("asgiref", "3.7.2");
		writeFileSync(join(w.repo, "sitecustomize.py"), "raise RuntimeError('must not execute')");
		writeFileSync(join(w.repo, ".venv/lib/python3.11/site-packages/sitecustomize.py"), "raise RuntimeError('must not execute')");
		expect(w.run("inspect", {}, true)).toEqual(snapshot());
		expect(w.run("inventory")).toEqual({ django: "5.0.1", asgiref: "3.7.2" });
	});
	it("refuses missing, duplicate, or symlinked installed metadata", () => {
		const w = setup();
		expect(() => w.run("inspect", {}, true)).toThrow();
		const p = w.distribution("Django", "5.0.1");
		w.distribution("django", "5.0.2");
		expect(() => w.run("inspect", {}, true)).toThrow();
		rmSync(join(w.repo, ".venv/lib/python3.11/site-packages/django-5.0.2.dist-info"), { recursive: true });
		rmSync(join(p, "METADATA"));
		writeFileSync(join(w.dir, "metadata"), "Name: Django\nVersion: 5.0.1\n");
		symlinkSync(join(w.dir, "metadata"), join(p, "METADATA"));
		expect(() => w.run("inspect", {}, true)).toThrow();
	});
	it.each(["symlink", "hardlink", "oversized", "invalid_utf8", "mixed"])("rejects unsafe requirement input: %s", (kind) => {
		const w = setup();
		const path = join(w.repo, "requirements.txt");
		if (kind === "symlink" || kind === "hardlink") {
			rmSync(path);
			writeFileSync(join(w.dir, "outside"), "Django==5.0.1\n");
			(kind === "symlink" ? symlinkSync : linkSync)(join(w.dir, "outside"), path);
		} else if (kind === "oversized") writeFileSync(path, "#".repeat(180001));
		else if (kind === "invalid_utf8") writeFileSync(path, Buffer.from([255, 254]));
		else writeFileSync(join(w.repo, "pyproject.toml"), "[project]");
		expect(() => w.run("inspect")).toThrow();
	});
	it("applies only exact matching base content and refuses traversal or changed inputs without writing", () => {
		const w = setup();
		for (const file of [
			{ path: "../outside", before: "Django==5.0.1\n", after: "Django==5.2.9\n" },
			{ path: "requirements.txt", before: "wrong", after: "Django==5.2.9\n" },
			{ path: "requirements.txt", before: "Django==5.0.1\n", after: "-r external.txt" },
		]) {
			expect(() => w.run("apply", { files: [file] })).toThrow();
			expect(readFileSync(join(w.repo, "requirements.txt"), "utf8")).toBe("Django==5.0.1\n");
		}
		w.run("apply", { files: [{ path: "requirements.txt", before: "Django==5.0.1\n", after: "Django==5.2.9\n" }] });
		expect(readFileSync(join(w.repo, "requirements.txt"), "utf8")).toBe("Django==5.2.9\n");
	});
});

describe("PyPI candidate discovery", () => {
	it("selects same-major non-yanked stable versions and never follows a repository registry", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						info: { name: "Django" },
						releases: {
							"5.0.0": [{ yanked: false }],
							"5.2.9": [{ yanked: false }],
							"5.3.0": [{ yanked: true }],
							"5.4.0": [],
							"6.0.0": [{ yanked: false }],
							"5.4.0rc1": [{ yanked: false }],
						},
					}),
				),
		);
		const result = await discoverPythonUpdates(snapshot(), fetch);
		expect(result).toEqual({ candidates: [candidate], skipped: [] });
		expect(fetch).toHaveBeenCalledWith("https://pypi.org/pypi/django/json", expect.objectContaining({ redirect: "error" }));
	});
	it("stays in the installed minor for 0.x and preserves unsupported exact pin forms", async () => {
		const input: DependencySnapshot = {
			files: [{ path: "requirements.txt", content: "uvicorn==0.27.0\npackaging==23.2\nother==1.0.0.post1\n" }],
			installed: { uvicorn: "0.27.0", packaging: "23.2", other: "1.0.0.post1" },
		};
		const result = await discoverPythonUpdates(
			input,
			async () =>
				new Response(JSON.stringify({ info: { name: "uvicorn" }, releases: { "0.27.1": [{ yanked: false }], "0.28.0": [{ yanked: false }] } })),
		);
		expect(result.candidates[0].toVersion).toBe("0.27.1");
		expect(result.skipped).toHaveLength(2);
	});
	it("records unavailable, malformed, and mismatched metadata without treating it as no update", async () => {
		for (const fetch of [
			async () => new Response("no", { status: 429 }),
			async () => new Response("{}"),
			async () => new Response(JSON.stringify({ info: { name: "other" }, releases: {} })),
		]) {
			expect(await discoverPythonUpdates(snapshot(), fetch)).toEqual({
				candidates: [],
				skipped: [{ name: "django", reason: "registry_unavailable" }],
			});
		}
		expect((await discoverPythonUpdates({ ...snapshot(), installed: { django: "5.1.0" } }, vi.fn())).skipped[0].reason).toBe("unresolved_version");
	});
});

const auditInventory = { django: "5.0.1", asgiref: "3.7.2" };
const auditResult = {
	dependencies: [
		{ name: "django", version: "5.0.1", vulns: [{ id: "PYSEC-2024-1", fix_versions: ["5.0.2"], aliases: ["CVE-2024-1234"] }] },
		{ name: "asgiref", version: "3.7.2", vulns: [] },
	],
	fixes: [],
};
describe("Python audit evidence", () => {
	it("retains fix versions and unknown severity, without inventing severity from CVE names", () => {
		const report = normalizePythonAudit(JSON.stringify(auditResult), 1, auditInventory, { django: "5.0.1" });
		expect(report).toMatchObject({
			status: "completed",
			findings: [{ id: "PYSEC-2024-1", package: "django", severity: "unknown", direct: true, fixVersions: ["5.0.2"] }],
		});
	});
	it("deduplicates repeated live advisory IDs and conservatively intersects conflicting fix versions", () => {
		const duplicated = {
			dependencies: [
				{
					name: "django",
					version: "5.0.1",
					vulns: [
						{ id: "PYSEC-2026-3717", fix_versions: ["5.2.17", "6.0.8", "6.1.1"] },
						{ id: "PYSEC-2026-3717", fix_versions: ["5.2.17", "6.0.8"] },
						{ id: "PYSEC-2026-3717", fix_versions: ["6.0.8", "5.2.17"] },
						{ id: "PYSEC-2024-28", fix_versions: ["5.0.2"] },
						{ id: "PYSEC-2024-28", fix_versions: ["5.0.2"] },
					],
				},
			],
			fixes: [],
		};
		const report = normalizePythonAudit(JSON.stringify(duplicated), 1, { django: "5.0.1" });
		expect(report.status).toBe("completed");
		expect(report.findings).toHaveLength(2);
		expect(report.findings.find((f) => f.id === "PYSEC-2026-3717")?.fixVersions).toEqual(["5.2.17", "6.0.8"]);
		const conflict = {
			dependencies: [
				{
					name: "pip",
					version: "23.0.1",
					vulns: [
						{ id: "PYSEC-2026-3721", fix_versions: ["26.2"] },
						{ id: "PYSEC-2026-3721", fix_versions: ["26.2.0"] },
					],
				},
			],
			fixes: [],
		};
		expect(normalizePythonAudit(JSON.stringify(conflict), 1, { pip: "23.0.1" }).findings[0].fixVersions).toEqual([]);
	});
	it("never treats skipped, missing, duplicate, truncated, version-mismatched, or exit-inconsistent data as clean", () => {
		const invalid = [
			"{}",
			"{",
			JSON.stringify({ ...auditResult, dependencies: auditResult.dependencies.slice(1) }),
			JSON.stringify({ ...auditResult, dependencies: [...auditResult.dependencies, auditResult.dependencies[0]] }),
			JSON.stringify({ ...auditResult, dependencies: [{ name: "django", skip_reason: "unavailable" }] }),
			JSON.stringify({ ...auditResult, dependencies: [{ ...auditResult.dependencies[0], version: "9.0.0" }, auditResult.dependencies[1]] }),
		];
		for (const text of invalid) expect(normalizePythonAudit(text, 0, auditInventory).status).toBe("unavailable");
		expect(normalizePythonAudit(JSON.stringify(auditResult), 0, auditInventory).status).toBe("unavailable");
		expect(normalizePythonAudit("x".repeat(512001), 0, auditInventory).reason).toBe("output_too_large");
	});
	it("captures audit output outside runner-owned checkout, audits the exact inventory, and uses a separate isolated interpreter", async () => {
		const exec = vi.fn(async (command: string) => ({
			exitCode: command.includes(" -m pip_audit ") || command.includes("'pip_audit'") ? 1 : 0,
			stdout: "",
			stderr: "",
		}));
		const upload = vi.fn(async (_path: string, _data: string | Buffer) => {});
		const sandbox: Sandbox = {
			id: "sbx-test",
			close: vi.fn(),
			exec,
			upload,
			download: vi.fn(async (path: string) => Buffer.from(JSON.stringify(path.includes("inventory") ? auditInventory : auditResult))),
		};
		const result = await auditPythonSandbox(sandbox, { django: "5.0.1" });
		expect(result.status).toBe("completed");
		const command = exec.mock.calls.find(([c]) => c.includes("pip_audit"))?.[0];
		expect(command).toContain("/app/as-runner.sh");
		expect(command).toContain("python-audit-venv/bin/python");
		expect(command).toContain("--disable-pip");
		expect(command).toContain("--no-deps");
		expect(command).toMatch(/> \/opt\/factory\/app\/python-audit-/);
		expect(upload.mock.calls[0][1]).toBe("asgiref==3.7.2\ndjango==5.0.1\n");
	});
});
