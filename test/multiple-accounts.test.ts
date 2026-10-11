import assert from "node:assert/strict";
import test from "node:test";
import {type Directory, type Player} from "@nanahuse/player-manager-protocol";
import {validateDirectory} from "../src/domain/player.ts";
import {collectMatching} from "../src/extension/matching/collect.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";
import {fromRows, toRows} from "../src/extension/sheets.ts";
import {analyze} from "../src/matching/analyze.ts";
import {buildCommitPlan} from "../src/matching/commit.ts";

const lookup = {
	getUser: async (userId: string) => ({userId, name: userId}),
	searchUsers: async () => ({users: [], hasMore: false}),
};

function multiAccountPlayer(): Player {
	return {
		playerId: "multi",
		revision: 1,
		manualDisplayName: "Runner",
		racetime: null,
		speedrunCom: null,
		twitch: {userId: "tw1", login: "first"},
		youtube: null,
		accounts: [
			{
				id: "twitch:tw1",
				service: "twitch",
				role: "primary",
				identity: {userId: "tw1", login: "first"},
			},
			{
				id: "twitch:tw2",
				service: "twitch",
				role: "secondary",
				identity: {userId: "tw2", login: "second"},
			},
			{
				id: "https://github.com/first",
				service: "github.com",
				role: "primary",
				profileUrl: "https://github.com/first",
				identity: "https://github.com/first",
			},
			{
				id: "https://github.com/second",
				service: "github.com",
				role: "secondary",
				profileUrl: "https://github.com/second",
				identity: "https://github.com/second",
			},
		],
	};
}

test("Directory allows multiple accounts per service with one Primary and migrates legacy singletons", () => {
	const directory = validateDirectory({
		schemaVersion: 1,
		revision: 2,
		players: [multiAccountPlayer()],
	});
	assert.equal(
		directory.players[0]?.accounts?.filter(
			(account) => account.service === "twitch",
		).length,
		2,
	);
	assert.equal(directory.players[0]?.twitch?.login, "first");
	assert.throws(
		() =>
			validateDirectory({
				schemaVersion: 1,
				revision: 0,
				players: [
					{
						...multiAccountPlayer(),
						accounts: multiAccountPlayer().accounts?.map((account) => ({
							...account,
							role: "secondary" as const,
						})),
					},
				],
			}),
		{code: "invalid_input"},
	);
	assert.throws(
		() =>
			validateDirectory({
				schemaVersion: 1,
				revision: 0,
				players: [
					{
						...multiAccountPlayer(),
						accounts: multiAccountPlayer().accounts?.map((account) => ({
							...account,
							role: "primary" as const,
						})),
					},
				],
			}),
		{code: "invalid_input"},
	);
	const legacy = validateDirectory({
		schemaVersion: 1,
		revision: 0,
		players: [
			{playerId: "old", revision: 1, twitch: {userId: null, login: "legacy"}},
		],
	});
	assert.equal(legacy.players[0]?.accounts?.[0]?.role, "primary");
});

test("legacy updates preserve Subs, verified accounts can switch Primary, and removal requires a choice", async () => {
	const player = multiAccountPlayer();
	player.accounts?.push({
		id: "twitch:tw3",
		service: "twitch",
		role: "secondary",
		identity: {userId: "tw3", login: "third"},
	});
	let stored: Directory = {
		schemaVersion: 1,
		revision: 0,
		players: [player],
	};
	const service = new PlayerDirectoryService(
		{
			load: async () => stored,
			save: async (next) => {
				stored = next;
			},
		},
		lookup,
	);
	await service.reload();
	const changed = await service.updatePlayer("multi", 1, {
		manualDisplayName: "New",
	});
	assert.deepEqual(
		changed.accounts
			?.filter((account) => account.service === "twitch")
			.map((account) => account.role),
		["primary", "secondary", "secondary"],
	);
	const oldPrimaryId = changed.accounts?.find(
		(account) =>
			account.service === "twitch" &&
			JSON.stringify(account.identity).includes("tw1"),
	)?.id;
	const promoted = await service.updatePlayer("multi", changed.revision, {
		profilePrimaryByService: {twitch: "twitch:tw2"},
	});
	assert.equal(
		promoted.accounts?.find(
			(account) =>
				account.service === "twitch" &&
				JSON.stringify(account.identity).includes("tw1"),
		)?.id,
		oldPrimaryId,
	);
	const changedPrimary = promoted.accounts?.find(
		(account) => account.service === "twitch" && account.role === "primary",
	);
	assert.ok(changedPrimary);
	await assert.rejects(
		service.updatePlayer("multi", promoted.revision, {
			removeAccountIds: [changedPrimary.id],
		}),
		{code: "identity_conflict"},
	);
	const removed = await service.updatePlayer("multi", promoted.revision, {
		removeAccountIds: [changedPrimary.id],
		profilePrimaryByService: {twitch: oldPrimaryId!},
	});
	assert.deepEqual(
		removed.accounts
			?.filter((account) => account.service === "twitch")
			.map((account) => account.role),
		["primary", "secondary"],
	);
	assert.equal(removed.twitch?.login, "first");
});

test("legacy find searches Primary accounts while explicit account lookup includes Sub accounts", async () => {
	let stored: Directory = {
		schemaVersion: 1,
		revision: 0,
		players: [multiAccountPlayer()],
	};
	const service = new PlayerDirectoryService(
		{
			load: async () => stored,
			save: async (next) => {
				stored = next;
			},
		},
		lookup,
	);
	await service.reload();
	assert.equal(service.find("twitch:second"), null);
	assert.equal(service.findAccount("twitch:tw2")?.account.role, "secondary");
});

test("Sheets JSON account column roundtrips arbitrary service accounts", () => {
	const directory = validateDirectory({
		schemaVersion: 1,
		revision: 4,
		players: [multiAccountPlayer()],
	});
	const rows = toRows(directory);
	assert.deepEqual(fromRows(rows), directory);
	assert.equal(JSON.parse(rows[2]![12]!).length, 4);
});

test("Registration matches supported profile URLs and keeps generic URLs as independent accounts", async () => {
	const directory: Directory = {schemaVersion: 1, revision: 0, players: []};
	let lookups = 0;
	const collection = await collectMatching({
		directory,
		input: {
			profileAccounts: [
				"https://www.twitch.tv/Runner",
				"https://github.com/first",
				"https://github.com/second",
			],
		},
		racetime: {
			getUser: async (userId) => {
				lookups++;
				return {userId, name: userId};
			},
			searchUsers: async () => [],
		},
		src: {
			getUser: async (userId) => {
				lookups++;
				return {userId, name: userId};
			},
			searchUsers: async () => ({users: [], hasMore: false}),
		},
	});
	assert.equal(
		collection.accounts.filter((account) => account.service === "twitch")
			.length,
		1,
	);
	assert.equal(
		collection.accounts.filter((account) => account.service === "github.com")
			.length,
		2,
	);
	assert.equal(lookups, 0);
	const resolution = analyze(collection);
	const plan = buildCommitPlan(resolution);
	assert.deepEqual(
		plan.creates[0]?.input.accounts?.map((account) => [
			account.service,
			account.role,
		]),
		[
			["twitch", "primary"],
			["github.com", "primary"],
			["github.com", "secondary"],
		],
	);
});

test("create and mutate accept generic profile URLs while rejecting raw Account arrays", async () => {
	let stored: Directory = {schemaVersion: 2, revision: 0, players: []};
	const service = new PlayerDirectoryService(
		{
			load: async () => stored,
			save: async (next) => {
				stored = next;
			},
		},
		lookup,
	);
	await service.reload();
	const created = await service.createPlayer({
		profileAccounts: ["https://github.com/first"],
	});
	assert.equal(created.accounts?.[0]?.service, "github.com");
	assert.equal(created.accounts?.[0]?.role, "primary");
	const mutated = await service.mutate([
		{
			type: "create",
			ref: "custom",
			input: {profileAccounts: ["https://example.org/profile/second"]},
		},
	]);
	assert.equal(mutated.results[0]?.type, "create");
	if (mutated.results[0]?.type === "create")
		assert.equal(
			mutated.results[0].player.accounts?.[0]?.service,
			"example.org",
		);
	await assert.rejects(
		service.createPlayer({
			accounts: [
				{
					id: "injected",
					service: "github.com",
					role: "primary",
					profileUrl: "https://github.com/injected",
					identity: "https://github.com/injected",
				},
			],
		}),
		{code: "invalid_input"},
	);
});
