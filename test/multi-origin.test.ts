import assert from "node:assert/strict";
import test from "node:test";
import {PlayerDirectoryService} from "../src/extension/service.ts";
import {
	RaceTimeClient,
	type RaceTimeLookup,
} from "../src/extension/racetime.ts";
import type {UserLookup} from "../src/extension/speedrun.ts";
import type {Directory} from "../src/domain/player.ts";
const rt = {userId: "rt1", name: "Race Name", twitchLogin: "runner"};
const src = {userId: "src1", name: "SRC Name", twitchLogin: "runner"};
async function setup(
	race: Partial<RaceTimeLookup> = {},
	speed: Partial<UserLookup> = {},
	players: Directory["players"] = [],
) {
	const raceLookup = {
		getUser: async () => rt,
		searchUsers: async () => [rt],
		...race,
	};
	const speedLookup = {
		getUser: async () => src,
		searchUsers: async () => ({users: [src], hasMore: false}),
		...speed,
	};
	const service = new PlayerDirectoryService(
		{
			load: async () => ({schemaVersion: 1, revision: 0, players}),
			save: async () => {
				throw new Error("Resolver must not save");
			},
		},
		speedLookup,
		undefined,
		raceLookup,
	);
	await service.reload();
	return service;
}
test("each account independently resolves all three without persistence", async () => {
	for (const input of [
		{twitch: {login: "RUNNER"}},
		{speedrunCom: {userId: "src1"}},
		{racetime: {userId: "rt1"}},
	]) {
		const service = await setup();
		const result = await service.resolveIdentity(input);
		assert.equal(result.status, "matched");
		assert.deepEqual(result.input.racetime, rt);
		assert.deepEqual(result.input.speedrunCom, src);
		assert.equal(result.input.twitch?.login, "runner");
	}
});
test("missing RaceTime still resolves Twitch and SRC", async () => {
	const service = await setup({searchUsers: async () => []});
	const r = await service.resolveIdentity({twitch: {login: "runner"}});
	assert.equal(r.status, "matched");
	assert.equal(r.input.racetime, null);
	assert.deepEqual(r.input.speedrunCom, src);
});
test("SRC outage does not prevent RaceTime resolution", async () => {
	const service = await setup(
		{},
		{
			searchUsers: async () => {
				throw new Error("rate limited");
			},
		},
	);
	const r = await service.resolveIdentity({twitch: {login: "runner"}});
	assert.deepEqual(r.input.racetime, rt);
	assert.equal(r.input.speedrunCom, null);
	assert.ok(r.warnings.some((w) => w.includes("rate limited")));
});
test("RaceTime outage retains resolved SRC", async () => {
	const service = await setup({
		searchUsers: async () => {
			throw new Error("offline");
		},
	});
	const r = await service.resolveIdentity({twitch: {login: "runner"}});
	assert.equal(r.status, "matched");
	assert.deepEqual(r.input.speedrunCom, src);
	assert.equal(r.input.racetime, null);
	assert.ok(r.warnings.length);
});
test("ambiguous SRC candidates do not stop RaceTime lookup", async () => {
	const service = await setup(
		{},
		{
			searchUsers: async () => ({
				users: [src, {...src, userId: "src2"}],
				hasMore: false,
			}),
		},
	);
	const r = await service.resolveIdentity({twitch: {login: "runner"}});
	assert.equal(r.status, "ambiguous");
	assert.deepEqual(r.input.racetime, rt);
	assert.equal(r.input.speedrunCom, null);
});
test("RaceTime names alone do not establish a link and multiple exact links stay ambiguous", async () => {
	const wrong = await setup({
		searchUsers: async () => [{...rt, twitchLogin: "other"}],
	});
	assert.equal(
		(await wrong.resolveIdentity({twitch: {login: "runner"}})).input.racetime,
		null,
	);
	const multiple = await setup({
		searchUsers: async () => [rt, {...rt, userId: "rt2"}],
	});
	const r = await multiple.resolveIdentity({twitch: {login: "runner"}});
	assert.equal(r.status, "ambiguous");
	assert.equal(r.input.racetime, null);
	assert.deepEqual(r.input.speedrunCom, src);
});
test("Directory supplies accounts with different names without external search", async () => {
	const fail = async () => {
		throw new Error("No search should occur");
	};
	const service = await setup({searchUsers: fail}, {searchUsers: fail}, [
		{
			playerId: "p1",
			revision: 1,
			manualDisplayName: null,
			racetime: rt,
			speedrunCom: src,
			twitch: {login: "runner", userId: "123"},
		},
	]);
	const r = await service.resolveIdentity({twitch: {login: "runner"}});
	assert.equal(r.playerId, "p1");
	assert.deepEqual(r.input.racetime, {...rt, twitchLogin: null});
	assert.deepEqual(r.input.speedrunCom, {...src, twitchLogin: null});
	assert.equal(r.input.twitch?.login, "runner");
	assert.deepEqual(r.warnings, []);
});
test("RaceTime search adapter uses results envelope and authoritative channel login", async () => {
	let requested = "";
	const client = new RaceTimeClient((async (url) => {
		requested = String(url);
		return new Response(
			JSON.stringify({
				results: [
					{
						id: "rt1",
						full_name: "Different#1234",
						twitch_channel: "https://twitch.tv/Runner",
						twitch_name: "Display",
					},
				],
			}),
		);
	}) as typeof fetch);
	assert.deepEqual(await client.searchUsers("a&b"), [
		{userId: "rt1", name: "Different#1234", twitchLogin: "runner"},
	]);
	assert.match(requested, /name=a%26b/);
});
