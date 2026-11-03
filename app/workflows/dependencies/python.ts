import { z } from "zod";
import { DependencyCandidate, DependencyDiscovery, DependencySnapshot } from "../../schemas/index.js";

const NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const PIN = "(?:0|[1-9]\\d*)(?:\\.(?:0|[1-9]\\d*)){1,2}(?:\\.post(?:0|[1-9]\\d*))?";
const LINE = new RegExp(`^([ \\t]*)(${NAME})(\\[(?:${NAME})(?:,${NAME})*\\])?([ \\t]*==[ \\t]*)(${PIN})([ \\t]*(?:#.*)?)$`);
export const normalizePythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
export interface PythonRequirement {
	name: string;
	version: string;
	line: number;
}
/** A deliberately narrow requirements format: exact pins, optional extras, comments, and blank lines. */
export function parsePythonRequirements(content: string): PythonRequirement[] {
	if (Buffer.byteLength(content) > 180_000 || content.includes("\0")) throw new Error("Invalid requirements content");
	const requirements: PythonRequirement[] = [];
	for (const [line, text] of content.split(/\r?\n/).entries()) {
		if (/^\s*(?:#.*)?$/.test(text)) continue;
		const match = LINE.exec(text);
		if (!match || match[2].length > 214 || match[5].length > 50) throw new Error("Only exact public package pins are supported");
		requirements.push({ name: normalizePythonName(match[2]), version: match[5], line });
	}
	if (!requirements.length || requirements.length > 40 || new Set(requirements.map((r) => r.name)).size !== requirements.length)
		throw new Error("Unsupported requirements layout");
	return requirements;
}

function requirementsContent(raw: unknown): string {
	const snapshot = DependencySnapshot.parse(raw);
	if (snapshot.files.length !== 1 || snapshot.files[0].path !== "requirements.txt") throw new Error("Unexpected Python artifact paths");
	parsePythonRequirements(snapshot.files[0].content);
	return snapshot.files[0].content;
}

export function validatePythonChange(candidate: DependencyCandidate, before: unknown, after: unknown): void {
	DependencyCandidate.parse(candidate);
	const original = requirementsContent(before);
	const proposed = requirementsContent(after);
	if (candidate.section !== "requirements" || candidate.name !== normalizePythonName(candidate.name)) throw new Error("Invalid Python candidate");
	const row = parsePythonRequirements(original).find((r) => r.name === candidate.name);
	if (!row || candidate.fromRange !== `==${row.version}` || candidate.fromVersion !== row.version || candidate.toRange !== `==${candidate.toVersion}`)
		throw new Error("Requirements base mismatch");
	const lines = original.split(/(?<=\n)/);
	const line = lines[row.line];
	const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
	lines[row.line] =
		line
			.replace(/\r?\n$/, "")
			.replace(
				LINE,
				(_all, space, name, extras, equals, _version, suffix) => `${space}${name}${extras ?? ""}${equals}${candidate.toVersion}${suffix}`,
			) + newline;
	if (lines.join("") !== proposed) throw new Error("Update changed unrelated requirement content");
}

const stable = (s: string) => {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(s)) return null;
	const parts = s.split(".").map(Number);
	return parts.every(Number.isSafeInteger) ? parts : null;
};
const newer = (a: number[], b: number[]) => a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
const Metadata = z.object({
	info: z.object({ name: z.string().max(214) }),
	releases: z.record(z.string().max(100), z.array(z.object({ yanked: z.boolean() })).max(1000)),
});

/** Public metadata only; no package code is installed or imported by the controller. */
export async function discoverPythonUpdates(raw: DependencySnapshot, fetchImpl: typeof fetch = fetch): Promise<DependencyDiscovery> {
	const snapshot = DependencySnapshot.parse(raw);
	const requirements = parsePythonRequirements(requirementsContent(snapshot)).sort((a, b) => a.name.localeCompare(b.name));
	const candidates: DependencyCandidate[] = [];
	const skipped: DependencyDiscovery["skipped"] = [];
	for (const { name, version } of requirements) {
		const current = stable(version);
		if (!current) {
			skipped.push({ name, reason: "unsupported_range" });
			continue;
		}
		if (snapshot.installed[name] !== version) {
			skipped.push({ name, reason: "unresolved_version" });
			continue;
		}
		try {
			const response = await fetchImpl(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
				headers: { Accept: "application/json" },
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok || !response.body) throw new Error("PyPI unavailable");
			let size = 0;
			const chunks: Uint8Array[] = [];
			for await (const chunk of response.body) {
				size += chunk.length;
				if (size > 16 * 1024 * 1024) throw new Error("PyPI metadata too large");
				chunks.push(chunk);
			}
			const metadata = Metadata.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			if (normalizePythonName(metadata.info.name) !== name) throw new Error("PyPI identity mismatch");
			let selected = version;
			let parts = current;
			for (const [release, files] of Object.entries(metadata.releases)) {
				const candidate = stable(release);
				if (
					!candidate ||
					!files.length ||
					files.some((f) => f.yanked) ||
					candidate[0] !== current[0] ||
					(current[0] === 0 && candidate[1] !== current[1])
				)
					continue;
				if (newer(candidate, parts)) {
					selected = release;
					parts = candidate;
				}
			}
			if (selected !== version)
				candidates.push(
					DependencyCandidate.parse({
						name,
						section: "requirements",
						fromRange: `==${version}`,
						fromVersion: version,
						toRange: `==${selected}`,
						toVersion: selected,
						kind: parts[1] === current[1] ? "patch" : "minor",
					}),
				);
		} catch {
			skipped.push({ name, reason: "registry_unavailable" });
		}
	}
	return DependencyDiscovery.parse({ candidates, skipped });
}
