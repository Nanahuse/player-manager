import assert from "node:assert/strict";
import test from "node:test";
import {normalize, youtubeUrl, type Directory} from "../src/domain/player.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";
import {SpeedrunClient, type UserLookup} from "../src/extension/speedrun.ts";
const channel = "https://www.youtube.com/@runner";
const src = {
	userId: "src1",
	name: "Runner",
	twitchLogin: null,
	youtube: channel,
};
async function setup(lookup: Partial<UserLookup> = {}) {
	let stored: Directory = {schemaVersion: 1, revision: 0, players: []};
	const repository = {
		load: async () => structuredClone(stored),
		save: async (value: Directory) => {
			stored = structuredClone(value);
		},
	};
	const service = new PlayerDirectoryService(
		repository,
		{
			getUser: async () => src,
			searchUsers: async () => ({users: [src], hasMore: false}),
			...lookup,
		},
		undefined,
		{
			getUser: async (id) => ({
				userId: id,
				name: "Race runner",
				twitchLogin: null,
			}),
			searchUsers: async () => [],
		},
	);
	await service.reload();
	return {service, repository};
}
test("YouTube channel, handle and legacy URLs normalize; videos and spoofed hosts fail", () => {
	assert.equal(
		youtubeUrl("https://m.youtube.com/@Runner/?ref=x#about"),
		channel,
	);
	assert.equal(youtubeUrl("@Runner"), channel);
	const id = "UC" + "A".repeat(22);
	assert.equal(
		youtubeUrl("https://youtube.com/channel/" + id),
		"https://www.youtube.com/channel/" + id,
	);
	assert.equal(
		youtubeUrl("https://youtube.com/user/Runner/"),
		"https://www.youtube.com/user/Runner",
	);
	for (const url of [
		"https://youtube.com/watch?v=x",
		"https://youtu.be/x",
		"https://youtube.com.evil.test/@runner",
		"https://youtube.com/@a%2Fb",
	])
		assert.throws(() => youtubeUrl(url), {code: "invalid_input"});
});
test("all blank accounts and name can be created, updated and loaded", async () => {
	const {service, repository} = await setup();
	const p = await service.createPlayer({});
	assert.ok(p.playerId);
	const updated = await service.updatePlayer(p.playerId, p.revision, {});
	assert.equal(updated.revision, 2);
	assert.equal((await repository.load()).players[0]?.playerId, p.playerId);
	assert.equal((await service.resolveIdentity({})).status, "unresolved");
});
test("YouTube alone resolves SRC using exact shared profile link without requiring Twitch", async () => {
	const {service} = await setup();
	const r = await service.resolveIdentity({youtube: "@Runner"});
	assert.equal(r.status, "matched");
	assert.equal(r.input.speedrunCom?.userId, "src1");
	assert.equal(r.input.racetime, null);
	assert.equal(r.input.twitch, null);
	assert.equal(service.snapshot().players.length, 0);
});
test("SRC YouTube metadata is retained and reserves duplicate ownership", async () => {
	const {service} = await setup();
	const p = await service.createPlayer({speedrunCom: {userId: "src1"}});
	assert.equal(p.youtube, channel);
	await assert.rejects(service.createPlayer({youtube: "@Runner"}), {
		code: "identity_conflict",
	});
	const result = await service.resolveIdentity({youtube: channel});
	assert.equal(result.playerId, p.playerId);
});
test("Directory YouTube link bridges RaceTime to SRC without a Twitch link", async () => {
	const {service} = await setup();
	const p = await service.createPlayer({
		racetime: {userId: "rt1"},
		youtube: channel,
	});
	const result = await service.resolveIdentity({speedrunCom: {userId: "src1"}});
	assert.equal(result.playerId, p.playerId);
	assert.equal(result.input.racetime?.userId, "rt1");
	assert.equal(result.input.speedrunCom?.userId, "src1");
	assert.equal(result.input.twitch, null);
});
test("ambiguous, absent and failed YouTube searches preserve partial inputs", async () => {
	for (const lookup of [
		async () => ({users: [src, {...src, userId: "src2"}], hasMore: false}),
		async () => ({users: [src], hasMore: true}),
	]) {
		const {service} = await setup({searchUsers: lookup});
		const r = await service.resolveIdentity({youtube: channel});
		assert.equal(r.status, "ambiguous");
		assert.equal(r.input.speedrunCom, null);
		assert.equal(r.input.youtube, channel);
	}
	for (const lookup of [
		async () => ({
			users: [{...src, youtube: "https://www.youtube.com/@different"}],
			hasMore: false,
		}),
		async () => {
			throw new Error("offline");
		},
	]) {
		const {service} = await setup({searchUsers: lookup});
		const r = await service.resolveIdentity({youtube: channel});
		assert.equal(r.status, "unresolved");
		assert.equal(r.input.youtube, channel);
	}
});
test("different YouTube evidence is a conflict; aliases are not guessed", () => {
	assert.throws(() => normalize({youtube: "@other", speedrunCom: src}), {
		code: "identity_conflict",
	});
	assert.throws(
		() =>
			normalize({
				youtube: "https://youtube.com/channel/UC" + "A".repeat(22),
				speedrunCom: src,
			}),
		{code: "identity_conflict"},
	);
});
test("SRC adapter reads public YouTube profile URI", async () => {
	const client = new SpeedrunClient(
		(async () =>
			new Response(
				JSON.stringify({
					data: {
						id: "src1",
						names: {international: "Runner"},
						twitch: null,
						youtube: {uri: "https://youtube.com/@Runner"},
					},
				}),
			)) as typeof fetch,
	);
	assert.equal((await client.getUser("src1")).youtube, channel);
});

test("malformed optional SRC links preserve account and encoded query is recovered", async () => {
	for (const [uri, expected] of [
		[
			"https://www.youtube.com/channel/UCsZOd5DSrjp0WhOHBTC5Brg%3Fview_assubscriber",
			"https://www.youtube.com/channel/UCsZOd5DSrjp0WhOHBTC5Brg",
		],
		["https://youtube.com/watch?v=video", undefined],
		["not-a-url", undefined],
	] as const) {
		const client = new SpeedrunClient(
			(async () =>
				new Response(
					JSON.stringify({
						data: {
							id: "src1",
							names: {international: "Runner"},
							twitch: {uri: "https://twitch.tv/runner"},
							youtube: {uri},
						},
					}),
				)) as typeof fetch,
		);
		const user = await client.getUser("src1");
		assert.equal(user.userId, "src1");
		assert.equal(user.twitchLogin, "runner");
		assert.equal(user.youtube, expected);
	}
});
