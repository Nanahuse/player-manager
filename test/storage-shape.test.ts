import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, writeFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {resolveDisplayName} from "@nanahuse/player-manager-protocol";
import {
	compactPlayer,
	validateDirectory,
	identityKeys,
} from "../src/domain/player.ts";
import {JsonRepository} from "../src/extension/repository.ts";
const youtube = "https://www.youtube.com/@runner";
const legacy = {
	schemaVersion: 1,
	revision: 12,
	players: [
		{
			playerId: "p1",
			revision: 7,
			manualDisplayName: null,
			racetime: {
				userId: "rt1",
				name: "Race Name",
				twitchLogin: "runner",
				twitchDisplayName: "Runner Display",
			},
			speedrunCom: {
				userId: "src1",
				name: "SRC Name",
				twitchLogin: "runner",
				youtube,
				weblink: "https://www.speedrun.com/users/SRC_Name",
			},
			twitch: null,
		},
	],
};
test("storage consolidates identities without losing display names, links or duplicate keys", () => {
	const directory = validateDirectory(legacy);
	const player = directory.players[0]!;
	assert.deepEqual(player.racetime, {userId: "rt1", name: "Race Name"});
	assert.deepEqual(player.speedrunCom, {
		userId: "src1",
		name: "SRC Name",
		weblink: "https://www.speedrun.com/users/SRC_Name",
	});
	assert.deepEqual(player.twitch, {
		userId: null,
		login: "runner",
		displayName: "Runner Display",
	});
	assert.equal(player.youtube, youtube);
	assert.equal(resolveDisplayName(player), "Runner Display");
	assert.deepEqual(
		new Set(identityKeys(player)),
		new Set(identityKeys({...legacy.players[0], youtube})),
	);
	assert.equal(player.revision, 7);
	assert.equal(directory.revision, 12);
	assert.deepEqual(validateDirectory(directory), directory);
	assert.deepEqual(compactPlayer({}), {
		youtube: null,
		manualDisplayName: null,
		racetime: null,
		speedrunCom: null,
		twitch: null,
	});
});
test("legacy file is backed up and migrated once; conflicting data stays untouched", async () => {
	const dir = await mkdtemp(join(tmpdir(), "player-storage-"));
	try {
		const file = join(dir, "players.json");
		const original = JSON.stringify(legacy);
		await writeFile(file, original);
		const repo = new JsonRepository(file);
		const migrated = await repo.load();
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), migrated);
		const backups = (await readdir(dir)).filter((p) => p.endsWith(".bak"));
		assert.equal(backups.length, 1);
		assert.equal(await readFile(join(dir, backups[0]!), "utf8"), original);
		await repo.load();
		assert.equal(
			(await readdir(dir)).filter((p) => p.endsWith(".bak")).length,
			1,
		);
		const conflict = JSON.stringify({
			...legacy,
			players: [
				{...legacy.players[0], youtube: "https://www.youtube.com/@other"},
			],
		});
		await writeFile(file, conflict);
		await assert.rejects(repo.load(), {code: "identity_conflict"});
		assert.equal(await readFile(file, "utf8"), conflict);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});
