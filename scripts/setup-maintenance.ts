import { parseArgs } from "node:util";
import { config } from "../app/config/index.js";
import { maintenanceRevision } from "../app/github/index.js";
import { planMaintenance } from "./lib/maintenance.js";
import { writeEnvFile } from "./lib/env-file.js";
import { Reporter } from "./lib/output.js";
import { MAINTENANCE_SETUP_GROUPS } from "./lib/requirements.js";
import { setupRender } from "./lib/setup-render.js";

const { values } = parseArgs({ options: { workspace: { type: "string" } }, strict: true });
const workspace = values.workspace ?? process.env.RENDER_WORKSPACE_ID;
if (!workspace || !/^tea-[a-z0-9]+$/.test(workspace)) throw new Error("--workspace must be a Render workspace ID");
// This setup command deploys only the read-only first phase, even if local write credentials exist.
process.env.MAINTENANCE_MODE = "public";
const plan = await planMaintenance(config, new Date().toISOString().slice(0, 10), maintenanceRevision);
if (plan.input.resolutionFailures?.length) throw new Error(`Could not resolve: ${plan.input.resolutionFailures.map((r) => r.repo).join(", ")}`);
const out = new Reporter();
process.exitCode = await setupRender({ env: { ...process.env, RENDER_WORKSPACE_ID: workspace }, groups: MAINTENANCE_SETUP_GROUPS }, out);
if (process.exitCode === 0) {
	await writeEnvFile(".env", { RENDER_WORKSPACE_ID: workspace, MAINTENANCE_MODE: "public" });
	out.heading("Before deploying: set a dedicated scoped RENDER_API_KEY in the examples-maintainer environment group (docs/maintenance-setup.md).");
}
