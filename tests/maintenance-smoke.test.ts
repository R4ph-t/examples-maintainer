import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { shq } from "../app/sandbox/index.js";

const exec = promisify(execFile);
const script = new URL("../sandbox/maintenance-smoke.mjs", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(body = "hello", hang = false) {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const port = address.port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	const dir = await mkdtemp(join(tmpdir(), "maintenance-smoke-"));
	dirs.push(dir);
	const pidPath = join(dir, "pid");
	const entry = join(dir, "server.cjs");
	await writeFile(
		entry,
		`require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
require('node:http').createServer((req,res) => { ${hang ? "res.write('partial');" : `res.end(${JSON.stringify(body)});`} }).listen(${port}, '127.0.0.1');`,
	);
	return {
		pidPath,
		recipe: { start: `${shq(process.execPath)} ${shq(entry)}`, port, path: "/", expectedStatus: 200, bodyIncludes: "hello", timeoutSeconds: 2 },
	};
}
async function run(recipe: object) {
	try {
		const result = await exec(process.execPath, [script, JSON.stringify(recipe)], { timeout: 8000, env: { PATH: process.env.PATH } });
		return { code: 0, ...result };
	} catch (error) {
		const e = error as { code: number; stdout: string; stderr: string };
		return { code: e.code, stdout: e.stdout, stderr: e.stderr };
	}
}
async function expectStopped(pidPath: string) {
	const pid = Number(await readFile(pidPath, "utf8"));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(() => process.kill(pid, 0)).toThrow();
}

describe("application smoke test (real local processes, no provider calls)", () => {
	it("verifies an HTTP response and stops the application", async () => {
		const { recipe, pidPath } = await fixture();
		expect(await run(recipe)).toMatchObject({ code: 0 });
		await expectStopped(pidPath);
	});
	it("rejects a wrong body and still stops the application", async () => {
		const { recipe, pidPath } = await fixture("wrong");
		expect(await run(recipe)).toMatchObject({ code: 22 });
		await expectStopped(pidPath);
	});
	it("rejects an application that exits before becoming ready", async () => {
		const { recipe } = await fixture();
		expect(await run({ ...recipe, start: "exit 1" })).toMatchObject({ code: 20 });
	});
	it("bounds a response that never ends and stops the server", async () => {
		const { recipe, pidPath } = await fixture("", true);
		expect(await run(recipe)).toMatchObject({ code: 21 });
		await expectStopped(pidPath);
	});
	it("detects recovery when the same recipe gets the expected response again", async () => {
		const broken = await fixture("broken");
		expect((await run(broken.recipe)).code).toBe(22);
		const recovered = await fixture();
		expect((await run(recovered.recipe)).code).toBe(0);
		await expectStopped(broken.pidPath);
		await expectStopped(recovered.pidPath);
	});
});
