import { z } from "zod";
import { DependencyCandidate, DependencyDiscovery, DependencyName, type DependencySnapshot, StableVersion } from "../../schemas/index.js";

const Manifest = z.object({
	dependencies: z.record(DependencyName, z.string().max(100)).default({}),
	devDependencies: z.record(DependencyName, z.string().max(100)).default({}),
	workspaces: z.unknown().optional(),
});
const version = (v: string) => {
	if (!StableVersion.safeParse(v).success) return null;
	const parts = v.split(".").map(Number);
	return parts.every(Number.isSafeInteger) ? parts : null;
};
const newer = (a: number[], b: number[]) => a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));

/** The first phase supports only ordinary stable exact, caret, or tilde declarations. */
export async function discoverUpdates(snapshot: DependencySnapshot, fetchImpl: typeof fetch = fetch): Promise<DependencyDiscovery> {
	const manifest = Manifest.parse(JSON.parse(snapshot.files.find((f) => f.path === "package.json")?.content ?? "null"));
	if (manifest.workspaces !== undefined) throw new Error("Workspaces require a dedicated recipe");
	const entries = (["dependencies", "devDependencies"] as const).flatMap((section) =>
		Object.entries(manifest[section])
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, range]) => ({ section, name, range })),
	);
	if (entries.length > 40 || new Set(entries.map((e) => e.name)).size !== entries.length) throw new Error("Unsupported dependency layout");
	const candidates: DependencyCandidate[] = [];
	const skipped: DependencyDiscovery["skipped"] = [];
	for (const { section, name, range } of entries) {
		const match = /^(\^|~)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(range);
		if (!match) {
			skipped.push({ name, reason: "unsupported_range" });
			continue;
		}
		const fromVersion = snapshot.installed[name];
		const current = fromVersion ? version(fromVersion) : null;
		if (!current) {
			skipped.push({ name, reason: "unresolved_version" });
			continue;
		}
		try {
			// Public registry metadata only. No credential provider or repository-controlled URL is used.
			const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
				headers: { Accept: "application/vnd.npm.install-v1+json" },
				signal: AbortSignal.timeout(15_000),
				redirect: "error",
			});
			if (!response.ok || !response.body) throw new Error("Registry unavailable");
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const chunk of response.body) {
				size += chunk.length;
				if (size > 16 * 1024 * 1024) throw new Error("Registry response too large");
				chunks.push(chunk);
			}
			const metadata = z
				.object({ versions: z.record(z.string(), z.object({ deprecated: z.string().optional() })) })
				.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			let selected = fromVersion;
			let selectedParts = current;
			for (const [v, info] of Object.entries(metadata.versions)) {
				const parts = version(v);
				if (!parts || info.deprecated || parts[0] !== current[0] || (parts[0] === 0 && parts[1] !== current[1])) continue;
				if (newer(parts, selectedParts)) {
					selected = v;
					selectedParts = parts;
				}
			}
			if (selected !== fromVersion)
				candidates.push(
					DependencyCandidate.parse({
						name,
						section,
						fromRange: range,
						fromVersion,
						toVersion: selected,
						toRange: `${match[1] ?? ""}${selected}`,
						kind: selectedParts[1] === current[1] ? "patch" : "minor",
					}),
				);
		} catch {
			skipped.push({ name, reason: "registry_unavailable" });
		}
	}
	return DependencyDiscovery.parse({ candidates, skipped });
}
