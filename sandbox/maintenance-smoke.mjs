// Runs beside the application in the sandbox. The host supplies the trusted recipe.
import { spawn } from "node:child_process";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const recipe = JSON.parse(process.argv[2]);
const child = spawn("bash", ["-c", recipe.start], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
let exited = false;
let spawnError = false;
child.stdout.on("data", (data) => { output = (output + data).slice(-4096); });
child.stderr.on("data", (data) => { output = (output + data).slice(-4096); });
child.on("exit", () => { exited = true; });
child.on("error", () => { spawnError = true; });

function signalGroup(signal) {
	if (!child.pid) return;
	try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function cleanup() {
	signalGroup("SIGTERM");
	await sleep(100);
	// The group can outlive its leader, so always attempt KILL even after child exit.
	signalGroup("SIGKILL");
}
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.once(signal, () => { cleanup().finally(() => process.exit(124)); });
}

function probe() {
	return new Promise((resolve, reject) => {
		const req = request({ hostname: "127.0.0.1", port: recipe.port, path: recipe.path, method: "GET" }, (res) => {
			let body = "";
			let bytes = 0;
			res.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > 65536) req.destroy(new Error("response exceeds 64 KiB"));
				else body += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode, body }));
			res.on("error", reject);
		});
		const deadline = setTimeout(() => req.destroy(new Error("request deadline")), 1000);
		req.on("close", () => clearTimeout(deadline));
		req.on("error", reject);
		req.end();
	});
}

let code = 21;
try {
	const deadline = Date.now() + recipe.timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		if (exited || spawnError) { code = 20; break; }
		try {
			const response = await probe();
			if (exited || spawnError) { code = 20; break; }
			code = response.status === recipe.expectedStatus && response.body.includes(recipe.bodyIncludes) ? 0 : 22;
			break;
		} catch {
			await sleep(100);
		}
	}
} finally {
	await cleanup();
}
if (output) process.stderr.write(output);
console.log(JSON.stringify({ result: ({ 0: "passed", 20: "app_exited", 21: "readiness_timeout", 22: "response_mismatch" })[code] }));
process.exitCode = code;
