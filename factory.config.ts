import type { MaintenanceRecipe } from "./app/schemas/maintenance.js";

export interface RepoConfig {
	/** Branch that specs are implemented against and snapshots are built from. */
	baseBranch: string;
	/** Opt-in clean-install and application checks; commands are trusted deployment configuration. */
	maintenance?: MaintenanceRecipe;
	/** Opt-in direct dependency patch/minor proposals, tested against a clean baseline. */
	dependencyUpdates?: { packageManager: "npm" | "yarn1" };
	/** Installs dependencies in the sandbox. Runs after credentials are removed. */
	install?: string;
	/** Commands that must pass before a PR opens and that PR Reviewer runs. */
	verify: string[];
	/**
	 * HTTPS hosts this repository's sandboxes may reach beyond github.com and the agents' model APIs: package
	 * registries and anything `install` or `verify` downloads. Exact hostnames; `*.` only as the leftmost label.
	 * Every other destination is blocked. "allow-all" lifts the restriction for this repository.
	 */
	egress?: string[] | "allow-all";
}

export interface FactoryConfig {
	/** Repositories the factory acts on, keyed by "owner/name". Webhooks from any other repository are ignored. */
	repos: Record<string, RepoConfig>;
	labels: { triage: string; specApproved: string; prReview: string; autopilot: string };
	/** Prefix for comment commands, such as `/factory cancel`. */
	commandPrefix: string;
	/** GitHub permission the triggering actor needs on the repository. */
	minimumPermission: "triage" | "write" | "maintain" | "admin";
	limits: {
		/** Fix rounds after a failed verify in Spec-to-PR. */
		repairRounds: number;
		/** Publishing refuses a change with more files than this. */
		maxChangedFiles: number;
		/** Publishing refuses any changed file larger than this. */
		maxFileBytes: number;
	};
	sandbox: {
		/** Render terminates a sandbox after this, even if the task that opened it crashed. */
		timeoutSeconds: number;
	};
}

export function defineFactoryConfig(config: FactoryConfig): FactoryConfig {
	return config;
}

export default defineFactoryConfig({
	repos: {
		"render-examples/express-hello-world": {
			dependencyUpdates: { packageManager: "yarn1" },
			baseBranch: "main",
			install: "npm exec --yes --package=yarn@1.22.22 -- yarn install --frozen-lockfile --non-interactive",
			verify: ["node --check app.js"],
			maintenance: {
				install: {
					name: "install",
					command: "npm exec --yes --package=yarn@1.22.22 -- yarn install --frozen-lockfile --non-interactive",
					timeoutSeconds: 180,
				},
				checks: [{ name: "syntax", command: "node --check app.js", timeoutSeconds: 30 }],
				smoke: { start: "PORT=3001 node app.js", port: 3001, path: "/", expectedStatus: 200, bodyIncludes: "Hello from Render!", timeoutSeconds: 30 },
			},
			egress: ["registry.npmjs.org", "registry.yarnpkg.com"],
		},
		"render-examples/express-hello-world-typescript": {
			dependencyUpdates: { packageManager: "yarn1" },
			baseBranch: "master",
			install: "npm exec --yes --package=yarn@1.22.22 -- yarn install --frozen-lockfile --non-interactive",
			verify: ["npm run build"],
			maintenance: {
				install: {
					name: "install",
					command: "npm exec --yes --package=yarn@1.22.22 -- yarn install --frozen-lockfile --non-interactive",
					timeoutSeconds: 240,
				},
				checks: [{ name: "build", command: "npm run build", timeoutSeconds: 120 }],
				smoke: {
					start: "PORT=3001 node dist/app.js",
					port: 3001,
					path: "/",
					expectedStatus: 200,
					bodyIncludes: "Hello from Render!",
					timeoutSeconds: 30,
				},
			},
			egress: ["registry.npmjs.org", "registry.yarnpkg.com"],
		},
		"render-examples/hapi-quick-start": {
			dependencyUpdates: { packageManager: "npm" },
			baseBranch: "master",
			install: "npm ci",
			verify: ["node --check server.js"],
			maintenance: {
				install: { name: "install", command: "npm ci", timeoutSeconds: 180 },
				checks: [{ name: "syntax", command: "node --check server.js", timeoutSeconds: 30 }],
				smoke: { start: "node server.js", port: 3000, path: "/", expectedStatus: 200, bodyIncludes: "Hello, world!", timeoutSeconds: 30 },
			},
			egress: ["registry.npmjs.org"],
		},
	},
	labels: {
		triage: "factory:triage",
		specApproved: "factory:spec-approved",
		prReview: "factory:pr-review",
		autopilot: "factory:autopilot",
	},
	commandPrefix: "/factory",
	minimumPermission: "write",
	limits: {
		repairRounds: 2,
		maxChangedFiles: 200,
		maxFileBytes: 1_000_000,
	},
	sandbox: {
		timeoutSeconds: 4 * 60 * 60,
	},
});
