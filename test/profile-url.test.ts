import assert from "node:assert/strict";
import test from "node:test";
import {
	type Directory,
	type Player,
	type ProviderIdentity,
} from "@nanahuse/player-manager-protocol";
import {DirectoryError, validateDirectory} from "../src/domain/player.ts";
import {AccountProfileUrlResolver} from "../src/extension/profile-url.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";
import type {UserLookup} from "../src/extension/speedrun.ts";

function runner(): Player {
	return {
		playerId: "runner",
		revision: 1,
		manualDisplayName: "Runner",
		racetime: {userId: "rt1", name: "Race One"},
		speedrunCom: {userId: "src1", name: "SRC One"},
		twitch: {login: "runner"},
		youtube: "https://www.youtube.com/@runner",
		accounts: [
			{
				id: "rt-primary",
				service: "racetime",
				role: "primary",
				identity: {userId: "rt1", name: "Race One"},
			},
			{
				id: "rt-sub",
				service: "racetime",
				role: "secondary",
				identity: {userId: "rt2", name: "Race Two"},
			},
			{
				id: "src-primary",
				service: "speedrunCom",
				role: "primary",
				identity: {userId: "src1", name: "SRC One"},
			},
			{
				id: "tw-primary",
				service: "twitch",
				role: "primary",
				identity: {login: "runner"},
			},
			{
				id: "tw-sub",
				service: "twitch",
				role: "secondary",
				identity: {login: "other"},
			},
			{
				id: "yt-primary",
				service: "youtube",
				role: "primary",
				identity: "https://www.youtube.com/@runner",
			},
			{
				id: "gh-primary",
				service: "github.com",
				role: "primary",
				profileUrl: "https://github.com/runner",
				identity: "https://github.com/runner",
			},
		],
	};
}

async function setup(players: Player[] = [runner()]) {
	const stored: Directory = validateDirectory({
		schemaVersion: 2,
		revision: 1,
		players,
	});
	const calls: string[] = [];
	const mode: {kind: "auto" | "failure" | "rate_limited"} = {kind: "auto"};
	const profiles = new Map<string, ProviderIdentity>([
		[
			"src1",
			{
				userId: "src1",
				name: "SRC One",
				weblink: "https://www.speedrun.com/users/SRC_One",
			},
		],
	]);
	let clock = 0;
	const lookup: UserLookup = {
		getUser: async (id) => {
			calls.push(id);
			if (mode.kind === "failure") throw new Error("network down");
			if (mode.kind === "rate_limited")
				throw new DirectoryError("rate_limited", "slow down");
			const profile = profiles.get(id);
			if (!profile)
				throw new DirectoryError("lookup_failed", `No profile for ${id}`);
			return profile;
		},
		searchUsers: async () => ({users: [], hasMore: false}),
	};
	const service = new PlayerDirectoryService(
		{
			load: async () => structuredClone(stored),
			save: async () => {},
		},
		lookup,
		undefined,
		{
			getUser: async (id) => ({userId: id, name: id, twitchLogin: null}),
			searchUsers: async () => [],
		},
		undefined,
		undefined,
		new AccountProfileUrlResolver(lookup, () => clock),
	);
	await service.reload();
	return {
		service,
		calls,
		mode,
		profiles,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

test("resolves profile URLs for every supported service and both roles", async () => {
	const {service} = await setup();
	const url = async (accountId: string) =>
		(await service.getAccountProfileUrl(accountId)).url;
	assert.equal(await url("rt-primary"), "https://racetime.gg/user/rt1");
	assert.equal(await url("rt-sub"), "https://racetime.gg/user/rt2");
	assert.equal(await url("tw-primary"), "https://www.twitch.tv/runner");
	assert.equal(await url("tw-sub"), "https://www.twitch.tv/other");
	assert.equal(await url("yt-primary"), "https://www.youtube.com/@runner");
	assert.equal(await url("gh-primary"), "https://github.com/runner");
	assert.equal(
		await url("src-primary"),
		"https://www.speedrun.com/users/SRC_One",
	);
});

test("Speedrun.com resolves the current official weblink for the stored user ID", async () => {
	const {service, calls, profiles, advance} = await setup();
	assert.equal(
		(await service.getAccountProfileUrl("src-primary")).url,
		"https://www.speedrun.com/users/SRC_One",
	);
	profiles.set("src1", {
		userId: "src1",
		name: "Renamed",
		weblink: "https://www.speedrun.com/users/Renamed",
	});
	advance(11 * 60 * 1000);
	assert.equal(
		(await service.getAccountProfileUrl("src-primary")).url,
		"https://www.speedrun.com/users/Renamed",
	);
	assert.deepEqual(calls, ["src1", "src1"]);
});

test("cached lookups avoid repeated external requests until they expire", async () => {
	const {service, calls, advance} = await setup();
	await service.getAccountProfileUrl("src-primary");
	await service.getAccountProfileUrl("src-primary");
	assert.deepEqual(calls, ["src1"]);
	advance(10 * 60 * 1000 + 1);
	await service.getAccountProfileUrl("src-primary");
	assert.deepEqual(calls, ["src1", "src1"]);
});

test("missing or invalid Speedrun.com links produce lookup_failed", async () => {
	const {service, profiles} = await setup();
	profiles.set("src1", {userId: "src1", name: "No link"});
	await assert.rejects(service.getAccountProfileUrl("src-primary"), {
		code: "lookup_failed",
	});
	profiles.set("src1", {
		userId: "src1",
		name: "Bad link",
		weblink: "javascript:alert(1)",
	});
	await assert.rejects(service.getAccountProfileUrl("src-primary"), {
		code: "lookup_failed",
	});
});

test("external API failures surface as errors without caching", async () => {
	const {service, calls, mode} = await setup();
	mode.kind = "failure";
	await assert.rejects(service.getAccountProfileUrl("src-primary"), {
		code: "lookup_failed",
	});
	mode.kind = "auto";
	assert.equal(
		(await service.getAccountProfileUrl("src-primary")).url,
		"https://www.speedrun.com/users/SRC_One",
	);
	assert.deepEqual(calls, ["src1", "src1"]);
});

test("rate limits from the external API are preserved", async () => {
	const {service, mode} = await setup();
	mode.kind = "rate_limited";
	await assert.rejects(service.getAccountProfileUrl("src-primary"), {
		code: "rate_limited",
	});
});

test("unknown accounts and invalid requests are rejected without touching the Directory", async () => {
	const {service} = await setup();
	const before = service.snapshot();
	await assert.rejects(service.getAccountProfileUrl("missing"), {
		code: "account_not_found",
	});
	await assert.rejects(service.getAccountProfileUrl(""), {
		code: "invalid_input",
	});
	assert.deepEqual(service.snapshot(), before);
	assert.equal(service.getPlayer("runner")?.playerId, "runner");
});

test("URL resolution failures do not affect Directory reads", async () => {
	const {service, mode} = await setup();
	mode.kind = "failure";
	await assert.rejects(service.getAccountProfileUrl("src-primary"), {
		code: "lookup_failed",
	});
	mode.kind = "auto";
	assert.equal(service.snapshot().players.length, 1);
	assert.equal(service.findAccount("tw-primary")?.player.playerId, "runner");
	assert.equal(
		(await service.getAccountProfileUrl("rt-primary")).url,
		"https://racetime.gg/user/rt1",
	);
});
