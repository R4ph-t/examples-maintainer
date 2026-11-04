import { parseArgs } from "node:util";
import { historySettings, retainMaintenanceRuns } from "../app/maintenance-history/index.js";

const { values } = parseArgs({ options: { run: { type: "string", multiple: true } }, strict: true });
const settings = historySettings();
if (!settings) throw new Error("Maintenance history is not configured");
if (!values.run?.length || values.run.length > 25) throw new Error("Supply between 1 and 25 --run IDs");
console.log(JSON.stringify({ receipts: await retainMaintenanceRuns(values.run, settings) }));
