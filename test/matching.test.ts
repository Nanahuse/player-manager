import assert from "node:assert/strict";
import test from "node:test";
import type {Directory, Player} from "@nanahuse/player-manager-protocol";
import {collectMatching} from "../src/extension/matching/collect.ts";
import {
	analyze,
	approveConflict,
	assignAccount,
	assignMergeSurvivor,
} from "../src/matching/analyze.ts";
import {
	components,
	dedupeAccounts,
	dedupeEvidence,
} from "../src/matching/graph.ts";
import type {Collection} from "../src/matching/model.ts";
import {buildCommitPlan} from "../src/matching/commit.ts";

const player = (id: string, racetime: string, twitch: string): Player => ({
	playerId: id,
	revision: 1,
	manualDisplayName: null,
	racetime: {userId: racetime, name: id},
	speedrunCom: null,
	twitch: {userId: null, login: twitch},
	youtube: null,
});
const directory = (...players: Player[]): Directory => ({
	schemaVersion: 1,
	revision: 1,
	players,
});
const empty = (
	d: Directory,
	accounts: Collection["accounts"],
	evidence: Collection["evidence"],
	inputAccountIds: string[] = [],
): Collection => ({
	directory: d,
	input: {},
	accounts,
	evidence,
	profiles: [],
	candidates: [],
	warnings: [],
	errors: [],
	requiredAccounts: [],
	newPlayerId: "new:p",
	inputAccountIds,
	seedAccountIds: inputAccountIds,
});

test("Directory creates User evidence and keeps unrelated players out", async () => {
	const d = directory(
		player("a", "rtA", "same"),
		player("unrelated", "rtZ", "other"),
	);
	const collection = await collectMatching({
		directory: d,
		input: {racetime: "rtA"},
		racetime: {
			getUser: async () => ({
				userId: "rtA",
				name: "A",
				twitchLogin: "different",
			}),
			searchUsers: async () => [],
		},
		src: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => ({users: [], hasMore: false}),
		},
	});
	assert(collection.evidence.some((e) => e.source === "user"));
	const result = analyze(collection);
	assert.deepEqual(
		result.players.filter((p) => p.kind === "existing").map((p) => p.id),
		["a"],
	);
	assert(result.accounts.some((a) => a.keys.includes("twitch:different")));
	assert(result.accounts.some((a) => a.keys.includes("twitch:same")));
});

test("accounts dedupe across Twitch id and login aliases", () => {
	const accounts = dedupeAccounts([
		{id: "twitch-id:1", service: "twitch", keys: ["twitch-id:1"]},
		{
			id: "twitch:runner",
			service: "twitch",
			keys: ["twitch-id:1", "twitch:runner"],
		},
	]);
	assert.equal(accounts.length, 1);
});

test("evidence conflicts can be approved without mutating assignment", () => {
	const a = player("a", "rtA", "a"),
		b = player("b", "rtB", "b");
	const collection = empty(
		directory(a, b),
		[
			{id: "racetime:rtA", service: "racetime", keys: ["racetime:rtA"]},
			{id: "twitch:b", service: "twitch", keys: ["twitch:b"]},
		],
		[{id: "", source: "racetime", accounts: ["racetime:rtA", "twitch:b"]}],
		["racetime:rtA"],
	);
	const resolution = analyze(collection);
	assert.equal(resolution.conflicts.length, 1);
	assert.equal(resolution.conflicts[0]?.status, "conflict");
	assert.equal(
		approveConflict(resolution, resolution.conflicts[0]!.id).conflicts[0]
			?.status,
		"resolved",
	);
});

test("ambiguous search results remain candidates and lookup failures warn", async () => {
	const profiles = ["one", "two"].map((userId) => ({
		userId,
		name: userId,
		twitchLogin: "runner",
	}));
	const result = await collectMatching({
		directory: directory(),
		input: {twitch: {login: "runner"}},
		racetime: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => [],
		},
		src: {
			getUser: async () => {
				throw Error("offline");
			},
			searchUsers: async () => ({users: profiles, hasMore: false}),
		},
		requiredAccounts: [{service: "racetime", value: "rt-required"}],
	});
	assert.equal(result.candidates.length, 2);
	assert.equal(result.warnings.length, 0);
	assert.equal(result.requiredAccounts[0]?.service, "racetime");
});

test("a RaceTime profile can lead through Twitch to one SRC identity", async () => {
	const d = directory();
	const result = await collectMatching({
		directory: d,
		input: {racetime: "rtA"},
		racetime: {
			getUser: async () => ({
				userId: "rtA",
				name: "Runner",
				twitchLogin: "runner",
			}),
			searchUsers: async () => [],
		},
		src: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => ({
				users: [{userId: "srcA", name: "Runner", twitchLogin: "runner"}],
				hasMore: false,
			}),
		},
	});
	assert(result.evidence.some((e) => e.source === "racetime"));
	assert(result.evidence.some((e) => e.source === "src"));
	assert(result.accounts.some((a) => a.keys.includes("speedrunCom:srcA")));
	assert.deepEqual(d.players, []);
});

test("new accounts infer one existing owner while existing assignments stay fixed", () => {
	const a = player("a", "rtA", "runner");
	const collection = empty(
		directory(a),
		[
			{
				id: "racetime:racetime:rtA",
				service: "racetime",
				keys: ["racetime:rtA"],
			},
			{id: "twitch:twitch:runner", service: "twitch", keys: ["twitch:runner"]},
			{
				id: "youtube:youtube:channel",
				service: "youtube",
				keys: ["youtube:channel"],
			},
		],
		[
			{
				id: "",
				source: "user",
				accounts: ["racetime:racetime:rtA", "twitch:twitch:runner"],
			},
			{
				id: "",
				source: "src",
				accounts: ["racetime:racetime:rtA", "youtube:youtube:channel"],
			},
		],
		["racetime:racetime:rtA"],
	);
	const result = analyze(collection);
	assert.equal(
		result.assignments.find((a) => a.accountId.includes("racetime"))?.ownerId,
		"a",
	);
	assert.equal(
		result.assignments.find((a) => a.accountId.includes("youtube"))?.ownerId,
		"a",
	);
	assert.equal(
		result.assignments.find((a) => a.accountId.includes("twitch"))?.ownerId,
		"a",
	);
});

test("multiple existing players connected by external evidence produce a merge proposal", () => {
	const a = player("a", "rtA", "a");
	const b = player("b", "rtB", "b");
	const collection = empty(
		directory(a, b),
		[
			{id: "racetime:rtA", service: "racetime", keys: ["racetime:rtA"]},
			{id: "twitch:b", service: "twitch", keys: ["twitch:b"]},
		],
		[{id: "", source: "src", accounts: ["racetime:rtA", "twitch:b"]}],
		["racetime:rtA"],
	);
	const result = analyze(collection);
	assert.deepEqual(result.mergeProposal?.playerIds, ["a", "b"]);
	assert.equal(
		result.assignments.find((assignment) => assignment.ownerId === "b")
			?.ownerId,
		"b",
	);
});

test("cyclic evidence terminates and same-service accounts remain distinct", () => {
	const accounts = ["rtA", "rtB", "srcA"].map((id) => ({
		id,
		service: "racetime" as const,
		keys: [id],
	}));
	const links = [
		{id: "", source: "user" as const, accounts: ["rtA", "rtB"]},
		{id: "", source: "src" as const, accounts: ["rtB", "srcA"]},
		{id: "", source: "input" as const, accounts: ["rtA", "srcA"]},
	];
	assert.equal(dedupeAccounts(accounts).length, 3);
	assert.equal(components(accounts, dedupeEvidence(links)).length, 1);
});

test("explicit profile failures are errors and do not remove collected accounts", async () => {
	const result = await collectMatching({
		directory: directory(),
		input: {racetime: "rtA"},
		racetime: {
			getUser: async () => {
				throw Error("offline");
			},
			searchUsers: async () => [],
		},
		src: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => ({users: [], hasMore: false}),
		},
	});
	assert.equal(result.errors.length, 1);
	assert(
		result.accounts.some((account) => account.keys.includes("racetime:rtA")),
	);
});

test("optional search failures are warnings and preserve the input account", async () => {
	const result = await collectMatching({
		directory: directory(),
		input: {twitch: {login: "runner"}},
		racetime: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => [],
		},
		src: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => {
				throw Error("offline");
			},
		},
	});
	assert.equal(result.errors.length, 0);
	assert.equal(result.warnings.length, 1);
	assert(
		result.accounts.some((account) => account.keys.includes("twitch:runner")),
	);
});

test("single-account evidence sets survive graph normalization for every source", () => {
	const evidence = dedupeEvidence([
		{id: "", source: "user", accounts: ["racetime:rtA"]},
		{id: "", source: "input", accounts: ["twitch:runner"]},
		{id: "", source: "racetime", accounts: ["racetime:rtA"]},
		{id: "", source: "src", accounts: ["speedrunCom:srcA"]},
	]);
	assert.deepEqual(evidence.map((entry) => entry.source).sort(), [
		"input",
		"racetime",
		"src",
		"user",
	]);
});

test("Required-only seed explores profile and Twitch-linked SRC without making Required evidence", async () => {
	const result = await collectMatching({
		directory: directory(),
		input: {},
		requiredAccounts: [{service: "racetime", value: "rtA"}],
		racetime: {
			getUser: async () => ({
				userId: "rtA",
				name: "Runner",
				twitchLogin: "runner",
			}),
			searchUsers: async () => [],
		},
		src: {
			getUser: async (id) => ({
				userId: id,
				name: "Runner",
				twitchLogin: "runner",
			}),
			searchUsers: async (query, mode) =>
				mode === "twitch" && query === "runner"
					? {
							users: [{userId: "srcA", name: "Runner", twitchLogin: "runner"}],
							hasMore: false,
						}
					: {users: [], hasMore: false},
		},
	});
	assert(
		result.accounts.some((account) =>
			account.keys.includes("speedrunCom:srcA"),
		),
	);
	assert(result.evidence.some((entry) => entry.source === "racetime"));
	assert(result.evidence.some((entry) => entry.source === "src"));
	assert(!result.evidence.some((entry) => entry.source === "input"));
	assert.equal(analyze(result).requiredStatus[0]?.satisfied, true);
});

test("closure follows RaceTime to Twitch to SRC to YouTube and scopes each search", async () => {
	const calls: string[] = [];
	const result = await collectMatching({
		directory: directory(player("unrelated", "rtZ", "notrunner")),
		input: {racetime: "rtA"},
		racetime: {
			getUser: async () => ({
				userId: "rtA",
				name: "Runner",
				twitchLogin: "runner",
			}),
			searchUsers: async () => [],
		},
		src: {
			getUser: async (id) => ({
				userId: id,
				name: "Runner",
				twitchLogin: "runner",
				youtube: "https://www.youtube.com/@runner",
			}),
			searchUsers: async (query, mode) => {
				calls.push(`${mode}:${query}`);
				if (mode === "twitch" && query === "runner")
					return {
						users: [
							{
								userId: "srcA",
								name: "Runner",
								twitchLogin: "runner",
								youtube: "https://www.youtube.com/@runner",
							},
						],
						hasMore: false,
					};
				if (mode === "lookup")
					return {
						users: [
							{
								userId: "srcA",
								name: "Runner",
								twitchLogin: "runner",
								youtube: "https://www.youtube.com/@runner",
							},
						],
						hasMore: false,
					};
				return {users: [], hasMore: false};
			},
		},
	});
	assert(calls.includes("twitch:runner"));
	assert(calls.includes("lookup:https://www.youtube.com/@runner"));
	assert(
		result.accounts.some((account) =>
			account.keys.includes("youtube:https://www.youtube.com/@runner"),
		),
	);
	assert(
		!analyze(result).accounts.some((account) =>
			account.keys.includes("twitch:notrunner"),
		),
	);
});

test("a search with hasMore never promotes a single exact result to evidence", async () => {
	const result = await collectMatching({
		directory: directory(),
		input: {twitch: {login: "runner", userId: "tw-01"}},
		racetime: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => [],
		},
		src: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => ({
				users: [{userId: "srcA", name: "Runner", twitchLogin: "runner"}],
				hasMore: true,
			}),
		},
	});
	assert.equal(result.candidates.length, 1);
	const twitch = result.accounts.find(
		(account) => account.service === "twitch",
	);
	assert.equal(result.candidates[0]?.originAccountId, twitch?.id);
	assert(twitch?.keys.includes("twitch-id:tw-01"));
	assert(
		result.accounts.some(
			(account) => account.id === result.candidates[0]?.originAccountId,
		),
	);
	assert(
		!result.accounts.some((account) =>
			account.keys.includes("speedrunCom:srcA"),
		),
	);
});

test("a search result matching an unrelated Directory account is not adopted", async () => {
	const result = await collectMatching({
		directory: directory(player("unrelated", "rtZ", "runner")),
		input: {youtube: "https://www.youtube.com/@input"},
		racetime: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => [],
		},
		src: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => ({
				users: [
					{
						userId: "src-unrelated",
						name: "Unrelated",
						twitchLogin: "runner",
						youtube: "https://www.youtube.com/@other",
					},
				],
				hasMore: false,
			}),
		},
	});
	const resolution = analyze(result);
	assert.equal(resolution.candidates.length, 1);
	assert(
		!resolution.accounts.some((account) =>
			account.keys.includes("speedrunCom:src-unrelated"),
		),
	);
});

test("a discovered Twitch account also searches RaceTime once", async () => {
	const queries: string[] = [];
	const result = await collectMatching({
		directory: directory(),
		input: {twitch: {login: "runner"}},
		racetime: {
			getUser: async (id) => ({
				userId: id,
				name: "Runner",
				twitchLogin: "runner",
			}),
			searchUsers: async (query) => {
				queries.push(query);
				return [{userId: "rtA", name: "Runner", twitchLogin: "runner"}];
			},
		},
		src: {
			getUser: async () => {
				throw Error("unused");
			},
			searchUsers: async () => ({users: [], hasMore: false}),
		},
	});
	assert.deepEqual(queries, ["runner"]);
	assert(
		result.accounts.some((account) => account.keys.includes("racetime:rtA")),
	);
	assert(result.evidence.some((entry) => entry.source === "racetime"));
});

test("assignment changes recalculate and invalidate stale resolved conflicts", () => {
	const a = player("a", "rtA", "a"),
		b = player("b", "rtB", "b");
	const collection = empty(
		directory(a, b),
		[
			{id: "racetime:rtA", service: "racetime", keys: ["racetime:rtA"]},
			{id: "twitch:b", service: "twitch", keys: ["twitch:b"]},
		],
		[{id: "", source: "racetime", accounts: ["racetime:rtA", "twitch:b"]}],
		["racetime:rtA"],
	);
	const initial = analyze(collection);
	const approved = approveConflict(initial, initial.conflicts[0]!.id);
	const movedToA = assignAccount(approved, "twitch:b", "a");
	assert.equal(movedToA.conflicts.length, 0);
	const separatedAgain = assignAccount(movedToA, "twitch:b", "new:p");
	assert.equal(separatedAgain.conflicts[0]?.status, "conflict");
	assert.notEqual(separatedAgain.conflicts[0]?.id, approved.conflicts[0]?.id);
	assert.equal(separatedAgain.newPlayerRequired, true);
	assert.throws(() => assignAccount(initial, "missing", "a"));
	assert.throws(() => assignAccount(initial, "twitch:b", "missing-player"));
});

test("merge survivor selection reanalyzes assignments and reports emptied players", () => {
	const a = player("a", "rtA", "a"),
		b = player("b", "rtB", "b");
	const collection = empty(
		directory(a, b),
		[
			{id: "racetime:rtA", service: "racetime", keys: ["racetime:rtA"]},
			{id: "twitch:b", service: "twitch", keys: ["twitch:b"]},
		],
		[{id: "", source: "src", accounts: ["racetime:rtA", "twitch:b"]}],
		["racetime:rtA"],
	);
	const merged = assignMergeSurvivor(analyze(collection), "a");
	assert(merged.assignments.every((assignment) => assignment.ownerId === "a"));
	assert.equal(merged.conflicts.length, 0);
	assert.deepEqual(merged.mergeAssessment?.playersWithoutAccounts, ["b"]);
});

test("merge survivor receives every account in the identity component, including New Player accounts", () => {
	const a: Player = {
		playerId: "a",
		revision: 1,
		manualDisplayName: null,
		racetime: {userId: "rtA", name: "A"},
		speedrunCom: null,
		twitch: null,
		youtube: null,
	};
	const b: Player = {
		playerId: "b",
		revision: 1,
		manualDisplayName: null,
		racetime: null,
		speedrunCom: {userId: "srcB", name: "B"},
		twitch: null,
		youtube: null,
	};
	const collection = empty(
		directory(a, b),
		[
			{id: "racetime:rtA", service: "racetime", keys: ["racetime:rtA"]},
			{
				id: "speedrunCom:srcB",
				service: "speedrunCom",
				keys: ["speedrunCom:srcB"],
			},
			{id: "twitch:runner", service: "twitch", keys: ["twitch:runner"]},
		],
		[
			{id: "", source: "user", accounts: ["racetime:rtA"]},
			{id: "", source: "user", accounts: ["speedrunCom:srcB"]},
			{id: "", source: "racetime", accounts: ["racetime:rtA", "twitch:runner"]},
			{id: "", source: "src", accounts: ["twitch:runner", "speedrunCom:srcB"]},
		],
		["racetime:rtA"],
	);
	collection.requiredAccounts = [{service: "twitch", value: "runner"}];
	const initial = analyze(collection);
	assert.equal(
		initial.assignments.find(
			(assignment) => assignment.accountId === "twitch:runner",
		)?.ownerId,
		"new:p",
	);
	assert.deepEqual(
		new Set(initial.mergeProposal?.accountIds),
		new Set(["racetime:rtA", "speedrunCom:srcB", "twitch:runner"]),
	);
	const merged = assignMergeSurvivor(initial, "a");
	assert.equal(
		merged.assignments.find(
			(assignment) => assignment.accountId === "racetime:rtA",
		)?.ownerId,
		"a",
	);
	assert.equal(
		merged.assignments.find(
			(assignment) => assignment.accountId === "speedrunCom:srcB",
		)?.ownerId,
		"a",
	);
	assert.equal(
		merged.assignments.find(
			(assignment) => assignment.accountId === "twitch:runner",
		)?.ownerId,
		"a",
	);
	assert(
		!merged.assignments.some((assignment) => assignment.ownerId === "new:p"),
	);
	assert.equal(merged.newPlayerRequired, false);
	assert.deepEqual(merged.mergeAssessment?.playersWithoutAccounts, ["b"]);
	assert.equal(merged.requiredStatus[0]?.satisfied, true);
	assert.equal(merged.requiredStatus[0]?.ownerId, "a");
	assert.equal(merged.mergeAssessment?.conflictsRemaining, 0);
});
test("a relevant search candidate blocks commit until the user explicitly assigns its account", async () => {
	const collection = await collectMatching({
		directory: directory(),
		input: {twitch: {login: "runner"}},
		racetime: {
			getUser: async () => {
				throw new Error("unused");
			},
			searchUsers: async () => [],
		},
		src: {
			getUser: async () => {
				throw new Error("unused");
			},
			searchUsers: async () => ({
				users: [
					{userId: "one", name: "Runner", twitchLogin: "runner"},
					{userId: "two", name: "Runner", twitchLogin: "runner"},
				],
				hasMore: false,
			}),
		},
	});
	const resolution = analyze(collection);
	assert.equal(resolution.candidates.length, 2);
	assert.throws(() => buildCommitPlan(resolution), {code: "invalid_input"});
	const account = resolution.accounts.find(
		(entry) => entry.service === "twitch",
	)!;
	const owner = resolution.assignments.find(
		(entry) => entry.accountId === account.id,
	)!.ownerId;
	assert.doesNotThrow(() =>
		buildCommitPlan(assignAccount(resolution, account.id, owner)),
	);
});

test("Required seeds are separate from Input evidence and seed closure", async () => {
	const collection = await collectMatching({
		directory: directory(),
		input: {},
		requiredAccounts: [{service: "racetime", value: "rtA"}],
		racetime: {
			getUser: async () => ({userId: "rtA", name: "A", twitchLogin: null}),
			searchUsers: async () => [],
		},
		src: {
			getUser: async () => {
				throw new Error("unused");
			},
			searchUsers: async () => ({users: [], hasMore: false}),
		},
	});
	assert.equal(collection.inputAccountIds.length, 0);
	assert.equal(collection.seedAccountIds.length, 1);
	assert(!collection.evidence.some((entry) => entry.source === "input"));
	assert.equal(analyze(collection).accounts.length, 1);
});

test("a New Player with only a display name is commit eligible", () => {
	const collection = {
		...empty(directory(), [], []),
		input: {manualDisplayName: "Runner"},
	};
	const resolution = analyze(collection);
	assert.equal(resolution.newPlayerRequired, true);
	const plan = buildCommitPlan(resolution);
	assert.equal(plan.creates.length, 1);
	assert.equal(plan.creates[0]?.input.manualDisplayName, "Runner");
	assert.equal(plan.creates[0]?.input.racetime, null);
});

test("moving all accounts makes an explicit deletion candidate while preserving both Player names", () => {
	const alice: Player = {
		playerId: "alice",
		revision: 1,
		manualDisplayName: "Alice",
		racetime: {userId: "rt-a", name: "A"},
		speedrunCom: null,
		twitch: null,
		youtube: null,
	};
	const bob: Player = {
		playerId: "bob",
		revision: 1,
		manualDisplayName: "Bob",
		racetime: null,
		speedrunCom: null,
		twitch: null,
		youtube: null,
	};
	const accounts: Collection["accounts"] = [
		{
			id: "racetime:rt-a",
			service: "racetime",
			keys: ["racetime:rt-a"],
			profile: {userId: "rt-a", name: "A"},
		},
		{
			id: "twitch:tw-a",
			service: "twitch",
			keys: ["twitch:tw-a"],
			profile: {userId: "tw-a", name: "Tw A", twitchLogin: "tw-a"},
		},
	];
	const collection = empty(
		directory(alice, {...bob, twitch: {userId: "tw-a", login: "tw-a"}}),
		accounts,
		[
			{
				id: "link",
				source: "racetime",
				accounts: ["racetime:rt-a", "twitch:tw-a"],
			},
		],
		["racetime:rt-a"],
	);
	const initial = analyze(collection);
	const moved = assignAccount(initial, "twitch:tw-a", "alice");
	assert.deepEqual(moved.deletionCandidates, ["bob"]);
	assert.deepEqual(moved.deletePlayerIds, []);
	const plan = buildCommitPlan(moved);
	assert.equal(plan.deletes.length, 0);
	assert.equal(
		plan.updates.find((item) => item.playerId === "bob")?.input
			.manualDisplayName,
		"Bob",
	);
	assert.equal(
		plan.updates.find((item) => item.playerId === "bob")?.input.twitch,
		null,
	);
	const deletedPlan = buildCommitPlan({...moved, deletePlayerIds: ["bob"]});
	assert.deepEqual(
		deletedPlan.deletes.map((item) => item.playerId),
		["bob"],
	);
	assert.equal(
		deletedPlan.updates.some((item) => item.playerId === "bob"),
		false,
	);
});

test("Accountless Existing Players are not deletion candidates and display names do not conflict", () => {
	const blank: Player = {
		playerId: "blank",
		revision: 1,
		manualDisplayName: "Runner",
		racetime: null,
		speedrunCom: null,
		twitch: null,
		youtube: null,
	};
	const account = {
		id: "twitch:runner",
		service: "twitch" as const,
		keys: ["twitch:runner"],
	};
	const collection = {
		...empty(
			directory(blank),
			[account],
			[{id: "input", source: "input" as const, accounts: [account.id]}],
			[account.id],
		),
		input: {manualDisplayName: "Different name"},
	};
	const resolution = analyze(collection);
	assert.equal(resolution.conflicts.length, 0);
	assert.deepEqual(resolution.deletionCandidates, []);
});

test("Merge keeps survivor display name, deletes absorbed player, and suppresses empty-player deletion proposal", () => {
	const alice: Player = {
		playerId: "alice",
		revision: 1,
		manualDisplayName: "Alice",
		racetime: {userId: "rt-a", name: "A"},
		speedrunCom: null,
		twitch: null,
		youtube: null,
	};
	const bob: Player = {
		playerId: "bob",
		revision: 1,
		manualDisplayName: "Bob",
		racetime: null,
		speedrunCom: {userId: "src-b", name: "B"},
		twitch: null,
		youtube: null,
	};
	const accounts: Collection["accounts"] = [
		{
			id: "racetime:rt-a",
			service: "racetime",
			keys: ["racetime:rt-a"],
			profile: {userId: "rt-a", name: "A"},
		},
		{
			id: "speedrunCom:src-b",
			service: "speedrunCom",
			keys: ["speedrunCom:src-b"],
			profile: {userId: "src-b", name: "B"},
		},
	];
	const collection = empty(
		directory(alice, bob),
		accounts,
		[
			{
				id: "link",
				source: "src",
				accounts: ["racetime:rt-a", "speedrunCom:src-b"],
			},
		],
		["racetime:rt-a"],
	);
	const initial = analyze(collection);
	const merged = assignMergeSurvivor(initial, "alice");
	assert.deepEqual(merged.deletionCandidates, []);
	assert.deepEqual(merged.deletePlayerIds, ["bob"]);
	const plan = buildCommitPlan(merged);
	assert.deepEqual(
		plan.deletes.map((item) => item.playerId),
		["bob"],
	);
	assert.equal(
		plan.updates.find((item) => item.playerId === "alice")?.input
			.manualDisplayName,
		"Alice",
	);
	assert.equal(
		plan.updates.some((item) => item.input.manualDisplayName === "Bob"),
		false,
	);
});

test("Merge proposal is omitted when a component contains multiple canonical Accounts for one service", () => {
	const first: Player = {
		playerId: "first",
		revision: 1,
		manualDisplayName: null,
		racetime: {userId: "one", name: "One"},
		speedrunCom: null,
		twitch: null,
		youtube: null,
	};
	const second: Player = {
		playerId: "second",
		revision: 1,
		manualDisplayName: null,
		racetime: {userId: "two", name: "Two"},
		speedrunCom: null,
		twitch: null,
		youtube: null,
	};
	const accounts: Collection["accounts"] = [
		{id: "racetime:one", service: "racetime", keys: ["racetime:one"]},
		{id: "racetime:two", service: "racetime", keys: ["racetime:two"]},
	];
	const collection = empty(
		directory(first, second),
		accounts,
		[
			{
				id: "link",
				source: "src",
				accounts: accounts.map((account) => account.id),
			},
		],
		accounts.map((account) => account.id),
	);
	assert.equal(analyze(collection).mergeProposal, null);
});

test("candidate origin IDs distinguish Accounts with the same key value across services", () => {
	const twitch = {
		id: "twitch:same",
		service: "twitch" as const,
		keys: ["twitch:same"],
	};
	const youtube = {
		id: "youtube:same",
		service: "youtube" as const,
		keys: ["youtube:same"],
	};
	const collection = {
		...empty(
			directory(),
			[twitch, youtube],
			[
				{id: "twitch-input", source: "input" as const, accounts: [twitch.id]},
				{id: "youtube-input", source: "input" as const, accounts: [youtube.id]},
			],
			[twitch.id, youtube.id],
		),
		candidates: [
			{
				id: "candidate",
				service: "speedrunCom" as const,
				profile: {userId: "src", name: "Runner"},
				query: "same",
				originAccountId: youtube.id,
			},
		],
	};
	const initial = analyze(collection);
	const owner = initial.assignments[0]!.ownerId;
	const twitchAssigned = assignAccount(initial, twitch.id, owner);
	assert.throws(() => buildCommitPlan(twitchAssigned), {code: "invalid_input"});
	const bothAssigned = assignAccount(twitchAssigned, youtube.id, owner);
	assert.doesNotThrow(() => buildCommitPlan(bothAssigned));
});
