import assert from "node:assert/strict";
import test from "node:test";
import {type Directory} from "@nanahuse/player-manager-protocol";
import {
	login,
	speedrunReference,
	speedrunWeblink,
	validateDirectory,
} from "../src/domain/player.ts";
import {SpeedrunClient} from "../src/extension/speedrun.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";
test("Twitch names and channel URLs normalize consistently", () => {
	for (const value of [
		"Nanahuse",
		" https://www.twitch.tv/Nanahuse/?ref=test#about ",
		"http://twitch.tv/Nanahuse",
		"twitch.tv/Nanahuse",
	])
		assert.equal(login(value), "nanahuse");
});
test("SRC current and legacy profile URLs extract the user reference", () => {
	for (const value of [
		"Nanahuse",
		"https://www.speedrun.com/users/Nanahuse?x=1#runs",
		"https://speedrun.com/user/Nanahuse/",
		"www.speedrun.com/users/Nanahuse",
	])
		assert.equal(speedrunReference(value), "Nanahuse");
	assert.equal(speedrunReference("8gelkm2j"), "8gelkm2j");
});
test("unrelated hosts, non-profile paths and encoded separators are rejected", () => {
	for (const value of [
		"https://twitch.tv.evil.test/a",
		"https://twitch.tv/videos/123",
		"https://evil.test/a",
		"ftp://twitch.tv/a",
	])
		assert.throws(() => login(value), {code: "invalid_input"});
	for (const value of [
		"https://speedrun.com/games/a",
		"https://speedrun.com/users/a%2Fb",
		"https://speedrun.com@evil.test/users/a",
		"https://speedrun.com:8443/users/a",
	])
		assert.throws(() => speedrunReference(value), {code: "invalid_input"});
});
test("URL input resolves and persists canonical SRC ID and Twitch login", async () => {
	const requests: string[] = [];
	const client = new SpeedrunClient((async (url) => {
		requests.push(String(url));
		return new Response(
			JSON.stringify({
				data: {
					id: "8gelkm2j",
					names: {international: "Nanahuse"},
					weblink: "https://www.speedrun.com/users/CanonicalProfile",
					twitch: {uri: "https://twitch.tv/nanahuse"},
				},
			}),
		);
	}) as typeof fetch);
	let stored: Directory = {schemaVersion: 1, revision: 0, players: []};
	const service = new PlayerDirectoryService(
		{
			load: async () => stored,
			save: async (value) => {
				stored = value;
			},
		},
		client,
		undefined,
		{
			getUser: async () => {
				throw new Error("Unexpected fetch");
			},
			searchUsers: async () => [],
		},
	);
	await service.reload();
	const input = {
		manualDisplayName: null,
		racetime: null,
		twitch: {userId: null, login: "https://www.twitch.tv/Nanahuse"},
		speedrunCom: {
			userId: "https://www.speedrun.com/users/Nanahuse?ref=test",
			name: "",
			twitchLogin: null,
		},
	};
	const resolution = await service.resolveIdentity(input);
	assert.equal(resolution.status, "matched");
	const player = await service.createPlayer(input);
	assert.equal(player.speedrunCom?.userId, "8gelkm2j");
	assert.equal(
		resolution.input.speedrunCom?.weblink,
		"https://www.speedrun.com/users/CanonicalProfile",
	);
	assert.equal(
		validateDirectory(stored).players[0]?.speedrunCom?.weblink,
		"https://www.speedrun.com/users/CanonicalProfile",
	);
	assert.equal(player.twitch?.login, "nanahuse");
	assert.deepEqual(stored.players[0], player);
	assert.ok(
		requests.every(
			(url) => url === "https://www.speedrun.com/api/v1/users/Nanahuse",
		),
	);
});

test("SRC search preserves weblink and unsafe links are ignored", async () => {
	const weblink = "https://www.speedrun.com/users/CanonicalProfile";
	const client = new SpeedrunClient(
		(async () =>
			new Response(
				JSON.stringify({
					data: [{id: "id1", names: {international: "OtherName"}, weblink}],
				}),
			)) as typeof fetch,
	);
	assert.equal(
		(await client.searchUsers("OtherName")).users[0]?.weblink,
		weblink,
	);
	for (const value of [
		undefined,
		"javascript:alert(1)",
		"https://evil.test/users/a",
		"https://www.speedrun.com@evil.test/users/a",
		"https://www.speedrun.com/games/a",
	])
		assert.equal(speedrunWeblink(value), null);
});

test("SRC dotted usernames retain their official profile link", async () => {
	const weblink = "https://www.speedrun.com/users/T.T";
	assert.equal(speedrunReference("T.T"), "T.T");
	assert.equal(speedrunReference(weblink), "T.T");
	assert.equal(speedrunWeblink(weblink), weblink);
	assert.throws(() => speedrunReference(".."));
	const client = new SpeedrunClient(
		(async () =>
			new Response(
				JSON.stringify({
					data: {
						id: "816kvm3x",
						names: {international: "T.T"},
						weblink,
					},
				}),
			)) as typeof fetch,
	);
	const user = await client.getUser("816kvm3x");
	assert.equal(user.weblink, weblink);
	const directory = validateDirectory({
		schemaVersion: 1,
		revision: 0,
		players: [{playerId: "test", revision: 0, speedrunCom: user}],
	});
	assert.equal(directory.players[0]?.speedrunCom?.weblink, weblink);
});
