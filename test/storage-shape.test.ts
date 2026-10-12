import assert from "node:assert/strict";
import {mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {resolveDisplayName} from "@nanahuse/player-manager-protocol";
import {
	compactPlayer,
	identityKeys,
	validateDirectory,
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
		accounts: [],
	});
});
test("legacy Twitch IDs are stripped while v2 account identity and IDs are preserved", () => {
	const directory = validateDirectory({
		schemaVersion: 2,
		revision: 4,
		players: [
			{
				playerId: "kept-player",
				revision: 3,
				manualDisplayName: "Kept name",
				racetime: null,
				speedrunCom: null,
				twitch: {userId: "legacy-twitch-id", login: "Runner"},
				youtube: null,
				accounts: [
					{
						id: "existing-account-id",
						service: "twitch",
						role: "primary",
						identity: {
							userId: "legacy-account-twitch-id",
							login: "Runner",
						},
					},
				],
			},
		],
	});
	const player = directory.players[0]!;
	assert.equal(player.playerId, "kept-player");
	assert.equal(player.revision, 3);
	assert.equal(player.manualDisplayName, "Kept name");
	assert.deepEqual(player.twitch, {login: "runner"});
	assert.equal(player.accounts?.[0]?.id, "existing-account-id");
	assert.deepEqual(player.accounts?.[0]?.identity, {login: "runner"});
	assert.deepEqual(validateDirectory(directory), directory);
});
test("legacy file is backed up and migrated once; distinct linked channels stay independent", async () => {
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
		const migratedAgain = await repo.load();
		assert.equal(
			migratedAgain.players[0]?.accounts?.filter(
				(account) => account.service === "youtube",
			).length,
			2,
		);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});
