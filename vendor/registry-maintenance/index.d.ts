// Generated from the catalog schemas. No Zod installation is required.
export type MaintenanceBundle = {
"contract": "render-registry/maintenance";
"schemaVersion": 1;
"generatedAt": string;
"mode": "preview" | "execution";
"catalog": {
"revision": string;
"inputDigest": string;
"workingTree": boolean;

};
"targets": Array<{
"schemaVersion": 1;
"entry": string;
"source": {
"kind": "moving-branch";
"repository": string;
"branch": string;
"path": ".";

};
"execution": {
"enabled": boolean;
"approvalReference": string;
"candidateVerification": boolean;
"pullRequestPublication": false;
"merge": false;

};
"recipe": {
"runtime"?: "node" | "python";
"install": {
"name": string;
"command": string;
"timeoutSeconds": number;

};
"checks": Array<{
"name": string;
"command": string;
"timeoutSeconds": number;

}>;
"smoke": {
"start": string;
"port": number;
"path": string;
"expectedStatus": number;
"bodyIncludes": string;
"timeoutSeconds": number;

};

};
"packageManager": "npm" | "yarn1" | "pip";
"egress": Array<string>;
"checks": Array<{
"operation": "dependency-scan" | "application-verification";
"profile": {
"schemaVersion": 1;
"id": string;
"scope": "skill-eval" | "compatibility" | "application-smoke" | "image-workload" | "snapshot-restore" | "blueprint-deployment" | "security" | "article-review" | "link-check";
"suite": {
"repository": string;
"path": string;
"revision": string;
"tree"?: string;

};
"harness": {
"name": string;
"version": string;

};
"model": ({
"provider": string;
"name": string;
"settingsDigest": string;

}) | (null);
"grader": ({
"provider": string;
"name": string;
"settingsDigest": string;

}) | (null);
"configuration": {

[key: string]: string;
};
"freshForHours": (number) | (null);

};
"everyHours": number;
"recipeHash": string;
"recipeHashAlgorithm": "examples-maintainer/scan-recipe-v1" | "examples-maintainer/verification-recipe-v1";
"toolHash": string;
"toolHashAlgorithm": "examples-maintainer/scan-tools-v1" | "sha256-file";

}>;
"targetDigest": string;

}>;
"contentHash": string;

};
export type MaintenanceTarget = {
"schemaVersion": 1;
"entry": string;
"source": {
"kind": "moving-branch";
"repository": string;
"branch": string;
"path": ".";

};
"execution": {
"enabled": boolean;
"approvalReference": string;
"candidateVerification": boolean;
"pullRequestPublication": false;
"merge": false;

};
"recipe": {
"runtime"?: "node" | "python";
"install": {
"name": string;
"command": string;
"timeoutSeconds": number;

};
"checks": Array<{
"name": string;
"command": string;
"timeoutSeconds": number;

}>;
"smoke": {
"start": string;
"port": number;
"path": string;
"expectedStatus": number;
"bodyIncludes": string;
"timeoutSeconds": number;

};

};
"packageManager": "npm" | "yarn1" | "pip";
"egress": Array<string>;
"checks": Array<{
"operation": "dependency-scan" | "application-verification";
"profile": {
"schemaVersion": 1;
"id": string;
"scope": "skill-eval" | "compatibility" | "application-smoke" | "image-workload" | "snapshot-restore" | "blueprint-deployment" | "security" | "article-review" | "link-check";
"suite": {
"repository": string;
"path": string;
"revision": string;
"tree"?: string;

};
"harness": {
"name": string;
"version": string;

};
"model": ({
"provider": string;
"name": string;
"settingsDigest": string;

}) | (null);
"grader": ({
"provider": string;
"name": string;
"settingsDigest": string;

}) | (null);
"configuration": {

[key: string]: string;
};
"freshForHours": (number) | (null);

};
"everyHours": number;
"recipeHash": string;
"recipeHashAlgorithm": "examples-maintainer/scan-recipe-v1" | "examples-maintainer/verification-recipe-v1";
"toolHash": string;
"toolHashAlgorithm": "examples-maintainer/scan-tools-v1" | "sha256-file";

}>;

};
export type MaintenanceObservation = {
"schemaVersion": 2;
"producer": string;
"runId": string;
"observationId": string;
"entry": string;
"catalog": {
"revision": string;
"inputDigest": string;
"contractDigest": string;

};
"targetDigest": string;
"profile": string;
"profileDigest": string;
"subject": ({
"kind": "branch-baseline";
"sourceRevision": string;

}) | ({
"kind": "branch-candidate";
"sourceRevision": string;
"artifactDigest": string;
"candidateTree"?: string;

});
"recipeHash": string;
"toolHash": string;
"completedAt": string;
"cleanup": "not_created" | "terminated" | "unconfirmed";
"inventoryHash"?: string;
"result": ({
"kind": "dependency-scan";
"completion": "completed" | "incomplete" | "infrastructure_error";
"security": ({
"status": "completed";
"findings": {
"info": number;
"low": number;
"moderate": number;
"high": number;
"critical": number;
"unknown": number;

};
"scannedAt": string;
"exploitation": "not-assessed";
"reachability": "not-assessed";

}) | ({
"status": "unavailable";
"reason": string;

});
"candidates": number;
"verification": "not-run";

}) | ({
"kind": "application-verification";
"status": "passed" | "failed" | "infrastructure_error";

});
"evidenceUrl": string;

};
export type MaintenanceDecision = {
"schemaVersion": 1;
"producer": string;
"eventId": string;
"entry": string;
"catalog": {
"revision": string;
"inputDigest": string;
"contractDigest": string;

};
"subject": {
"kind": "branch-candidate";
"sourceRevision": string;
"artifactDigest": string;
"candidateTree"?: string;

};
"occurredAt": string;
"evidenceUrl": string;
"decision": ({
"kind": "pull-request";
"state": "not-requested" | "blocked" | "draft" | "open" | "merged" | "closed";
"url"?: string;
"headRevision"?: string;

}) | ({
"kind": "human-review";
"state": "pending" | "approved" | "changes-requested" | "rejected";
"reviewer"?: string;

});

};
export type Check = {
"schemaVersion": 1;
"id": string;
"scope": "skill-eval" | "compatibility" | "application-smoke" | "image-workload" | "snapshot-restore" | "blueprint-deployment" | "security" | "article-review" | "link-check";
"suite": {
"repository": string;
"path": string;
"revision": string;
"tree"?: string;

};
"harness": {
"name": string;
"version": string;

};
"model": ({
"provider": string;
"name": string;
"settingsDigest": string;

}) | (null);
"grader": ({
"provider": string;
"name": string;
"settingsDigest": string;

}) | (null);
"configuration": {

[key: string]: string;
};
"freshForHours": (number) | (null);

};

export declare function parseMaintenanceBundle(raw: unknown, requireExecution?: boolean): MaintenanceBundle;
export declare function validateMaintenanceObservation(raw: unknown, bundleRaw: unknown, now?: string): MaintenanceObservation;
export declare function parseMaintenanceObservations(raw: unknown, bundle: unknown, now?: string): MaintenanceObservation[];
export declare function checkDigest(check: Check): string;
export declare function maintenanceFreshness(observation: MaintenanceObservation, target: MaintenanceBundle['targets'][number], subject: MaintenanceObservation['subject'], now?: string): 'outdated-inputs' | 'unspecified' | 'stale' | 'fresh';
export declare function parseMaintenanceDecision(raw: unknown): MaintenanceDecision;
