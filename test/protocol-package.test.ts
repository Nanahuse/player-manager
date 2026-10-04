import {mkdtemp, mkdir, cp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {execFileSync} from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

test("public protocol works in an external consumer without source files or runtime dependencies", async () => {
	const root = resolve(".");
	const tsc = join(root, "node_modules/typescript/bin/tsc");
	execFileSync(process.execPath, [tsc, "-p", "tsconfig.protocol.json"]);
	const dir = await mkdtemp(join(tmpdir(), "player-protocol-"));
	try {
		const installed = join(dir, "node_modules/player-manager");
		await mkdir(installed, {recursive: true});
		await cp(join(root, "dist/public"), join(installed, "dist/public"), {
			recursive: true,
		});
		await cp(join(root, "package.json"), join(installed, "package.json"));
		await writeFile(
			join(dir, "consumer.ts"),
			`import type {Player, PlayerManagerAPI, Operations, Resolution} from "player-manager/protocol";
import {resolveDisplayName, API_VERSION} from "player-manager/protocol";
export function consume(player: Player, api: PlayerManagerAPI, resolution: Resolution) {
 const request: Operations["get"]["request"] = {playerId: player.playerId};
 return [resolveDisplayName(player), API_VERSION, api.request("get", request), resolution.candidates];
}`,
		);
		for (const [module, moduleResolution] of [
			["NodeNext", "NodeNext"],
			["ESNext", "Bundler"],
		]) {
			execFileSync(
				process.execPath,
				[
					tsc,
					"--noEmit",
					"--strict",
					"--skipLibCheck",
					"false",
					"--target",
					"ES2022",
					"--module",
					module,
					"--moduleResolution",
					moduleResolution,
					"consumer.ts",
				],
				{cwd: dir, stdio: "pipe"},
			);
		}
		await writeFile(
			join(dir, "consumer.cjs"),
			`const assert=require('node:assert/strict');
const p=require('player-manager/protocol'); assert.equal(p.API_VERSION,1);
assert.equal(p.resolveDisplayName({playerId:'fallback'}),'fallback');
assert.throws(()=>require('player-manager/src/domain/player'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`,
		);
		execFileSync(process.execPath, ["consumer.cjs"], {cwd: dir});
	} finally {
		await rm(dir, {recursive: true, force: true, maxRetries: 3});
	}
});
