import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { config } from "../app/config/index.js";
import { maintenanceRevision } from "../app/github/index.js";
import { runRepositoryVerification } from "../app/workflows/maintenance/verify.js";

const { values } = parseArgs({ options: { repo: { type: "string" } }, strict: true });
const name = values.repo;
if (!name || !config.repos[name]?.maintenance) throw new Error("--repo must name a configured maintenance repository");
const revision = await maintenanceRevision(name, config.repos[name].baseBranch);
const result = await runRepositoryVerification({ repo: name, ...revision }, `manual-${randomUUID()}`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === "passed" && result.reporting === "published" ? 0 : 1;
