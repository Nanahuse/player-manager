import assert from "node:assert/strict";
import test from "node:test";
import type {
	Directory,
	IdentityResolutionInput,
} from "@nanahuse/player-manager-protocol";
import {RaceTimeClient, raceTimeId} from "../src/extension/racetime.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";
import {SpeedrunClient} from "../src/extension/speedrun.ts";

const id = "xldAMBlqvY3aOP57";
const profile = {
	id,
	full_name: "Runner#1234",
	twitch_name: "DISPLAY",
	twitch_channel: "https://www.twitch.tv/Runner",
};
function fixture(
	options: {
		profile?: unknown;
		users?: unknown[];
		hasMore?: boolean;
		status?: number;
	} = {},
) {
	const urls: string[] = [];
	const fetcher = (async (url: string | URL | Request) => {
		urls.push(String(url));
		if (String(url).startsWith("https://racetime.gg/"))
			return new Response(JSON.stringify(options.profile ?? profile), {
				status: options.status ?? 200,
			});
		return new Response(
			JSON.stringify({
				data: options.users ?? [
					{
						id: "src1",
						names: {international: "Runner"},
						twitch: {uri: "https://www.twitch.tv/runner"},
					},
				],
				pagination: {links: options.hasMore ? [{rel: "next"}] : []},
			}),
		);
	}) as typeof fetch;
	let stored: Directory = {schemaVersion: 1, revision: 0, players: []};
	const service = new PlayerDirectoryService(
		{
			load: async () => stored,
			save: async (value) => {
				stored = value;
			},
		},
		new SpeedrunClient(fetcher),
		undefined,
		new RaceTimeClient(fetcher),
	);
	return {service, urls};
}
test("RaceTime input cannot redirect profile fetches to another host or path", () => {
	assert.equal(raceTimeId(`https://racetime.gg/user/${id}/`), id);
	for (const value of [
		"https://example.com/user/a",
		"../a",
		"https://racetime.gg/user/a/data",
		"https://racetime.gg:8443/user/a",
	])
		assert.throws(() => raceTimeId(value), {code: "invalid_input"});
});
