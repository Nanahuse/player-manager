import assert from "node:assert/strict";
import test from "node:test";
import {type Directory, type Player} from "@nanahuse/player-manager-protocol";
import {directoryAccountId, validateDirectory} from "../src/domain/player.ts";
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
		twitch: {login: "first"},
		youtube: null,
		accounts: [
			{
				id: "twitch:tw1",
				service: "twitch",
				role: "primary",
				identity: {login: "first"},
			},
			{
				id: "twitch:tw2",
				service: "twitch",
				role: "secondary",
				identity: {login: "second"},
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
		players: [{playerId: "old", revision: 1, twitch: {login: "legacy"}}],
	});
	assert.equal(legacy.players[0]?.accounts?.[0]?.role, "primary");
});

test("legacy updates preserve Subs, verified accounts can switch Primary, and removal requires a choice", async () => {
	const player = multiAccountPlayer();
	player.accounts?.push({
		id: "twitch:tw3",
		service: "twitch",
		role: "secondary",
		identity: {login: "third"},
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
			typeof account.identity === "object" &&
			"login" in account.identity &&
			account.identity.login === "first",
	)?.id;
	const promoted = await service.updatePlayer("multi", changed.revision, {
		profilePrimaryByService: {twitch: "twitch:tw2"},
	});
	assert.equal(
		promoted.accounts?.find(
			(account) =>
				account.service === "twitch" &&
				typeof account.identity === "object" &&
				"login" in account.identity &&
				account.identity.login === "first",
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

test("legacy service fields promote a verified Sub without replacing its Account", async () => {
	const player = multiAccountPlayer();
	player.racetime = {userId: "rt-first", name: "First"};
	player.speedrunCom = {userId: "src-first", name: "First"};
	player.youtube = "https://www.youtube.com/@first";
	player.accounts?.push(
		{
			id: "racetime:rt-first",
			service: "racetime",
			role: "primary",
			identity: {userId: "rt-first", name: "First"},
		},
		{
			id: "racetime:rt-second",
			service: "racetime",
			role: "secondary",
			identity: {userId: "rt-second", name: "Second"},
		},
		{
			id: "speedrunCom:src-first",
			service: "speedrunCom",
			role: "primary",
			identity: {userId: "src-first", name: "First"},
		},
		{
			id: "speedrunCom:src-second",
			service: "speedrunCom",
			role: "secondary",
			identity: {userId: "src-second", name: "Second"},
		},
		{
			id: "youtube:https://www.youtube.com/@first",
			service: "youtube",
			role: "primary",
			identity: "https://www.youtube.com/@first",
		},
		{
			id: "youtube:https://www.youtube.com/@second",
			service: "youtube",
			role: "secondary",
			identity: "https://www.youtube.com/@second",
		},
	);
	let stored: Directory = {schemaVersion: 2, revision: 0, players: [player]};
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
	const beforeIds = new Set(player.accounts?.map((account) => account.id));
	const updated = await service.updatePlayer("multi", 1, {
		twitch: {login: "second"},
		racetime: {userId: "rt-second", name: "Second"},
		speedrunCom: {userId: "src-second", name: "Second"},
		youtube: "https://www.youtube.com/@second",
	});
	for (const account of updated.accounts ?? [])
		assert.ok(beforeIds.has(account.id));
	for (const [serviceName, expectedPrimary] of [
		["twitch", "twitch:tw2"],
		["racetime", "racetime:rt-second"],
		["speedrunCom", "speedrunCom:src-second"],
		["youtube", "youtube:https://www.youtube.com/@second"],
	] as const) {
		const group = updated.accounts?.filter(
			(account) => account.service === serviceName,
		);
		assert.equal(
			group?.find((account) => account.role === "primary")?.id,
			expectedPrimary,
			serviceName,
		);
		assert.equal(
			group?.filter((account) => account.role === "secondary").length,
			1,
			serviceName,
		);
	}
	assert.equal(updated.twitch?.login, "second");
	assert.equal(updated.racetime?.userId, "rt-second");
	assert.equal(updated.speedrunCom?.userId, "src-second");
	assert.equal(updated.youtube, "https://www.youtube.com/@second");
	const explicitlySelected = await service.updatePlayer(
		"multi",
		updated.revision,
		{
			twitch: {login: "second"},
			profilePrimaryByService: {twitch: "twitch:tw1"},
		},
	);
	assert.equal(
		explicitlySelected.accounts?.find(
			(account) => account.service === "twitch" && account.role === "primary",
		)?.id,
		"twitch:tw1",
	);
});

test("explicit deletions use stored Account IDs and never restore legacy primaries", async () => {
	const player = multiAccountPlayer();
	player.accounts?.push({
		id: "twitch:tw3",
		service: "twitch",
		role: "secondary",
		identity: {login: "third"},
	});
	let stored: Directory = {schemaVersion: 2, revision: 0, players: [player]};
	let saves = 0;
	const service = new PlayerDirectoryService(
		{
			load: async () => stored,
			save: async (next) => {
				saves++;
				stored = next;
			},
		},
		lookup,
	);
	await service.reload();
	const before = service.getPlayer("multi")!;
	await assert.rejects(
		service.updatePlayer(before.playerId, before.revision, {
			twitch: {login: "first"},
			removeAccountIds: ["twitch:tw1"],
		}),
		{code: "identity_conflict"},
	);
	await assert.rejects(
		service.updatePlayer(before.playerId, before.revision, {
			removeAccountIds: ["twitch:tw1"],
			profilePrimaryByService: {twitch: "twitch:tw1"},
		}),
		{code: "invalid_input"},
	);
	assert.equal(saves, 0);
	assert.deepEqual(service.getPlayer("multi"), before);
	const switched = await service.updatePlayer(
		before.playerId,
		before.revision,
		{
			twitch: {login: "first"},
			removeAccountIds: ["twitch:tw1"],
			profilePrimaryByService: {twitch: "twitch:tw2"},
		},
	);
	assert.deepEqual(
		switched.accounts
			?.filter((account) => account.service === "twitch")
			.map((account) => [account.id, account.role]),
		[
			["twitch:tw2", "primary"],
			["twitch:tw3", "secondary"],
		],
	);
	assert.equal(switched.twitch?.login, "second");
	assert.equal(saves, 1);
});

test("generic URL deletion is explicit, partial updates preserve accounts, and delete plus re-add is rejected", async () => {
	let stored: Directory = {
		schemaVersion: 2,
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
	const first = await service.updatePlayer("multi", 1, {
		manualDisplayName: "Changed",
	});
	assert.deepEqual(
		first.accounts?.map((account) => account.id),
		multiAccountPlayer().accounts?.map((account) => account.id),
	);
	const urlAccount = first.accounts!.find(
		(account) => account.id === "https://github.com/second",
	)!;
	await assert.rejects(
		service.updatePlayer("multi", first.revision, {
			profileAccounts: [urlAccount.profileUrl!],
			removeAccountIds: [urlAccount.id],
		}),
		{code: "invalid_input"},
	);
	const removed = await service.updatePlayer("multi", first.revision, {
		removeAccountIds: [urlAccount.id],
	});
	assert.equal(
		removed.accounts?.some((account) => account.id === urlAccount.id),
		false,
	);
	assert.equal(
		removed.accounts?.find((account) => account.service === "github.com")?.role,
		"primary",
	);
	const mutated = await service.mutate([
		{
			type: "update",
			ref: "remove-last-url",
			playerId: "multi",
			revision: removed.revision,
			input: {removeAccountIds: ["https://github.com/first"]},
		},
	]);
	assert.equal(mutated.results[0]?.type, "update");
	if (mutated.results[0]?.type === "update") {
		assert.equal(
			mutated.results[0].player.accounts?.some(
				(account) => account.service === "github.com",
			),
			false,
		);
		assert.deepEqual(
			mutated.results[0].player.accounts?.map((account) => account.id),
			["twitch:tw1", "twitch:tw2"],
		);
	}
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
	assert.equal(JSON.parse(rows[2]![11]!).length, 4);
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
	const grouped = await service.createPlayer({
		profileAccounts: ["https://example.net/a", "https://example.net/b"],
	});
	assert.deepEqual(
		grouped.accounts
			?.filter((account) => account.service === "example.net")
			.map((account) => [account.profileUrl, account.role]),
		[
			["https://example.net/a", "primary"],
			["https://example.net/b", "secondary"],
		],
	);
	const selected = await service.createPlayer({
		profileAccounts: ["https://example.net/c", "https://example.net/d"],
		profilePrimaryByService: {
			"example.net": directoryAccountId("example.net", "https://example.net/d"),
		},
	});
	assert.equal(
		selected.accounts?.find((account) => account.role === "primary")
			?.profileUrl,
		"https://example.net/d",
	);
	const mutated = await service.mutate([
		{
			type: "create",
			ref: "custom",
			input: {
				profileAccounts: [
					"https://example.org/profile/first",
					"https://example.org/profile/second",
				],
			},
		},
	]);
	assert.equal(mutated.results[0]?.type, "create");
	if (mutated.results[0]?.type === "create")
		assert.deepEqual(
			mutated.results[0].player.accounts
				?.filter((account) => account.service === "example.org")
				.map((account) => account.role),
			["primary", "secondary"],
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

test("update and mutate add multiple URLs to a Player without that service", async () => {
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
	const updatedPlayer = await service.createPlayer({
		manualDisplayName: "Update",
	});
	const updated = await service.updatePlayer(
		updatedPlayer.playerId,
		updatedPlayer.revision,
		{
			profileAccounts: [
				"https://example.io/first",
				"https://example.io/second",
			],
		},
	);
	assert.deepEqual(
		updated.accounts?.map((account) => [account.profileUrl, account.role]),
		[
			["https://example.io/first", "primary"],
			["https://example.io/second", "secondary"],
		],
	);
	const mutatedPlayer = await service.createPlayer({
		manualDisplayName: "Mutate",
	});
	const mutated = await service.mutate([
		{
			type: "update",
			ref: "update",
			playerId: mutatedPlayer.playerId,
			revision: mutatedPlayer.revision,
			input: {
				profileAccounts: [
					"https://example.edu/first",
					"https://example.edu/second",
				],
			},
		},
	]);
	assert.equal(mutated.results[0]?.type, "update");
	if (mutated.results[0]?.type === "update")
		assert.deepEqual(
			mutated.results[0].player.accounts?.map((account) => account.role),
			["primary", "secondary"],
		);
});
