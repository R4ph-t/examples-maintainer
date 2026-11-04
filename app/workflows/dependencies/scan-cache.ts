import { setTimeout as sleep } from "node:timers/promises";
import { SandboxSnapshotNotFoundError, SandboxSnapshotNotReadyError } from "@renderinc/sdk";
import { z } from "zod";
import type { RepoContext } from "../../config/index.js";
import { APP_DIR, openFreshSandbox, openSnapshotSandbox, type Sandbox, type SandboxClient, sandboxClient, withSandbox } from "../../sandbox/index.js";

/** Provider-default images are mutable: reuse lasts at most 24 hours, never an immutability guarantee. */
export const SCAN_CACHE_MAX_AGE_MS = 24 * 3600_000;
const MANIFEST_PATH = `${APP_DIR}/scan-cache.json`;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Manifest = z.strictObject({
	version: z.literal(1),
	key: Hash,
	repo: z.string().min(1).max(200),
	sha: z.string().regex(/^[a-f0-9]{40}$/),
	installedHash: Hash,
	createdAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
});

export interface ScanCacheReceipt {
	status: "hit" | "created" | "disabled" | "unavailable";
	key: string;
	snapshotId?: string;
	createdAt?: string;
	expiresAt?: string;
}

export interface PreparedScanOptions {
	/** Includes exact repository/source, recipe, egress, adapter, and bootstrap identities. */
	key: string;
	sha: string;
	/** Only credential-free public checkout preparation is eligible for capture. */
	publicCheckout: boolean;
	prepare: (sandbox: Sandbox) => Promise<void>;
	/** Hash of dependency files and installed inventory; must be recomputed after restore. */
	inspect: (sandbox: Sandbox) => Promise<string>;
	onSandbox?: (sandboxId: string) => void;
	onCache?: (receipt: ScanCacheReceipt) => void;
	onCleanup?: (closed: boolean) => void;
}

export interface ScanCacheDeps {
	client?: SandboxClient;
	openFresh?: (repo: RepoContext) => Promise<Sandbox>;
	openSnapshot?: (repo: RepoContext, name: string) => Promise<Sandbox>;
	waitRunning?: (sandboxId: string) => Promise<void>;
	capture?: (sandboxId: string, name: string, expiresAt: string) => Promise<{ id: string; expiresAt: string }>;
	now?: () => number;
}

/** Only scan environments are cached. The full baseline/candidate verification never calls this path. */
export async function withPreparedScanSandbox<T>(
	repo: RepoContext,
	options: PreparedScanOptions,
	use: (sandbox: Sandbox) => Promise<T>,
	deps: ScanCacheDeps = {},
): Promise<T> {
	Hash.parse(options.key);
	Manifest.shape.sha.parse(options.sha);
	const now = deps.now ?? Date.now;
	const name = `scan-${options.key.slice(0, 59)}`;
	let client: SandboxClient | undefined;
	const getClient = () => (client ??= deps.client ?? sandboxClient());
	const onCleanup = (closed: boolean) => options.onCleanup?.(closed);
	if (options.publicCheckout) {
		let restored: { result: T } | { expired: true } | undefined;
		let closed = false;
		let opened = false;
		try {
			restored = await withSandbox(
				async () => {
					const sandbox = await (deps.openSnapshot ? deps.openSnapshot(repo, name) : openSnapshotSandbox(repo, name, getClient()));
					opened = true;
					return sandbox;
				},
				async (sandbox) => {
					options.onSandbox?.(sandbox.id);
					await (deps.waitRunning ? deps.waitRunning(sandbox.id) : getClient().waitRunning(sandbox.id));
					const bytes = await sandbox.download(MANIFEST_PATH);
					if (bytes.length > 4096) throw new Error("Scan cache manifest is too large");
					const manifest = Manifest.parse(JSON.parse(bytes.toString("utf8")));
					if (manifest.key !== options.key || manifest.repo !== repo.fullName || manifest.sha !== options.sha)
						throw new Error("Scan cache identity mismatch");
					const created = Date.parse(manifest.createdAt);
					const expiry = Date.parse(manifest.expiresAt);
					if (created > now() || expiry <= created || expiry - created > SCAN_CACHE_MAX_AGE_MS) throw new Error("Invalid scan cache lifetime");
					if (expiry <= now()) return { expired: true as const };
					await assertCommit(sandbox, options.sha);
					if (Hash.parse(await options.inspect(sandbox)) !== manifest.installedHash) throw new Error("Scan cache dependency state mismatch");
					options.onCache?.({ status: "hit", key: options.key, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt });
					return { result: await use(sandbox) };
				},
				(value) => {
					closed = value;
					onCleanup(value);
				},
			);
		} catch (error) {
			// Only an explicit provider rejection before create is safe to replace with a cold sandbox.
			if (opened || !(error instanceof SandboxSnapshotNotFoundError || error instanceof SandboxSnapshotNotReadyError)) throw error;
		}
		if (restored && "result" in restored) return restored.result;
		if (restored && !closed) throw new Error("Expired scan cache cleanup is unconfirmed");
	}

	return withSandbox(
		() => (deps.openFresh ? deps.openFresh(repo) : openFreshSandbox(repo, getClient())),
		async (sandbox) => {
			options.onSandbox?.(sandbox.id);
			await options.prepare(sandbox);
			await assertCommit(sandbox, options.sha);
			if (!options.publicCheckout) options.onCache?.({ status: "disabled", key: options.key });
			else {
				const manifest = Manifest.parse({
					version: 1,
					key: options.key,
					repo: repo.fullName,
					sha: options.sha,
					installedHash: await options.inspect(sandbox),
					createdAt: new Date(now()).toISOString(),
					expiresAt: new Date(now() + SCAN_CACHE_MAX_AGE_MS).toISOString(),
				});
				try {
					// Public preparation never stages a GitHub credential. Filesystem snapshots omit process memory.
					await sandbox.upload(MANIFEST_PATH, JSON.stringify(manifest));
					const locked = await sandbox.exec(`chown root:root ${MANIFEST_PATH} && chmod 644 ${MANIFEST_PATH}`, { timeoutMs: 10_000 });
					if (locked.exitCode !== 0) throw new Error("Scan cache manifest was not locked down");
					const captured = await (deps.capture
						? deps.capture(sandbox.id, name, manifest.expiresAt)
						: capture(getClient(), sandbox.id, name, manifest.expiresAt));
					const snapshot = z.strictObject({ id: z.string().min(1).max(200), expiresAt: z.iso.datetime() }).parse(captured);
					if (Date.parse(snapshot.expiresAt) > Date.parse(manifest.expiresAt) || Date.parse(snapshot.expiresAt) <= now())
						throw new Error("Provider scan cache lifetime mismatch");
					options.onCache?.({
						status: "created",
						key: options.key,
						snapshotId: snapshot.id,
						createdAt: manifest.createdAt,
						expiresAt: snapshot.expiresAt,
					});
				} catch {
					// Cache is optional performance state; an unconfirmed capture never authorizes reuse or a retry.
					options.onCache?.({ status: "unavailable", key: options.key });
				}
			}
			return use(sandbox);
		},
		onCleanup,
	);
}

async function assertCommit(sandbox: Sandbox, sha: string) {
	const result = await sandbox.exec("git rev-parse HEAD", { asRunner: true, timeoutMs: 10_000 });
	if (result.exitCode !== 0 || result.stdout.trim() !== sha) throw new Error("Scan cache source revision mismatch");
}

async function capture(client: SandboxClient, sandboxId: string, name: string, expiresAt: string) {
	let snapshot = await client.call(() => client.api.snapshots.create({ sandboxId, name, kind: "filesystem", expiresAt }));
	const deadline = Date.now() + Math.min(client.t.snapshotTimeoutMs, 120_000);
	while (snapshot.status === "creating") {
		if (Date.now() >= deadline) throw new Error("Scan cache capture remains unconfirmed");
		await sleep(client.t.pollMs);
		const { sandboxGroupId, id: snapshotId } = snapshot;
		snapshot = await client.call(() => client.api.snapshots.get({ sandboxGroupId, snapshotId }), { retryOn: [429, 503] });
	}
	if (snapshot.status !== "available" || snapshot.name !== name || snapshot.sourceSandboxId !== sandboxId || snapshot.kind !== "filesystem")
		throw new Error("Scan cache capture identity mismatch");
	return { id: snapshot.id, expiresAt: snapshot.expiresAt };
}
