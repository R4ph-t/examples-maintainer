import type { FactoryConfig } from "../../factory.config.js";

export const REPO = "acme/widget";
export const BUILD_COMMAND = "npm run build";
export const TEST_COMMAND = "npm test";

/** Distinct repositories prove tasks use the selected repository's branch and command list. */
export const REPOSITORY_CASES = [
	{ repo: "acme/docs", baseBranch: "docs", verify: [] },
	{ repo: "acme/api", baseBranch: "develop", verify: ["npm run check"] },
	{ repo: "other/worker", baseBranch: "release/candidate", verify: ["npm run lint", "npm run typecheck", "npm test"] },
] as const;

/** Unit tests never read the operator's deployment settings. Keep security-sensitive expectations explicit. */
export const testConfig: FactoryConfig = {
	repos: {
		[REPO]: {
			dependencyUpdates: { packageManager: "npm" },
			baseBranch: "main",
			install: "npm ci",
			verify: [BUILD_COMMAND, TEST_COMMAND],
			maintenance: {
				install: { name: "install", command: "npm ci", timeoutSeconds: 60 },
				checks: [{ name: "build", command: BUILD_COMMAND, timeoutSeconds: 60 }],
				smoke: { start: "npm start", port: 3001, path: "/", expectedStatus: 200, bodyIncludes: "hello", timeoutSeconds: 5 },
			},
		},
		...Object.fromEntries(REPOSITORY_CASES.map(({ repo, baseBranch, verify }) => [repo, { baseBranch, verify: [...verify] }])),
	},
	labels: {
		triage: "factory:triage",
		specApproved: "factory:spec-approved",
		prReview: "factory:pr-review",
		autopilot: "factory:autopilot",
	},
	commandPrefix: "/factory",
	minimumPermission: "write",
	limits: { repairRounds: 2, maxChangedFiles: 200, maxFileBytes: 1_000_000 },
	sandbox: { timeoutSeconds: 4 * 60 * 60 },
};
