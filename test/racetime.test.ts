import assert from "node:assert/strict";
import test from "node:test";
import type {Directory, IdentityResolutionInput} from "../src/domain/player.ts";
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
test("RaceTime ID only resolves RaceTime -> Twitch -> SRC through both API adapters", async () => {
	const {service, urls} = fixture();
	await service.reload();
	const input: IdentityResolutionInput = {racetime: {userId: id}};
	const result = await service.resolveIdentity(input);
	assert.equal(result.status, "matched");
	assert.deepEqual(result.input.racetime, {
		userId: id,
		name: "Runner#1234",
		twitchLogin: "runner",
	});
	assert.deepEqual(result.input.twitch, {login: "runner", userId: null});
	assert.equal(result.input.speedrunCom?.userId, "src1");
	assert.equal(urls[0], `https://racetime.gg/user/${id}/data`);
	assert.match(urls[1]!, /users\?twitch=runner/);
	assert.equal(service.snapshot().players.length, 0);
});
test("profile URL and blank dashboard metadata are resolved before validation", async () => {
	const {service} = fixture();
	await service.reload();
	const result = await service.resolveIdentity({
		racetime: {
			userId: `https://racetime.gg/user/${id}`,
			name: "",
			twitchLogin: null,
		},
	});
	assert.equal(result.status, "matched");
	assert.equal(result.input.racetime?.userId, id);
});
test("unlinked RaceTime profile stays unresolved and does not search SRC", async () => {
	const {service, urls} = fixture({
		profile: {...profile, twitch_name: null, twitch_channel: null},
	});
	await service.reload();
	const result = await service.resolveIdentity({racetime: {userId: id}});
	assert.equal(result.status, "unresolved");
	assert.equal(result.input.twitch, null);
	assert.equal(urls.length, 1);
});
test("RaceTime errors do not become an unresolved or successful result", async () => {
	for (const [status, code] of [
		[404, "lookup_failed"],
		[429, "rate_limited"],
		[503, "lookup_failed"],
	] as const) {
		const {service, urls} = fixture({status});
		await service.reload();
		await assert.rejects(service.resolveIdentity({racetime: {userId: id}}), {
			code,
		});
		assert.equal(urls.length, 1);
	}
});
test("multiple SRC accounts sharing RaceTime Twitch remain ambiguous", async () => {
	const users = ["src1", "src2"].map((id) => ({
		id,
		names: {international: id},
		twitch: {uri: "https://twitch.tv/runner"},
	}));
	const {service} = fixture({users});
	await service.reload();
	assert.equal(
		(await service.resolveIdentity({racetime: {userId: id}})).status,
		"ambiguous",
	);
});
test("explicit Twitch disagreement remains a conflict", async () => {
	const {service} = fixture();
	await service.reload();
	assert.equal(
		(
			await service.resolveIdentity({
				racetime: {userId: id},
				twitch: {login: "different", userId: null},
			})
		).status,
		"conflict",
	);
});
test("wrong profile IDs and invalid Twitch links fail closed", async () => {
	for (const broken of [
		{...profile, id: "other"},
		{...profile, twitch_channel: "https://evil.example/runner"},
	]) {
		const {service} = fixture({profile: broken});
		await service.reload();
		await assert.rejects(service.resolveIdentity({racetime: {userId: id}}), {
			code: "lookup_failed",
		});
	}
});
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
