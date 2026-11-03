import { randomUUID } from "node:crypto";
import { z } from "zod";
import { APP_DIR, shq, type Sandbox } from "../../sandbox/index.js";
import { AuditComparison, AuditFinding, AuditReport } from "../../schemas/audits.js";
import type { DependencyCandidate } from "../../schemas/dependencies.js";

const MAX_BYTES = 512_000;
const severity = z.enum(["info", "low", "moderate", "high", "critical"]);
const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4, unknown: 5 };
const count = z.number().int().min(0).max(100_000);
const counts = z.object({ info: count, low: count, moderate: count, high: count, critical: count });
const npmAdvisory = z.object({
	source: z.number().int().positive(),
	name: AuditFinding.shape.package,
	severity,
	url: z.string().max(1000),
});
const npmVulnerability = z.object({
	name: AuditFinding.shape.package,
	isDirect: z.boolean(),
	severity,
	via: z.array(z.union([npmAdvisory, AuditFinding.shape.package])).max(100),
	fixAvailable: z.union([
		z.boolean(),
		z.object({ name: AuditFinding.shape.package, version: AuditFinding.shape.fixVersions.element, isSemVerMajor: z.boolean() }),
	]),
});
const npmReport = z.object({
	auditReportVersion: z.literal(2),
	vulnerabilities: z.record(AuditFinding.shape.package, npmVulnerability).refine((v) => Object.keys(v).length <= 500),
	metadata: z.object({ vulnerabilities: counts.extend({ total: count }) }),
});
const yarnAdvisory = z.object({
	id: z.number().int().positive(),
	module_name: AuditFinding.shape.package,
	severity,
	url: z.string().max(1000),
	patched_versions: z.string().max(1000),
	findings: z
		.array(z.object({ version: AuditFinding.shape.fixVersions.element }))
		.min(1)
		.max(100),
});

export function unavailableAudit(tool: AuditReport["tool"], reason: NonNullable<AuditReport["reason"]>): AuditReport {
	return AuditReport.parse({ tool, status: "unavailable", reason, findings: [], scannedAt: new Date().toISOString() });
}

/** CLI audit executes unprivileged; the parent shell alone can write the bounded, root-owned result file. */
export async function auditSandbox(sandbox: Sandbox, manager: "npm" | "yarn1", installed: Record<string, string> = {}): Promise<AuditReport> {
	const id = randomUUID();
	const path = `${APP_DIR}/audit-${id}.json`;
	const tool = `${APP_DIR}/audit-tools-${id}`;
	const args =
		manager === "npm"
			? [
					"npm",
					"audit",
					"--json",
					"--audit-level=info",
					"--include=dev",
					"--include=optional",
					"--include=peer",
					"--ignore-scripts",
					"--offline=false",
					"--registry=https://registry.npmjs.org",
					`--userconfig=${tool}/user.npmrc`,
					`--globalconfig=${tool}/global.npmrc`,
					"--loglevel=error",
				]
			: [
					"node",
					`${tool}/node_modules/yarn/bin/yarn.js`,
					"audit",
					"--json",
					"--level=info",
					"--groups",
					"dependencies devDependencies optionalDependencies",
					"--non-interactive",
					"--ignore-path",
					"--no-default-rc",
					"--registry=https://registry.npmjs.org",
				];
	try {
		// Separate empty config paths are required: npm rejects using /dev/null for both user and global config.
		const install =
			manager === "yarn1"
				? `env -i PATH="$PATH" HOME=${tool} npm install --prefix ${tool} --cache ${tool}/cache --userconfig=${tool}/user.npmrc --globalconfig=${tool}/global.npmrc --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund --no-package-lock --no-bin-links yarn@1.22.22 && chmod -R a+rX,go-w ${tool}`
				: "true";
		const setup = await sandbox.exec(
			`timeout -k 2 120 bash -c ${shq(`set -eu; mkdir -m 755 ${tool}; cd ${tool}; : > user.npmrc; : > global.npmrc; chmod 644 user.npmrc global.npmrc; ${install}`)}`,
			{ timeoutMs: 130_000 },
		);
		if (setup.exitCode !== 0) return unavailableAudit(manager, "execution_failed");
		const result = await sandbox.exec(
			`(umask 077; ulimit -f 512; timeout -k 2 120 bash ${APP_DIR}/as-runner.sh ${args.map(shq).join(" ")} > ${path} 2>/dev/null)`,
			{
				timeoutMs: 130_000,
			},
		);
		if ((manager === "npm" && ![0, 1].includes(result.exitCode)) || (manager === "yarn1" && (result.exitCode < 0 || result.exitCode > 31))) {
			return unavailableAudit(manager, "execution_failed");
		}
		const bytes = await sandbox.download(path, AbortSignal.timeout(15_000));
		if (bytes.length > MAX_BYTES) return unavailableAudit(manager, "output_too_large");
		return normalizeAudit(manager, new TextDecoder("utf-8", { fatal: true }).decode(bytes), result.exitCode, installed);
	} catch {
		return unavailableAudit(manager, "execution_failed");
	} finally {
		await sandbox.exec(`rm -f -- ${path}; rm -rf -- ${tool}`, { timeoutMs: 5000 }).catch(() => {});
	}
}

/** Validate both terminal metadata and exit status; a partial JSON-lines stream never means a clean scan. */
export function normalizeAudit(tool: "npm" | "yarn1", text: string, exitCode: number, installed: Record<string, string> = {}): AuditReport {
	if (Buffer.byteLength(text) > MAX_BYTES) return unavailableAudit(tool, "output_too_large");
	try {
		const findings = tool === "npm" ? normalizeNpm(JSON.parse(text), exitCode, installed) : normalizeYarn(text, exitCode, installed);
		return AuditReport.parse({ tool, status: "completed", findings: collapse(findings), scannedAt: new Date().toISOString() });
	} catch {
		return unavailableAudit(tool, "invalid_output");
	}
}

function advisoryId(url: string, source: number): string {
	const match = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(url);
	return match?.[1] ?? `npm:${source}`;
}
function normalizeNpm(raw: unknown, exitCode: number, installed: Record<string, string>): AuditFinding[] {
	if (raw && typeof raw === "object" && "error" in raw) throw new Error("Audit returned an error");
	const r = npmReport.parse(raw);
	const values = Object.values(r.vulnerabilities);
	if (values.length !== r.metadata.vulnerabilities.total || exitCode !== (values.length ? 1 : 0)) throw new Error("Incomplete npm audit");
	const findings: AuditFinding[] = [];
	for (const [name, vulnerability] of Object.entries(r.vulnerabilities)) {
		if (name !== vulnerability.name) throw new Error("Mismatched package");
		for (const via of vulnerability.via) {
			if (typeof via === "string") {
				if (!r.vulnerabilities[via]) throw new Error("Missing transitive advisory");
				continue;
			}
			if (via.name !== name) throw new Error("Mismatched advisory");
			const fix = vulnerability.fixAvailable;
			findings.push({
				id: advisoryId(via.url, via.source),
				package: name,
				version: vulnerability.isDirect ? (installed[name] ?? null) : null,
				severity: via.severity,
				direct: vulnerability.isDirect,
				fixVersions: typeof fix === "object" && fix.name === name ? [fix.version] : [],
			});
		}
	}
	for (const level of ["info", "low", "moderate", "high", "critical"] as const) {
		if (values.filter((v) => v.severity === level).length !== r.metadata.vulnerabilities[level]) throw new Error("Inconsistent audit summary");
	}
	const hasAdvisory = (name: string, seen: Set<string>): boolean => {
		if (seen.has(name)) return false;
		const next = new Set([...seen, name]);
		return r.vulnerabilities[name].via.some((via) => typeof via !== "string" || hasAdvisory(via, next));
	};
	if (values.some((v) => !hasAdvisory(v.name, new Set()))) throw new Error("No concrete advisory for a vulnerability");
	return findings;
}
function normalizeYarn(text: string, exitCode: number, installed: Record<string, string>): AuditFinding[] {
	const lines = text.split(/\r?\n/).filter((line) => line.trim());
	if (lines.length > 2000) throw new Error("Too many events");
	let summary: z.infer<typeof counts> | undefined;
	const findings: AuditFinding[] = [];
	for (const line of lines) {
		const event = z.object({ type: z.string().max(100), data: z.unknown() }).parse(JSON.parse(line));
		if (event.type === "auditSummary") {
			if (summary) throw new Error("Duplicate summary");
			summary = z.object({ vulnerabilities: counts }).parse(event.data).vulnerabilities;
		} else if (event.type === "auditAdvisory") {
			if (summary) throw new Error("Advisory after summary");
			const { advisory } = z.object({ advisory: yarnAdvisory }).parse(event.data);
			const minimum = /^>=\s*(\d+\.\d+\.\d+)$/.exec(advisory.patched_versions)?.[1];
			for (const instance of advisory.findings)
				findings.push({
					id: advisoryId(advisory.url, advisory.id),
					package: advisory.module_name,
					version: instance.version,
					severity: advisory.severity,
					direct: installed[advisory.module_name] === instance.version,
					fixVersions: minimum ? [minimum] : [],
				});
		} else if (!["info", "finished"].includes(event.type)) throw new Error("Unexpected audit event");
	}
	if (!summary) throw new Error("No terminal audit summary");
	const levels = ["info", "low", "moderate", "high", "critical"] as const;
	const mask = levels.reduce((n, level, i) => n + (summary[level] ? 2 ** i : 0), 0);
	if (exitCode !== mask || Boolean(mask) !== Boolean(findings.length)) throw new Error("Incomplete Yarn audit");
	for (const level of levels) {
		if (Boolean(summary[level]) !== findings.some((f) => f.severity === level)) throw new Error("Missing advisory severity");
	}
	return findings;
}

function key(f: AuditFinding): string {
	return `${f.package}\0${f.id}`;
}
function collapse(findings: AuditFinding[]): AuditFinding[] {
	const merged = new Map<string, AuditFinding>();
	for (const raw of findings) {
		const f = AuditFinding.parse(raw);
		const prior = merged.get(key(f));
		if (!prior) merged.set(key(f), f);
		else
			merged.set(key(f), {
				...prior,
				version: prior.version === f.version ? f.version : null,
				severity: severityRank[prior.severity] >= severityRank[f.severity] ? prior.severity : f.severity,
				direct: prior.direct === true || f.direct === true ? true : prior.direct === false && f.direct === false ? false : null,
				fixVersions: [...new Set([...prior.fixVersions, ...f.fixVersions])].sort(),
			});
	}
	return [...merged.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Compare advisory identity, not installed version, so a persisting advisory cannot masquerade as fixed. */
export function compareAuditReports(baselineRaw: unknown, candidateRaw: unknown): AuditComparison {
	const baseline = AuditReport.parse(baselineRaw);
	const candidate = AuditReport.parse(candidateRaw);
	if (baseline.status !== "completed" || candidate.status !== "completed" || baseline.tool !== candidate.tool) {
		return { status: "unavailable", fixed: [], remaining: [], introduced: [], blocking: [] };
	}
	const before = new Map(collapse(baseline.findings).map((f) => [key(f), f]));
	const after = new Map(collapse(candidate.findings).map((f) => [key(f), f]));
	const fixed = [...before.values()].filter((f) => !after.has(key(f)));
	const remaining = [...after.values()].filter((f) => before.has(key(f)));
	const introduced = [...after.values()].filter((f) => !before.has(key(f)));
	const blocking = [...after.values()].filter((f) => {
		const previous = before.get(key(f));
		return severityRank[f.severity] >= severityRank.high && (!previous || severityRank[f.severity] > severityRank[previous.severity]);
	});
	return AuditComparison.parse({ status: blocking.length ? "blocked" : "passed", fixed, remaining, introduced, blocking });
}

/** Advisory-backed priority only; a suggested fixed version is not proof until the candidate is re-audited. */
export function prioritizeCandidates(candidates: DependencyCandidate[], raw: unknown): DependencyCandidate[] {
	const audit = AuditReport.parse(raw);
	if (audit.status !== "completed") return [...candidates];
	const score = (candidate: DependencyCandidate) =>
		audit.findings
			.filter((f) => f.package === candidate.name && f.direct === true)
			.reduce((n, f) => {
				const fixed = f.fixVersions.some((v) => v === candidate.toVersion);
				return Math.max(n, (fixed ? 100 : 10) + severityRank[f.severity]);
			}, 0);
	return candidates
		.map((candidate, index) => ({ candidate, index, score: score(candidate) }))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((v) => v.candidate);
}
