import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {cp, mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";

test("public protocol works in an external consumer without source files or runtime dependencies", async () => {
	const root = resolve(".");
	const tsc = join(root, "node_modules/typescript/bin/tsc");

	const dir = await mkdtemp(join(tmpdir(), "player-protocol-"));
	try {
		const installed = join(dir, "standalone-protocol");
		await mkdir(installed, {recursive: true});
		await cp(
			join(root, "packages/player-manager-protocol/src"),
			join(installed, "src"),
			{recursive: true},
		);
		await cp(
			join(root, "packages/player-manager-protocol/package.json"),
			join(installed, "package.json"),
		);
		await cp(
			join(root, "packages/player-manager-protocol/tsconfig.json"),
			join(installed, "tsconfig.json"),
		);
		await cp(
			join(root, "packages/player-manager-protocol/tsconfig.cjs.json"),
			join(installed, "tsconfig.cjs.json"),
		);
		await cp(
			join(root, "packages/player-manager-protocol/finalize.cjs"),
			join(installed, "finalize.cjs"),
		);
		execFileSync(process.execPath, [
			tsc,
			"-p",
			join(installed, "tsconfig.json"),
		]);
		execFileSync(process.execPath, [
			tsc,
			"-p",
			join(installed, "tsconfig.cjs.json"),
		]);
		execFileSync(process.execPath, [join(installed, "finalize.cjs")]);
		await cp(
			installed,
			join(dir, "node_modules/@nanahuse/player-manager-protocol"),
			{recursive: true},
		);
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({type: "module"}),
		);
		await writeFile(
			join(dir, "consumer.ts"),
			`import type {Player, PlayerManagerAPI, Operations, Resolution, Account, MatchingInput} from "@nanahuse/player-manager-protocol";
import {resolveDisplayName, API_VERSION} from "@nanahuse/player-manager-protocol";
// @ts-expect-error legacy API is not public
const legacy: keyof Operations = "getUser";
export function consume(player: Player, api: PlayerManagerAPI, resolution: Resolution) {
 const request: Operations["get"]["request"] = {playerId: player.playerId};
 const input: MatchingInput = {racetime: "runner"};
 const account: Account | undefined = resolution.accounts[0];
 return [resolveDisplayName(player), API_VERSION, api.request("get", request), resolution.candidates, input, account, api.request("completeRegistration", {registrationId: "id"})];
}`,
		);
		for (const [module, moduleResolution] of [
			["Node16", "Node16"],
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
			join(dir, "package.json"),
			JSON.stringify({type: "commonjs"}),
		);
		execFileSync(
			process.execPath,
			[
				tsc,
				"--noEmit",
				"--strict",
				"--target",
				"ES2022",
				"--module",
				"Node16",
				"--moduleResolution",
				"Node16",
				"consumer.ts",
			],
			{cwd: dir, stdio: "inherit"},
		);
		await writeFile(
			join(dir, "consumer.mjs"),
			`import assert from 'node:assert/strict';
import * as p from '@nanahuse/player-manager-protocol'; assert.equal(p.API_VERSION,2);
assert.equal(p.resolveDisplayName({playerId:'fallback'}),'fallback');
assert.equal(p.BUNDLE_NAME,'player-manager');
assert.equal(p.operationMessageName('resolve'),'player-manager.v2.resolve');
assert.equal(p.eventMessageName('registrationCompleted'),'player-manager.v2.registrationCompleted');
await assert.rejects(import('@nanahuse/player-manager-protocol/src/player'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`,
		);
		execFileSync(process.execPath, ["consumer.mjs"], {cwd: dir});
		execFileSync(
			process.execPath,
			[
				"-e",
				"const p=require('@nanahuse/player-manager-protocol');require('node:assert/strict').equal(p.API_VERSION,2)",
			],
			{cwd: dir},
		);
	} finally {
		await rm(dir, {recursive: true, force: true, maxRetries: 3});
	}
});
