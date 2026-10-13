import assert from "node:assert/strict";
import test from "node:test";
import type {Player, Resolution} from "@nanahuse/player-manager-protocol";
import {
	accountLabel,
	buildResolutionView,
} from "../src/browser/dashboard/views/resolution-view.ts";

const existing = (playerId: string, name: string | null): Player => ({
	playerId,
	revision: 1,
	manualDisplayName: name,
	racetime: null,
	speedrunCom: null,
	twitch: null,
	youtube: null,
});

function resolution(): Resolution {
	const accounts: Resolution["accounts"] = [
		{
			id: "rt:a",
			service: "racetime",
			keys: ["racetime:rt-a"],
			profile: {userId: "rt-a", name: "Race A"},
		},
		{id: "rt:b", service: "racetime", keys: ["racetime:rt-b"]},
		{
			id: "src:a",
			service: "speedrunCom",
			keys: ["speedrunCom:src-a"],
			profile: {
				userId: "src-a",
				name: "SRC A",
				weblink: "https://www.speedrun.com/users/src-a",
			},
		},
		{id: "tw:a", service: "twitch", keys: ["twitch:runner"]},
		{
			id: "yt:a",
			service: "youtube",
			keys: ["youtube:https://www.youtube.com/@channel-a"],
		},
		{
			id: "url:a",
			service: "example.com",
			keys: ["url:example.com:https://example.com/runner:profile"],
		},
	];
	return {
		input: {},
		discardedAccountIds: [],
		confirmedCandidateAccountIds: [],
		players: [
			{
				id: "alice",
				kind: "existing",
				player: existing("alice", "Alice"),
				assignedAccountIds: ["rt:a", "rt:b", "src:a", "tw:a", "yt:a"],
			},
			{
				id: "bob",
				kind: "existing",
				player: existing("bob", "Bob"),
				assignedAccountIds: [],
			},
			{
				id: "charlie",
				kind: "existing",
				player: existing("charlie", "Charlie"),
				assignedAccountIds: [],
			},
			{id: "new:n", kind: "new", assignedAccountIds: []},
		],
		accounts,
		evidence: [
			{id: "ev-user", source: "user", accounts: ["rt:a"]},
			{id: "ev-input", source: "input", accounts: ["rt:a"]},
			{id: "ev-rt", source: "racetime", accounts: ["rt:a", "tw:a"]},
			{id: "ev-src", source: "src", accounts: ["rt:a"]},
			{id: "ev-resolved", source: "src", accounts: ["src:a"]},
		],
		assignments: accounts.map((account) => ({
			accountId: account.id,
			ownerId: "alice",
			source: "inferred",
		})),
		conflicts: [
			{
				id: "c-open",
				evidenceId: "ev-rt",
				ownerIds: ["alice", "bob"],
				status: "conflict",
			},
			{
				id: "c-done",
				evidenceId: "ev-user",
				ownerIds: ["alice", "bob"],
				status: "resolved",
			},
			{
				id: "c-resolved",
				evidenceId: "ev-resolved",
				ownerIds: ["alice", "bob"],
				status: "resolved",
			},
		],
		candidates: [
			{
				id: "candidate-a",
				service: "speedrunCom",
				profile: {userId: "candidate-a", name: "A"},
				query: "runner",
				originAccountId: "tw:a",
			},
			{
				id: "candidate-b",
				service: "speedrunCom",
				profile: {userId: "candidate-b", name: "B"},
				query: "runner",
				originAccountId: "tw:a",
			},
		],
		warnings: [],
		errors: [],
		mergeProposal: null,
		mergeDecision: "undecided",
		mergeAssessment: {
			survivorId: "alice",
			absorbedPlayerIds: ["bob"],
			playersWithoutAccounts: ["bob"],
			conflictsRemaining: 0,
		},
		requiredAccounts: [
			{service: "racetime", value: "rt-a"},
			{service: "youtube", value: "youtube.com/@Missing"},
		],
		requiredStatus: [
			{accountId: "rt:a", satisfied: true, ownerId: "alice"},
			{accountId: "required:missing", satisfied: false},
		],
		newPlayerRequired: false,
		deletePlayerIds: [],
		deletionCandidates: ["bob", "charlie"],
	};
}

test("resolution view places all accounts, preserves duplicate cells, and orders unique evidence labels", () => {
	const view = buildResolutionView(resolution());
	const alice = view.players.find((player) => player.id === "alice")!;
	assert.deepEqual(
		alice.cells.racetime.map((account) => account.accountId),
		["rt:a", "rt:b"],
	);
	assert.deepEqual(alice.cells.racetime[0]?.evidenceLabels, [
		"User",
		"Input",
		"RaceTime",
		"SRC",
	]);
	assert.deepEqual(view.issues.duplicateCells, []);
	assert.equal(alice.cells.racetime[0]?.profileName, "Race A");
});

test("resolution view resolves service profile links without guessing missing Speedrun links", () => {
	const view = buildResolutionView(resolution());
	const accounts = new Map(
		view.accounts.map((account) => [account.accountId, account]),
	);
	assert.equal(
		accounts.get("rt:a")?.profileUrl,
		"https://racetime.gg/user/rt-a",
	);
	assert.equal(
		accounts.get("tw:a")?.profileUrl,
		"https://www.twitch.tv/runner",
	);
	assert.equal(
		accounts.get("yt:a")?.profileUrl,
		"https://www.youtube.com/@channel-a",
	);
	assert.equal(accounts.get("yt:a")?.accountId, "yt:a");
	assert.equal(accounts.get("yt:a")?.label, "@channel-a");
	assert.equal(
		accounts.get("src:a")?.profileUrl,
		"https://www.speedrun.com/users/src-a",
	);
	assert.equal(
		accounts.get("rt:b")?.profileUrl,
		"https://racetime.gg/user/rt-b",
	);
	assert.equal(accounts.get("src:a")?.speedrunUserId, "src-a");
	assert.equal(
		accounts.get("url:a")?.profileUrl,
		"https://example.com/runner:profile",
	);
});

test("YouTube account labels extract identifiers from supported URL forms", () => {
	for (const [value, label] of [
		["@Runner", "@Runner"],
		["youtube.com/@Runner", "@Runner"],
		["www.youtube.com/@Runner", "@Runner"],
		["https://youtube.com/@Runner", "@Runner"],
		["youtube.com/user/Runner", "Runner"],
		["youtube.com/c/Runner", "Runner"],
		["youtube.com/channel/UC" + "A".repeat(22), "UC" + "A".repeat(22)],
	] as const)
		assert.equal(accountLabel("youtube", value), label);
	assert.equal(accountLabel("racetime", "racetime:rt-a"), "rt-a");
});

test("YouTube account labels preserve invalid identities without throwing", () => {
	for (const value of [
		"@bad/name",
		"youtube.com/channel/UCshort",
		"youtube.com/watch?v=video-id",
		"https://example.com/user/Runner",
		"https://youtube.com/%E0%A4%A",
		"",
	])
		assert.doesNotThrow(() =>
			assert.equal(accountLabel("youtube", value), value),
		);
});

test("unused accounts move out of Player cells while retaining identity and Evidence", () => {
	const value = resolution();
	value.discardedAccountIds = ["rt:b"];
	value.evidence.push({id: "ev-unused", source: "input", accounts: ["rt:b"]});
	const view = buildResolutionView(value);
	const alice = view.players.find((player) => player.id === "alice")!;
	assert.deepEqual(
		alice.cells.racetime.map((account) => account.accountId),
		["rt:a"],
	);
	assert.equal(view.discardedAccounts[0]?.accountId, "rt:b");
	assert.equal(view.discardedAccounts[0]?.label, "rt-b");
	assert.deepEqual(view.discardedAccounts[0]?.evidenceLabels, ["Input"]);
});

test("unused accounts retain service placement without duplicate warnings or Players", () => {
	const value = resolution();
	value.players = [];
	value.discardedAccountIds = ["rt:a", "rt:b"];
	const view = buildResolutionView(value);
	assert.equal(view.players.length, 0);
	assert.deepEqual(
		view.discardedAccounts.map(({accountId, service}) => ({
			accountId,
			service,
		})),
		[
			{accountId: "rt:a", service: "racetime"},
			{accountId: "rt:b", service: "racetime"},
		],
	);
	assert.deepEqual(view.issues.duplicateCells, []);
});

test("open Conflict takes precedence over Resolved and Required is shown independently", () => {
	const view = buildResolutionView(resolution());
	const alice = view.players.find((player) => player.id === "alice")!;
	assert.deepEqual(alice.cells.racetime[0]?.states, ["Required", "Conflict"]);
	assert.deepEqual(alice.cells.speedrunCom[0]?.states, ["Resolved"]);
});

test("view distinguishes account loss, merge absorption, required status, candidates, and New Player state", () => {
	const view = buildResolutionView(resolution());
	const bob = view.players.find((player) => player.id === "bob")!;
	const alice = view.players.find((player) => player.id === "alice")!;
	const newPlayer = view.players.find((player) => player.kind === "new")!;
	assert.equal(bob.deletionCandidate, false);
	assert.equal(bob.mergeAbsorbed, true);
	assert.equal(alice.mergeSurvivor, true);
	assert.equal(
		view.players.find((player) => player.id === "charlie")?.deletionCandidate,
		true,
	);
	assert.equal(newPlayer.label, "New Player");
	assert.equal(view.newPlayerRequired, false);
	assert.equal(view.issues.unsatisfiedRequired, 1);
	assert.equal(view.issues.candidateGroups, 1);
	assert.deepEqual(view.missingRequired, [
		{
			service: "youtube",
			value: "youtube.com/@Missing",
			label: "@Missing",
		},
	]);
});

test("missing Required view does not alter Evidence or Matrix placement", () => {
	const value = resolution();
	const before = buildResolutionView(value);
	assert.deepEqual(before.missingRequired, [
		{
			service: "youtube",
			value: "youtube.com/@Missing",
			label: "@Missing",
		},
	]);
	const after = buildResolutionView(value);
	assert.deepEqual(after.players, before.players);
	assert.deepEqual(after.issues, before.issues);
});

test("an accountless Player with no deletion proposal remains an ordinary Player", () => {
	const value = resolution();
	value.mergeAssessment = null;
	value.deletionCandidates = [];
	const player = buildResolutionView(value).players.find(
		(entry) => entry.id === "bob",
	)!;
	assert.equal(player.deletionCandidate, false);
	assert.equal(player.mergeAbsorbed, false);
});
