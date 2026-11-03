import { parseArgs } from "node:util";
import { config } from "../app/config/index.js";
import { inventoryMaintenance } from "./lib/maintenance-inventory.js";
const { values } = parseArgs({ options: { org: { type: "string", default: "render-examples" } }, strict: true });
console.log(JSON.stringify(await inventoryMaintenance(values.org, config), null, 2));
