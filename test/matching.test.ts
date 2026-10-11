import assert from "node:assert/strict";
import test from "node:test";
import type {Directory, Player} from "@nanahuse/player-manager-protocol";
import {collectMatching} from "../src/extension/matching/collect.ts";
import {
	analyze,
	approveConflict,
	assignAccount,
	assignMergeSurvivor,
	setAccountUsage,
	setMergeDecision,
	setPlayerDeletion,
} from "../src/matching/analyze.ts";
import {buildCommitPlan} from "../src/matching/commit.ts";
import {
	components,
	dedupeAccounts,
	dedupeEvidence,
} from "../src/matching/graph.ts";
import type {Collection} from "../src/matching/model.ts";

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

function mergeCollection(): Collection {
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
	return empty(
		directory(alice, bob),
		[
			{
				id: "racetime:rt-a",
				service: "racetime",
				keys: ["racetime:rt-a"],
				profile: {userId: "rt-a", name: "A"},
			},
			{id: "twitch:bridge", service: "twitch", keys: ["twitch:bridge"]},
			{
				id: "speedrunCom:src-b",
				service: "speedrunCom",
				keys: ["speedrunCom:src-b"],
				profile: {userId: "src-b", name: "B"},
			},
			{
				id: "youtube:unrelated",
				service: "youtube",
				keys: ["youtube:unrelated"],
			},
		],
		[
			{
				id: "left",
				source: "racetime",
				accounts: ["racetime:rt-a", "twitch:bridge"],
			},
			{
				id: "right",
				source: "src",
				accounts: ["twitch:bridge", "speedrunCom:src-b"],
			},
			{id: "unrelated", source: "input", accounts: ["youtube:unrelated"]},
		],
		["racetime:rt-a", "youtube:unrelated"],
	);
}

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

test("manual assignment before merge is preserved as a choice and merge applies it", () => {
	const initial = analyze(mergeCollection());
	const assigned = assignAccount(initial, "speedrunCom:src-b", "alice");
	assert.ok(assigned.mergeProposal);
	const merged = assignMergeSurvivor(assigned, "alice");
	assert.equal(merged.mergeDecision, "merge");
	assert.equal(
		merged.assignments.find((item) => item.accountId === "twitch:bridge")
			?.ownerId,
		"alice",
	);
	assert.deepEqual(
		merged.choices.assignments.find(
			(item) => item.accountId === "speedrunCom:src-b",
		),
		{accountId: "speedrunCom:src-b", ownerId: "alice", source: "user"},
	);
	const plan = buildCommitPlan(merged);
	assert.deepEqual(
		plan.deletes.map((item) => item.playerId),
		["bob"],
	);
	assert.equal(
		plan.updates.find((item) => item.playerId === "alice")?.input.twitch?.login,
		"bridge",
	);
});

test("manual reassignment after merge cancels merge and commits the chosen owner after conflict review", () => {
	const initial = analyze(mergeCollection());
	const merged = assignMergeSurvivor(initial, "alice");
	const separated = assignAccount(merged, "twitch:bridge", "new:p");
	assert.equal(separated.mergeDecision, "keepSeparate");
	assert.equal(separated.mergeAssessment, null);
	assert.equal(
		separated.assignments.find((item) => item.accountId === "twitch:bridge")
			?.ownerId,
		"new:p",
	);
	assert.ok(separated.players.some((player) => player.id === "bob"));
	assert.throws(() => buildCommitPlan(separated), {code: "identity_conflict"});
	const approved = separated.conflicts.reduce(
		(resolution, conflict) => approveConflict(resolution, conflict.id),
		separated,
	);
	const plan = buildCommitPlan(approved);
	assert.equal(
		plan.deletes.some((item) => item.playerId === "bob"),
		false,
	);
	assert.equal(plan.creates[0]?.input.twitch?.login, "bridge");
});

test("post-merge assignments to the survivor and unrelated accounts keep the merge", () => {
	const initial = analyze(mergeCollection());
	const merged = assignMergeSurvivor(initial, "alice");
	const assignedToSurvivor = assignAccount(merged, "twitch:bridge", "alice");
	assert.equal(assignedToSurvivor.mergeDecision, "merge");
	const unrelatedChange = assignAccount(
		assignedToSurvivor,
		"youtube:unrelated",
		"alice",
	);
	assert.equal(unrelatedChange.mergeDecision, "merge");
	const plan = buildCommitPlan(unrelatedChange);
	assert.deepEqual(
		plan.deletes.map((item) => item.playerId),
		["bob"],
	);
	assert.equal(plan.updates[0]?.input.youtube, "unrelated");
});

test("assigning to an absorbed Player cancels merge and keeps the Player", () => {
	const initial = analyze(mergeCollection());
	const merged = assignMergeSurvivor(initial, "alice");
	const separated = assignAccount(merged, "twitch:bridge", "bob");
	assert.equal(separated.mergeDecision, "keepSeparate");
	assert.equal(separated.mergeAssessment, null);
	assert.ok(separated.players.some((player) => player.id === "bob"));
	assert.equal(
		separated.assignments.find((item) => item.accountId === "twitch:bridge")
			?.ownerId,
		"bob",
	);
	const approved = separated.conflicts.reduce(
		(resolution, conflict) => approveConflict(resolution, conflict.id),
		separated,
	);
	assert.equal(
		buildCommitPlan(approved).deletes.some((item) => item.playerId === "bob"),
		false,
	);
});

test("Merge can be declined, reviewed for conflicts, and later applied", () => {
	const initial = analyze(mergeCollection());
	const separate = setMergeDecision(initial, "keepSeparate");
	assert.equal(separate.mergeDecision, "keepSeparate");
	assert.ok(separate.mergeProposal);
	assert.throws(() => buildCommitPlan(separate), {code: "identity_conflict"});
	const approved = separate.conflicts.reduce(
		(resolution, conflict) => approveConflict(resolution, conflict.id),
		separate,
	);
	const separatePlan = buildCommitPlan(approved);
	assert.equal(separatePlan.deletes.length, 0);
	assert.equal(separatePlan.creates.length, 1);
	const merged = assignMergeSurvivor(approved, "alice");
	assert.equal(merged.mergeDecision, "merge");
	assert.deepEqual(
		buildCommitPlan(merged).deletes.map((item) => item.playerId),
		["bob"],
	);
});

test("invalidating a merge preserves unrelated assignments and explicit deletion choices", () => {
	const collection = mergeCollection();
	collection.directory.players.push({
		playerId: "charlie",
		revision: 1,
		manualDisplayName: "Charlie",
		racetime: null,
		speedrunCom: null,
		twitch: null,
		youtube: "unrelated",
	});
	const initial = analyze(collection);
	const assignedCharlieAccount = assignAccount(
		initial,
		"youtube:unrelated",
		"alice",
	);
	const deleteCharlie = setPlayerDeletion(
		assignedCharlieAccount,
		"charlie",
		true,
	);
	const merged = assignMergeSurvivor(deleteCharlie, "alice");
	const split = setAccountUsage(merged, "twitch:bridge", false);
	assert.equal(split.mergeDecision, "undecided");
	assert.deepEqual(
		split.choices.assignments,
		deleteCharlie.choices.assignments,
	);
	assert.equal(
		split.assignments.find((item) => item.accountId === "youtube:unrelated")
			?.ownerId,
		"alice",
	);
	assert.deepEqual(split.deletePlayerIds, ["charlie"]);
	assert.equal(
		split.assignments.find((item) => item.accountId === "speedrunCom:src-b")
			?.ownerId,
		"bob",
	);
	assert.deepEqual(
		buildCommitPlan(split).deletes.map((item) => item.playerId),
		["charlie"],
	);
});

test("excluding an evidence bridge removes its merge proposal and prior merge choice", () => {
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
	const initial = analyze(
		empty(
			directory(a, b),
			[
				{id: "racetime:rtA", service: "racetime", keys: ["racetime:rtA"]},
				{id: "twitch:bridge", service: "twitch", keys: ["twitch:bridge"]},
				{
					id: "speedrunCom:srcB",
					service: "speedrunCom",
					keys: ["speedrunCom:srcB"],
				},
			],
			[
				{
					id: "",
					source: "racetime",
					accounts: ["racetime:rtA", "twitch:bridge"],
				},
				{
					id: "",
					source: "src",
					accounts: ["twitch:bridge", "speedrunCom:srcB"],
				},
			],
			["racetime:rtA"],
		),
	);
	assert.ok(initial.mergeProposal);
	const merged = assignMergeSurvivor(initial, "a");
	assert.deepEqual(merged.deletePlayerIds, ["b"]);
	const withoutBridge = setAccountUsage(merged, "twitch:bridge", false);
	assert.equal(withoutBridge.mergeProposal, null);
	assert.equal(withoutBridge.mergeAssessment, null);
	assert.deepEqual(withoutBridge.deletePlayerIds, []);
	assert.equal(withoutBridge.conflicts.length, 0);
	assert.equal(
		withoutBridge.assignments.find(
			(assignment) => assignment.accountId === "speedrunCom:srcB",
		)?.ownerId,
		"b",
	);
	const bridgeRestored = setAccountUsage(withoutBridge, "twitch:bridge", true);
	assert.ok(bridgeRestored.mergeProposal);
	assert.equal(bridgeRestored.mergeAssessment, null);
	const declined = setMergeDecision(initial, "keepSeparate");
	const changedTarget = setAccountUsage(declined, "twitch:bridge", false);
	assert.equal(changedTarget.mergeDecision, "undecided");
	assert.equal(changedTarget.mergeProposal, null);
	const targetRestored = setAccountUsage(changedTarget, "twitch:bridge", true);
	assert.equal(targetRestored.mergeDecision, "undecided");
	assert.ok(targetRestored.mergeProposal);
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

test("an unused duplicate account is omitted from commit and restores its assignment", () => {
	const collection = empty(
		directory(),
		[
			{
				id: "racetime:a",
				service: "racetime",
				keys: ["racetime:a"],
				profile: {userId: "a", name: "A"},
			},
			{id: "racetime:b", service: "racetime", keys: ["racetime:b"]},
		],
		[{id: "link", source: "input", accounts: ["racetime:a", "racetime:b"]}],
		["racetime:a"],
	);
	const initial = analyze(collection);
	const originalOwner = initial.assignments.find(
		(entry) => entry.accountId === "racetime:b",
	)!.ownerId;
	const unused = setAccountUsage(initial, "racetime:b", false);
	assert.deepEqual(unused.discardedAccountIds, ["racetime:b"]);
	assert.equal(unused.conflicts.length, 0);
	assert.deepEqual(
		buildCommitPlan(unused).creates[0]?.input.racetime?.userId,
		"a",
	);
	const restored = setAccountUsage(unused, "racetime:b", true);
	assert.equal(
		restored.assignments.find((entry) => entry.accountId === "racetime:b")
			?.ownerId,
		originalOwner,
	);
	assert.throws(() => buildCommitPlan(restored), {code: "identity_conflict"});
	const reassigned = assignAccount(unused, "racetime:b", originalOwner);
	assert.deepEqual(reassigned.discardedAccountIds, []);
	assert.equal(
		reassigned.assignments.find((entry) => entry.accountId === "racetime:b")
			?.source,
		"user",
	);
});

test("excluding an evidence bridge recalculates inference but preserves explicit assignments", () => {
	const alice: Player = {
		playerId: "alice",
		revision: 1,
		manualDisplayName: null,
		racetime: {userId: "a", name: "A"},
		speedrunCom: null,
		twitch: null,
		youtube: null,
	};
	const collection = empty(
		directory(alice),
		[
			{id: "racetime:a", service: "racetime", keys: ["racetime:a"]},
			{id: "twitch:bridge", service: "twitch", keys: ["twitch:bridge"]},
			{id: "speedrunCom:c", service: "speedrunCom", keys: ["speedrunCom:c"]},
			{
				id: "youtube:independent",
				service: "youtube",
				keys: ["youtube:independent"],
			},
		],
		[
			{
				id: "left",
				source: "racetime",
				accounts: ["racetime:a", "twitch:bridge"],
			},
			{
				id: "right",
				source: "src",
				accounts: ["twitch:bridge", "speedrunCom:c"],
			},
			{
				id: "independent-link",
				source: "input",
				accounts: ["racetime:a", "youtube:independent"],
			},
		],
		["racetime:a"],
	);
	const initial = analyze(collection);
	assert.equal(
		initial.assignments.find((item) => item.accountId === "speedrunCom:c")
			?.ownerId,
		"alice",
	);
	const explicit = assignAccount(initial, "youtube:independent", "new:p");
	const withoutBridge = setAccountUsage(explicit, "twitch:bridge", false);
	assert.equal(
		withoutBridge.assignments.find((item) => item.accountId === "speedrunCom:c")
			?.ownerId,
		"new:p",
	);
	assert.equal(
		withoutBridge.assignments.find(
			(item) => item.accountId === "youtube:independent",
		)?.ownerId,
		"new:p",
	);
	const restored = setAccountUsage(withoutBridge, "twitch:bridge", true);
	assert.equal(
		restored.assignments.find((item) => item.accountId === "speedrunCom:c")
			?.ownerId,
		"alice",
	);
	assert.equal(
		restored.assignments.find(
			(item) => item.accountId === "youtube:independent",
		)?.ownerId,
		"new:p",
	);
});

test("unused candidate origins and evidence conflicts do not block commit", () => {
	const collection: Collection = {
		...empty(
			directory(player("a", "a", "a"), player("b", "b", "b")),
			[
				{
					id: "racetime:a",
					service: "racetime",
					keys: ["racetime:a"],
					profile: {userId: "a", name: "A"},
				},
				{
					id: "twitch:b",
					service: "twitch",
					keys: ["twitch:b"],
					profile: {twitchLogin: "b"},
				},
			],
			[{id: "link", source: "racetime", accounts: ["racetime:a", "twitch:b"]}],
			["racetime:a"],
		),
		candidates: [
			{
				id: "candidate",
				service: "speedrunCom",
				profile: {userId: "candidate", name: "Candidate"},
				query: "runner",
				originAccountId: "twitch:b",
			},
		],
	};
	const initial = analyze(collection);
	assert.equal(initial.conflicts.length, 1);
	const approved = approveConflict(initial, initial.conflicts[0]!.id);
	const unused = setAccountUsage(approved, "twitch:b", false);
	assert.equal(unused.conflicts.length, 0);
	assert.doesNotThrow(() => buildCommitPlan(unused));
	const restored = setAccountUsage(unused, "twitch:b", true);
	assert.equal(restored.conflicts[0]?.status, "conflict");
	assert.throws(() => buildCommitPlan(restored), {code: "identity_conflict"});
});

test("Required accounts cannot be marked unused", () => {
	const collection = {
		...empty(
			directory(),
			[{id: "racetime:a", service: "racetime" as const, keys: ["racetime:a"]}],
			[],
			["racetime:a"],
		),
		requiredAccounts: [{service: "racetime" as const, value: "a"}],
	};
	const resolution = analyze(collection);
	assert.throws(() => setAccountUsage(resolution, "racetime:a", false), {
		code: "invalid_input",
	});
});

test("empty creation mode still creates a New Player when every account is unused", () => {
	const collection = {
		...empty(
			directory(),
			[
				{
					id: "racetime:a",
					service: "racetime" as const,
					keys: ["racetime:a"],
					profile: {userId: "a", name: "A"},
				},
			],
			[],
			["racetime:a"],
		),
		createPlayerOnEmpty: true,
	};
	const resolution = setAccountUsage(analyze(collection), "racetime:a", false);
	assert.equal(resolution.newPlayerRequired, true);
	assert.equal(buildCommitPlan(resolution).creates.length, 1);
});

test("excluding an Existing Player account updates it without selecting deletion", () => {
	const alice = player("alice", "a", "alice");
	const collection = empty(
		directory(alice),
		[
			{
				id: "racetime:a",
				service: "racetime",
				keys: ["racetime:a"],
				profile: {userId: "a", name: "alice"},
			},
		],
		[{id: "owned", source: "user", accounts: ["racetime:a"]}],
		["racetime:a"],
	);
	const resolution = setAccountUsage(analyze(collection), "racetime:a", false);
	assert.deepEqual(resolution.deletePlayerIds, []);
	assert.deepEqual(resolution.deletionCandidates, ["alice"]);
	const plan = buildCommitPlan(resolution);
	assert.equal(plan.deletes.length, 0);
	assert.equal(
		plan.updates.find((item) => item.playerId === "alice")?.input.racetime,
		null,
	);
});

test("an Existing Player with only unused accounts is deleted only after explicit selection", () => {
	const alice = player("alice", "a", "alice");
	const collection = empty(
		directory(alice),
		[
			{
				id: "racetime:a",
				service: "racetime",
				keys: ["racetime:a"],
				profile: {userId: "a", name: "Alice"},
			},
		],
		[{id: "owned", source: "user", accounts: ["racetime:a"]}],
		["racetime:a"],
	);
	const unused = setAccountUsage(analyze(collection), "racetime:a", false);
	assert.deepEqual(unused.deletionCandidates, ["alice"]);
	assert.equal(buildCommitPlan(unused).deletes.length, 0);
	assert.equal(
		buildCommitPlan(unused).updates.find((item) => item.playerId === "alice")
			?.input.racetime,
		null,
	);
	const selected = setPlayerDeletion(unused, "alice", true);
	assert.deepEqual(
		buildCommitPlan(selected).deletes.map((item) => item.playerId),
		["alice"],
	);
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
	const separated = setMergeDecision(moved, "keepSeparate");
	const plan = buildCommitPlan(separated);
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
	const deletedPlan = buildCommitPlan(
		setPlayerDeletion(separated, "bob", true),
	);
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
