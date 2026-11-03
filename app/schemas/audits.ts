import { z } from "zod";

const Package = z.string().regex(/^[A-Za-z0-9@][A-Za-z0-9@/._-]{0,213}$/);
const Version = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.!+_-]{0,99}$/);
export const AuditFinding = z.strictObject({
	id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/),
	package: Package,
	/** npm's report does not identify every installed transitive version. */
	version: Version.nullable(),
	severity: z.enum(["info", "low", "moderate", "high", "critical", "unknown"]),
	direct: z.boolean().nullable(),
	/** Explicit fixes or simple inclusive minimum fixed versions reported by the advisory. */
	fixVersions: z.array(Version).max(10),
});
export type AuditFinding = z.infer<typeof AuditFinding>;
export const AuditReport = z
	.strictObject({
		tool: z.enum(["npm", "yarn1", "pip-audit"]),
		status: z.enum(["completed", "unavailable"]),
		findings: z.array(AuditFinding).max(200),
		reason: z.enum(["execution_failed", "invalid_output", "output_too_large", "unsupported_input"]).optional(),
		scannedAt: z.iso.datetime(),
	})
	.superRefine((r, ctx) => {
		if (new TextEncoder().encode(JSON.stringify(r)).length > 64_000) ctx.addIssue({ code: "custom", message: "Normalized audit exceeds 64 KB" });
		if ((r.status === "completed" && r.reason !== undefined) || (r.status === "unavailable" && (!r.reason || r.findings.length))) {
			ctx.addIssue({
				code: "custom",
				message: "Unavailable audit reports require a reason and cannot claim findings; completed reports cannot have a failure reason",
			});
		}
	});
export type AuditReport = z.infer<typeof AuditReport>;
export const AuditComparison = z
	.strictObject({
		status: z.enum(["passed", "blocked", "unavailable"]),
		fixed: z.array(AuditFinding).max(200),
		remaining: z.array(AuditFinding).max(200),
		introduced: z.array(AuditFinding).max(200),
		blocking: z.array(AuditFinding).max(200),
	})
	.refine((r) => new TextEncoder().encode(JSON.stringify(r)).length <= 128_000, "Audit comparison exceeds 128 KB");
export type AuditComparison = z.infer<typeof AuditComparison>;
