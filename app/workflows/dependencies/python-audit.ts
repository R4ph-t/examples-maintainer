import { randomUUID } from "node:crypto";
import { z } from "zod";
import { APP_DIR, REPO_DIR, shq, type Sandbox } from "../../sandbox/index.js";
import { AuditFinding, AuditReport } from "../../schemas/audits.js";
import { unavailableAudit } from "./audit.js";
import { normalizePythonName } from "./python.js";
import { PYTHON_HELPER } from "./python-files.js";

const MAX_BYTES = 512_000;
const asRunner = (...args: string[]) => `bash ${APP_DIR}/as-runner.sh ${args.map(shq).join(" ")}`;
const Package = z
	.string()
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
	.max(214);
const Version = AuditFinding.shape.fixVersions.element;
const Inventory = z.record(Package, Version).refine((rows) => Object.keys(rows).length > 0 && Object.keys(rows).length <= 500);
const Report = z.object({
	dependencies: z
		.array(
			z.object({
				name: Package,
				version: Version,
				vulns: z
					.array(
						z.object({
							id: AuditFinding.shape.id,
							fix_versions: z.array(Version).max(30),
							aliases: z.array(AuditFinding.shape.id).max(30).optional(),
						}),
					)
					.max(250),
				skip_reason: z.never().optional(),
			}),
		)
		.min(1)
		.max(500),
	fixes: z.array(z.never()).length(0),
});

/** Compare the audit's complete package inventory with the actual target environment, not the audit tool's dependencies. */
export function normalizePythonAudit(
	text: string,
	exitCode: number,
	inventory: Record<string, string>,
	direct: Record<string, string> = {},
): AuditReport {
	if (Buffer.byteLength(text) > MAX_BYTES) return unavailableAudit("pip-audit", "output_too_large");
	try {
		const expected = Inventory.parse(inventory);
		const report = Report.parse(JSON.parse(text));
		const audited = Object.fromEntries(report.dependencies.map((d) => [d.name, d.version]));
		if (
			Object.keys(audited).length !== report.dependencies.length ||
			Object.keys(audited).length !== Object.keys(expected).length ||
			Object.entries(expected).some(([name, version]) => audited[name] !== version)
		)
			throw new Error("Incomplete audit inventory");
		const byAdvisory = new Map<string, AuditFinding>();
		for (const dependency of report.dependencies) {
			for (const vuln of dependency.vulns) {
				const key = `${dependency.name}:${vuln.id}`;
				const fixes = [...new Set(vuln.fix_versions)].sort();
				const existing = byAdvisory.get(key);
				// PyPI can repeat an advisory after alias resolution. Retain the finding once;
				// only fixes agreed by all duplicate records are eligible to guide updates.
				if (existing) existing.fixVersions = existing.fixVersions.filter((version) => fixes.includes(version));
				else
					byAdvisory.set(key, {
						id: vuln.id,
						package: dependency.name,
						version: dependency.version,
						severity: "unknown",
						direct: Object.hasOwn(direct, dependency.name),
						fixVersions: fixes,
					});
			}
		}
		const findings = [...byAdvisory.values()].sort((a, b) => `${a.package}:${a.id}`.localeCompare(`${b.package}:${b.id}`));
		if (![0, 1].includes(exitCode) || (exitCode === 0) !== (findings.length === 0)) throw new Error("Audit exit mismatch");
		return AuditReport.parse({ tool: "pip-audit", status: "completed", findings, scannedAt: new Date().toISOString() });
	} catch {
		return unavailableAudit("pip-audit", "invalid_output");
	}
}

/** A root-owned audit interpreter stays separate from the runner-owned application environment. */
export async function auditPythonSandbox(sandbox: Sandbox, installed: Record<string, string>): Promise<AuditReport> {
	const id = randomUUID();
	const inventoryPath = `${APP_DIR}/python-inventory-${id}.json`;
	const requirementsPath = `${APP_DIR}/python-audit-${id}.txt`;
	const outputPath = `${APP_DIR}/python-audit-${id}.json`;
	const tool = `${APP_DIR}/python-audit-venv`;
	try {
		const snapshot = await sandbox.exec(`timeout -k 2 15 python3 -I -S ${PYTHON_HELPER} inventory ${REPO_DIR} unused ${inventoryPath}`, {
			timeoutMs: 20_000,
		});
		if (snapshot.exitCode !== 0) return unavailableAudit("pip-audit", "unsupported_input");
		const bytes = await sandbox.download(inventoryPath, AbortSignal.timeout(15_000));
		if (bytes.length > MAX_BYTES) return unavailableAudit("pip-audit", "output_too_large");
		const inventory = Inventory.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
		if (Object.entries(installed).some(([name, version]) => inventory[normalizePythonName(name)] !== version))
			return unavailableAudit("pip-audit", "unsupported_input");
		await sandbox.upload(
			requirementsPath,
			`${Object.entries(inventory)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, version]) => `${name}==${version}`)
				.join("\n")}\n`,
		);
		const setup = await sandbox.exec(
			`timeout -k 2 180 bash -c 'cd / && python3 -I -m venv ${tool} && ${tool}/bin/python -I -m pip --isolated install --disable-pip-version-check --no-input --no-cache-dir --only-binary=:all: --index-url https://pypi.org/simple pip-audit==2.10.1 && chmod -R a+rX,go-w ${tool} && chmod 644 ${requirementsPath}'`,
			{ timeoutMs: 190_000 },
		);
		if (setup.exitCode !== 0) return unavailableAudit("pip-audit", "execution_failed");
		const command = asRunner(
			`${tool}/bin/python`,
			"-I",
			"-m",
			"pip_audit",
			"--no-deps",
			"--disable-pip",
			"--format=json",
			"--desc=off",
			"--aliases=on",
			"--progress-spinner=off",
			"--timeout=15",
			"--vulnerability-service=pypi",
			"-r",
			requirementsPath,
		);
		const result = await sandbox.exec(`(umask 077; ulimit -f 512; timeout -k 2 120 ${command} > ${outputPath} 2>/dev/null)`, { timeoutMs: 130_000 });
		if (![0, 1].includes(result.exitCode)) return unavailableAudit("pip-audit", "execution_failed");
		const output = await sandbox.download(outputPath, AbortSignal.timeout(15_000));
		if (output.length > MAX_BYTES) return unavailableAudit("pip-audit", "output_too_large");
		return normalizePythonAudit(new TextDecoder("utf-8", { fatal: true }).decode(output), result.exitCode, inventory, installed);
	} catch {
		return unavailableAudit("pip-audit", "execution_failed");
	} finally {
		await sandbox.exec(`rm -f -- ${inventoryPath} ${requirementsPath} ${outputPath}`, { timeoutMs: 5000 }).catch(() => {});
	}
}
