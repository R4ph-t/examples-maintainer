/** What the factory needs from GitHub and from each service's environment, in one place for setup and doctor. */
import { AGENTS } from "../../app/agents/registry.js";
import { config } from "../../app/config/index.js";
import { WORKING_LABEL } from "../../app/claims/status.js";

/**
 * Repository permissions the App requests. Each is used by app/:
 * - contents: write — Git Data API publishing (blobs, trees, commits, refs) and read-only clone tokens.
 * - issues: write — comments, status labels, the label timeline, and creating labels.
 * - pull_requests: write — opening draft PRs, reading diffs and files, posting COMMENT reviews.
 * - checks: write — commit-bound example maintenance results.
 * - metadata: read — collaborator permission checks; GitHub grants it to every App.
 * No `workflows` permission: publishing refuses changes under .github/workflows.
 */
export const REQUIRED_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
	contents: "write",
	checks: "write",
	issues: "write",
	pull_requests: "write",
	metadata: "read",
};

/** Webhook events the gateway routes (app/gateway/routes.ts). */
export const REQUIRED_EVENTS: readonly string[] = ["issues", "issue_comment", "pull_request", "push"];

export const WEBHOOK_PATH = "/webhooks/github";

export interface LabelSpec {
	name: string;
	color: string;
	description: string;
	/** A trigger label must exist so people can apply it; the working label is created on demand. */
	trigger: boolean;
}

export const LABELS: readonly LabelSpec[] = [
	{
		name: config.labels.triage,
		color: "1d76db",
		description: "software-factory: triage this issue and draft a spec",
		trigger: true,
	},
	{
		name: config.labels.specApproved,
		color: "0e8a16",
		description: "software-factory: implement the approved spec and open a draft PR",
		trigger: true,
	},
	{
		name: config.labels.prReview,
		color: "5319e7",
		description: "software-factory: review this pull request",
		trigger: true,
	},
	{
		name: config.labels.autopilot,
		color: "c5def5",
		description: "software-factory: run through a reviewed draft pull request",
		trigger: true,
	},
	{ name: WORKING_LABEL, color: "fbca04", description: "software-factory is working on this", trigger: false },
];

export type Service = "gateway" | "workflows" | "maintenance";

/** The credential each agent's harness declares (app/agents/), once each, in agent order. Workflows sends them to its sandboxes. */
export const HARNESS_KEY_ENV: readonly string[] = [...new Set(AGENTS.map((agent) => agent.harness.credential))];

/** Required env vars, exactly as render.yaml declares them. Optional integrations are listed in SERVICE_OPTIONAL_ENV. */
export const SERVICE_ENV: Readonly<Record<Service, readonly string[]>> = {
	gateway: ["GITHUB_WEBHOOK_SECRET", "RENDER_API_KEY", "RENDER_WORKFLOW_SLUG"],
	workflows: ["RENDER_API_KEY", "RENDER_WORKSPACE_ID", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", ...HARNESS_KEY_ENV],
	maintenance: ["RENDER_API_KEY", "RENDER_WORKSPACE_ID", "MAINTENANCE_MODE"],
};

export interface EnvGroupSpec {
	name: string;
	/** The services whose render.yaml entry links the group with `fromGroup`. */
	services: readonly Service[];
	keys: readonly string[];
}

/**
 * The environment groups setup:render creates from .env and render.yaml links. Each service gets every key in
 * SERVICE_ENV from these except RENDER_WORKFLOW_SLUG, which the Blueprint wires from the Workflows service.
 * The gateway links no group that holds GitHub App credentials or a model key.
 */
export const ENV_GROUPS: readonly EnvGroupSpec[] = [
	{ name: "software-factory-shared", services: ["gateway", "workflows"], keys: ["RENDER_API_KEY"] },
	{ name: "software-factory-gateway", services: ["gateway"], keys: ["GITHUB_WEBHOOK_SECRET"] },
	{
		name: "software-factory-workflows",
		services: ["workflows"],
		keys: ["RENDER_WORKSPACE_ID", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", ...HARNESS_KEY_ENV],
	},
];

/** Standalone scheduled maintenance deployment; never linked to the webhook gateway. */
export const MAINTENANCE_ENV_GROUPS: readonly EnvGroupSpec[] = [
	{ name: "examples-maintainer", services: ["maintenance"], keys: SERVICE_ENV.maintenance },
];
/** Setup manages configuration only. The dedicated scoped runtime key is installed separately in the Dashboard. */
export const MAINTENANCE_SETUP_GROUPS: readonly EnvGroupSpec[] = MAINTENANCE_ENV_GROUPS.map((group) => ({
	...group,
	keys: group.keys.filter((key) => key !== "RENDER_API_KEY"),
}));
/** Optional future write mode. Never link this group to public-mode services. */
export const MAINTENANCE_PAT_ENV_GROUP: EnvGroupSpec = {
	name: "examples-maintainer-github",
	services: ["maintenance"],
	keys: ["MAINTENANCE_GITHUB_TOKEN", "MAINTENANCE_PUBLISH_DRAFTS"],
};

/** Optional retention integration. Kept separate from required setup keys until activated. */
export const MAINTENANCE_HISTORY_ENV = [
	"MAINTENANCE_CATALOG_PATH",
	"MAINTENANCE_CATALOG_DIGEST",
	"MAINTENANCE_WORKFLOW_ID",
	"MAINTENANCE_HISTORY_URL",
	"MAINTENANCE_HISTORY_TOKEN",
] as const;
export const SERVICE_OPTIONAL_ENV: Readonly<Partial<Record<Service, readonly string[]>>> = { maintenance: MAINTENANCE_HISTORY_ENV };
export const MAINTENANCE_HISTORY_ENV_GROUP: EnvGroupSpec = {
	name: "examples-maintainer-history",
	services: ["maintenance"],
	keys: MAINTENANCE_HISTORY_ENV,
};

/** The group a service reads `key` from, if any. */
export function envGroupFor(service: Service, key: string): EnvGroupSpec | undefined {
	return [...ENV_GROUPS, ...MAINTENANCE_ENV_GROUPS, MAINTENANCE_HISTORY_ENV_GROUP].find(
		(group) => group.services.includes(service) && group.keys.includes(key),
	);
}

/** Values doctor must never print. */
export const SECRET_ENV: readonly string[] = [
	"MAINTENANCE_HISTORY_TOKEN",
	"GITHUB_WEBHOOK_SECRET",
	"RENDER_API_KEY",
	"GITHUB_APP_PRIVATE_KEY",
	"MAINTENANCE_GITHUB_TOKEN",
];

const LEVELS = ["none", "read", "write", "admin"];

/** Required permissions the granted set lacks, as "name:level" strings. */
export function missingPermissions(granted: Record<string, string> | undefined): string[] {
	const have = granted ?? {};
	return Object.entries(REQUIRED_PERMISSIONS)
		.filter(([name, level]) => LEVELS.indexOf(have[name] ?? "none") < LEVELS.indexOf(level))
		.map(([name, level]) => `${name}:${level}`);
}

export function missingEvents(subscribed: readonly string[] | undefined): string[] {
	const have = new Set(subscribed ?? []);
	return REQUIRED_EVENTS.filter((event) => !have.has(event));
}
