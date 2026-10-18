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
				id: "src-sub",
				service: "speedrunCom",
				role: "secondary",
				identity: {userId: "src2", name: "SRC Two"},
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {promise, resolve, reject};
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
		[
			"src2",
			{
				userId: "src2",
				name: "SRC Two",
				weblink: "https://www.speedrun.com/users/SRC_Two",
			},
		],
	]);
	let clock = 0;
	let override: ((id: string) => Promise<ProviderIdentity>) | null = null;
	const lookup: UserLookup = {
		getUser: (id) => {
			calls.push(id);
			if (override) return override(id);
			if (mode.kind === "failure")
				return Promise.reject(new Error("network down"));
			if (mode.kind === "rate_limited")
				return Promise.reject(new DirectoryError("rate_limited", "slow down"));
			const profile = profiles.get(id);
			return profile
				? Promise.resolve(profile)
				: Promise.reject(
						new DirectoryError("lookup_failed", `No profile ${id}`),
					);
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
		setOverride: (value: typeof override) => {
			override = value;
		},
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
	assert.equal(await url("src-sub"), "https://www.speedrun.com/users/SRC_Two");
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

test("concurrent requests for the same account share one external lookup", async () => {
	const {service, calls, setOverride} = await setup();
	const pending = deferred<ProviderIdentity>();
	setOverride(() => pending.promise);
	const first = service.getAccountProfileUrl("src-primary");
	const second = service.getAccountProfileUrl("src-primary");
	assert.deepEqual(calls, ["src1"]);
	pending.resolve({
		userId: "src1",
		name: "Shared",
		weblink: "https://www.speedrun.com/users/Shared",
	});
	assert.deepEqual(await first, {
		url: "https://www.speedrun.com/users/Shared",
	});
	assert.deepEqual(await second, {
		url: "https://www.speedrun.com/users/Shared",
	});
	assert.deepEqual(calls, ["src1"]);
});

test("different accounts are looked up independently", async () => {
	const {service, calls} = await setup();
	const [a, b] = await Promise.all([
		service.getAccountProfileUrl("src-primary"),
		service.getAccountProfileUrl("src-sub"),
	]);
	assert.equal(a.url, "https://www.speedrun.com/users/SRC_One");
	assert.equal(b.url, "https://www.speedrun.com/users/SRC_Two");
	assert.deepEqual([...calls].sort(), ["src1", "src2"]);
});

test("Directory changes invalidate cached URL results", async () => {
	const {service, calls, profiles} = await setup();
	assert.equal(
		(await service.getAccountProfileUrl("src-primary")).url,
		"https://www.speedrun.com/users/SRC_One",
	);
	profiles.set("src1", {
		userId: "src1",
		name: "Renamed",
		weblink: "https://www.speedrun.com/users/Renamed",
	});
	await service.mutate([
		{
			type: "update",
			ref: "rename",
			playerId: "runner",
			revision: 1,
			input: {manualDisplayName: "Renamed"},
		},
	]);
	assert.equal(
		(await service.getAccountProfileUrl("src-primary")).url,
		"https://www.speedrun.com/users/Renamed",
	);
	assert.deepEqual(calls, ["src1", "src1"]);
});

test("a lookup that finishes after a Directory change is not cached", async () => {
	const {service, calls, profiles, setOverride} = await setup();
	const pending = deferred<ProviderIdentity>();
	setOverride(() => pending.promise);
	const running = service.getAccountProfileUrl("src-primary");
	await service.mutate([
		{
			type: "update",
			ref: "rename",
			playerId: "runner",
			revision: 1,
			input: {manualDisplayName: "Changed"},
		},
	]);
	pending.resolve({
		userId: "src1",
		name: "Old",
		weblink: "https://www.speedrun.com/users/Old",
	});
	assert.equal((await running).url, "https://www.speedrun.com/users/Old");
	setOverride(null);
	profiles.set("src1", {
		userId: "src1",
		name: "New",
		weblink: "https://www.speedrun.com/users/New",
	});
	assert.equal(
		(await service.getAccountProfileUrl("src-primary")).url,
		"https://www.speedrun.com/users/New",
	);
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

test("external API failures surface as errors and can be retried", async () => {
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
