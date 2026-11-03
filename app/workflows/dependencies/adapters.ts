import type { Sandbox } from "../../sandbox/index.js";
import type { DependencyCandidate, DependencySnapshot } from "../../schemas/index.js";
import { auditSandbox } from "./audit.js";
import { discoverUpdates } from "./discovery.js";
import { applyArtifact, inspectFiles, installFileHelper, regenerateLock, writeCandidateManifest } from "./files.js";
import { discoverPythonUpdates } from "./python.js";
import { auditPythonSandbox } from "./python-audit.js";
import {
	applyPythonArtifact,
	inspectPythonFiles,
	installPythonFileHelper,
	regeneratePythonLock,
	writePythonCandidateManifest,
} from "./python-files.js";

export type PackageManager = "npm" | "yarn1" | "pip";
export interface DependencyFileOps {
	install(sandbox: Sandbox): Promise<void>;
	inspect(sandbox: Sandbox, manager: PackageManager, installed?: boolean): Promise<DependencySnapshot>;
	apply(sandbox: Sandbox, artifact: unknown): Promise<void>;
	update(sandbox: Sandbox, candidate: DependencyCandidate): Promise<void>;
	lock(sandbox: Sandbox, manager: PackageManager): Promise<{ exitCode: number; output: string }>;
}

/** Package-specific data handling; orchestration and acceptance gates remain shared. */
export function dependencyAdapter(manager: PackageManager) {
	if (manager === "pip")
		return {
			files: {
				install: installPythonFileHelper,
				inspect: (s: Sandbox, _manager: PackageManager, installed = false) => inspectPythonFiles(s, installed),
				apply: applyPythonArtifact,
				update: writePythonCandidateManifest,
				lock: (s: Sandbox) => regeneratePythonLock(s),
			} satisfies DependencyFileOps,
			discover: discoverPythonUpdates,
			audit: auditPythonSandbox,
		};
	return {
		files: {
			install: installFileHelper,
			inspect: (s: Sandbox, _manager: PackageManager, installed = false) => inspectFiles(s, manager, installed),
			apply: applyArtifact,
			update: writeCandidateManifest,
			lock: (s: Sandbox) => regenerateLock(s, manager),
		} satisfies DependencyFileOps,
		discover: discoverUpdates,
		audit: (s: Sandbox, installed: Record<string, string>) => auditSandbox(s, manager, installed),
	};
}
