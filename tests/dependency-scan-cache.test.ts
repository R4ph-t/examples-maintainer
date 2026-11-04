import { SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import { describe, expect, it, vi } from "vitest";
import { requireRepo } from "../app/config/index.js";
import { APP_DIR, type Sandbox } from "../app/sandbox/index.js";
import {
	SCAN_CACHE_MAX_AGE_MS,
	type PreparedScanOptions,
	type ScanCacheDeps,
	withPreparedScanSandbox,
} from "../app/workflows/dependencies/scan-cache.js";
import { REPO } from "./fixtures/config.js";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const KEY = "a".repeat(64);
const SHA = "1".repeat(40);
const INSTALLED = "b".repeat(64);
const MANIFEST_PATH = `${APP_DIR}/scan-cache.json`;
const manifest = () => ({
	version: 1,
	key: KEY,
	repo: REPO,
	sha: SHA,
	installedHash: INSTALLED,
	createdAt: new Date(NOW - 60_000).toISOString(),
	expiresAt: new Date(NOW + 60_000).toISOString(),
});

function fakeSandbox(id: string) {
	const files = new Map<string, Buffer>();
	const sandbox = {
		id,
		exec: vi.fn<Sandbox["exec"]>(async (command) => ({ exitCode: 0, stdout: command === "git rev-parse HEAD" ? SHA : "", stderr: "" })),
		upload: vi.fn<Sandbox["upload"]>(async (path, data) => {
			files.set(path, Buffer.from(data));
		}),
		download: vi.fn<Sandbox["download"]>(async (path) => {
			const value = files.get(path);
			if (!value) throw new Error("Missing file");
			return value;
		}),
		close: vi.fn<Sandbox["close"]>(async () => {}),
	} satisfies Sandbox;
	return { sandbox, files };
}

function world() {
	const cold = fakeSandbox("sbx-cold");
	const warm = fakeSandbox("sbx-warm");
	warm.files.set(MANIFEST_PATH, Buffer.from(JSON.stringify(manifest())));
	const opts = {
		key: KEY,
		sha: SHA,
		publicCheckout: true,
		prepare: vi.fn<PreparedScanOptions["prepare"]>(async () => {}),
		inspect: vi.fn<PreparedScanOptions["inspect"]>(async () => INSTALLED),
		onCache: vi.fn<NonNullable<PreparedScanOptions["onCache"]>>(),
		onSandbox: vi.fn<NonNullable<PreparedScanOptions["onSandbox"]>>(),
		onCleanup: vi.fn<NonNullable<PreparedScanOptions["onCleanup"]>>(),
	} satisfies PreparedScanOptions;
	const deps = {
		openFresh: vi.fn<NonNullable<ScanCacheDeps["openFresh"]>>(async () => cold.sandbox),
		openSnapshot: vi.fn<NonNullable<ScanCacheDeps["openSnapshot"]>>(async () => warm.sandbox),
		waitRunning: vi.fn<NonNullable<ScanCacheDeps["waitRunning"]>>(async () => {}),
		capture: vi.fn<NonNullable<ScanCacheDeps["capture"]>>(async (_id, _name, expiresAt) => ({ id: "snp-prepared", expiresAt })),
		now: () => NOW,
	} satisfies ScanCacheDeps;
	const use = vi.fn(async (s: Sandbox) => ({ audited: s.id }));
	const run = () => withPreparedScanSandbox(requireRepo(REPO, 0), opts, use, deps);
	return { cold, warm, opts, deps, use, run };
}

describe("prepared scan cache", () => {
	it("reuses only matching installed state in a new sandbox and still performs the scan", async () => {
		const w = world();
		expect(await w.run()).toEqual({ audited: "sbx-warm" });
		expect(w.opts.prepare).not.toHaveBeenCalled();
		expect(w.deps.capture).not.toHaveBeenCalled();
		expect(w.opts.onCache).toHaveBeenCalledWith(expect.objectContaining({ status: "hit", key: KEY }));
		expect(w.opts.onSandbox).toHaveBeenCalledWith("sbx-warm");
		expect(w.warm.sandbox.close).toHaveBeenCalledOnce();
		expect(w.opts.onCleanup).toHaveBeenCalledWith(true);
	});

	it("captures prepared state before any audit with a bounded provider expiration", async () => {
		const w = world();
		w.deps.openSnapshot.mockRejectedValue(new SandboxSnapshotNotFoundError("missing", 404));
		w.use.mockImplementation(async (s) => {
			expect(w.deps.capture).toHaveBeenCalledOnce();
			const saved = JSON.parse(w.cold.files.get(MANIFEST_PATH)?.toString() ?? "null");
			expect(saved).toMatchObject({ key: KEY, repo: REPO, sha: SHA, installedHash: INSTALLED });
			expect(Date.parse(saved.expiresAt) - Date.parse(saved.createdAt)).toBe(SCAN_CACHE_MAX_AGE_MS);
			return { audited: s.id };
		});
		expect(await w.run()).toEqual({ audited: "sbx-cold" });
		expect(w.opts.onCache).toHaveBeenCalledWith(expect.objectContaining({ status: "created", snapshotId: "snp-prepared" }));
		expect(w.deps.capture).toHaveBeenCalledWith(
			"sbx-cold",
			expect.stringMatching(/^scan-[a-f0-9]{59}$/),
			new Date(NOW + SCAN_CACHE_MAX_AGE_MS).toISOString(),
		);
		expect(w.cold.sandbox.close).toHaveBeenCalledOnce();
	});

	it("retains prepared state across the six-hour scan interval", async () => {
		const w = world();
		const created = NOW - 6 * 3600_000;
		w.warm.files.set(
			MANIFEST_PATH,
			Buffer.from(
				JSON.stringify({
					...manifest(),
					createdAt: new Date(created).toISOString(),
					expiresAt: new Date(created + SCAN_CACHE_MAX_AGE_MS).toISOString(),
				}),
			),
		);
		expect(await w.run()).toEqual({ audited: "sbx-warm" });
		expect(w.opts.prepare).not.toHaveBeenCalled();
	});

	it("terminates an expired restore before preparing a new cold snapshot", async () => {
		const w = world();
		w.warm.files.set(
			MANIFEST_PATH,
			Buffer.from(JSON.stringify({ ...manifest(), createdAt: new Date(NOW - 120_000).toISOString(), expiresAt: new Date(NOW - 1).toISOString() })),
		);
		w.deps.openFresh.mockImplementation(async () => {
			expect(w.warm.sandbox.close).toHaveBeenCalledOnce();
			return w.cold.sandbox;
		});
		expect(await w.run()).toEqual({ audited: "sbx-cold" });
		expect(w.use).toHaveBeenCalledOnce();
	});

	it.each(["key", "repo", "sha", "installed", "malformed", "future", "extended"])(
		"rejects %s mismatch before running audit and always cleans up",
		async (kind) => {
			const w = world();
			const saved = manifest();
			if (kind === "key") saved.key = "c".repeat(64);
			if (kind === "repo") saved.repo = "other/repo";
			if (kind === "sha") saved.sha = "2".repeat(40);
			if (kind === "installed") w.opts.inspect.mockResolvedValue("c".repeat(64));
			if (kind === "future") saved.createdAt = new Date(NOW + 30_000).toISOString();
			if (kind === "extended") saved.expiresAt = new Date(NOW + SCAN_CACHE_MAX_AGE_MS).toISOString();
			w.warm.files.set(MANIFEST_PATH, Buffer.from(kind === "malformed" ? "{}" : JSON.stringify(saved)));
			await expect(w.run()).rejects.toThrow();
			expect(w.use).not.toHaveBeenCalled();
			expect(w.deps.openFresh).not.toHaveBeenCalled();
			expect(w.warm.sandbox.close).toHaveBeenCalledOnce();
		},
	);

	it("does not create a replacement after an ambiguous restore transport failure", async () => {
		const w = world();
		w.deps.openSnapshot.mockRejectedValue(new Error("Response lost"));
		await expect(w.run()).rejects.toThrow("Response lost");
		expect(w.deps.openFresh).not.toHaveBeenCalled();
		expect(w.use).not.toHaveBeenCalled();
	});

	it("continues scanning after an optional capture failure without retrying the mutation", async () => {
		const w = world();
		w.deps.openSnapshot.mockRejectedValue(new SandboxSnapshotNotFoundError("missing", 404));
		w.deps.capture.mockRejectedValue(new Error("Capture response lost"));
		expect(await w.run()).toEqual({ audited: "sbx-cold" });
		expect(w.deps.capture).toHaveBeenCalledOnce();
		expect(w.opts.onCache).toHaveBeenCalledWith({ status: "unavailable", key: KEY });
		expect(w.cold.sandbox.close).toHaveBeenCalledOnce();
	});

	it("rejects malformed provider capture metadata without failing the fresh audit", async () => {
		const w = world();
		w.deps.openSnapshot.mockRejectedValue(new SandboxSnapshotNotFoundError("missing", 404));
		w.deps.capture.mockResolvedValue({ id: "snp-prepared", expiresAt: "invalid" });
		expect(await w.run()).toEqual({ audited: "sbx-cold" });
		expect(w.opts.onCache).toHaveBeenCalledWith({ status: "unavailable", key: KEY });
	});

	it("rejects a restored checkout whose actual revision differs from the manifest", async () => {
		const w = world();
		w.warm.sandbox.exec.mockResolvedValue({ exitCode: 0, stdout: "2".repeat(40), stderr: "" });
		await expect(w.run()).rejects.toThrow("source revision mismatch");
		expect(w.use).not.toHaveBeenCalled();
		expect(w.warm.sandbox.close).toHaveBeenCalledOnce();
	});

	it("never captures or restores a credentialed App checkout", async () => {
		const w = world();
		expect(await withPreparedScanSandbox(requireRepo(REPO, 0), { ...w.opts, publicCheckout: false }, w.use, w.deps)).toEqual({ audited: "sbx-cold" });
		expect(w.deps.openSnapshot).not.toHaveBeenCalled();
		expect(w.deps.capture).not.toHaveBeenCalled();
		expect(w.opts.onCache).toHaveBeenCalledWith({ status: "disabled", key: KEY });
	});

	it("does not hide failed cleanup of an expired restored sandbox behind a cold retry", async () => {
		const w = world();
		w.warm.files.set(MANIFEST_PATH, Buffer.from(JSON.stringify({ ...manifest(), expiresAt: new Date(NOW - 1).toISOString() })));
		w.warm.sandbox.close.mockRejectedValue(new Error("Termination unconfirmed"));
		await expect(w.run()).rejects.toThrow("cleanup is unconfirmed");
		expect(w.deps.openFresh).not.toHaveBeenCalled();
		expect(w.opts.onCleanup).toHaveBeenCalledWith(false);
	});
});
