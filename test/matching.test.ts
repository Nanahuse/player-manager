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
			searchUsers: async () => ({
				users: [{userId: "srcA", name: "Runner", twitchLogin: "runner"}],
				hasMore: true,
			}),
		},
	});
	assert.equal(result.candidates.length, 1);
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
