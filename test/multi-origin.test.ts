import assert from "node:assert/strict";
import test from "node:test";
import type {Directory} from "@nanahuse/player-manager-protocol";
import {
	RaceTimeClient,
	type RaceTimeLookup,
} from "../src/extension/racetime.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";
import type {UserLookup} from "../src/extension/speedrun.ts";

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
