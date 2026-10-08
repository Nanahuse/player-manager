import assert from "node:assert/strict";
import test from "node:test";
import type {Assignment, Candidate} from "@nanahuse/player-manager-protocol";
import {
	confirmCurrentAssignment,
	groupCandidatesByOrigin,
} from "../src/browser/dashboard/views/candidate-resolution.ts";

const candidate = (id: string, userId: string): Candidate => ({
	id,
	service: "speedrunCom",
	profile: {userId, name: userId},
	query: "runner",
	originAccountId: "twitch:runner",
});

test("candidate group confirms the unchanged owner once for a shared origin", () => {
	const assignment: Assignment = {
		accountId: "twitch:runner",
		ownerId: "new:p",
		source: "new",
	};
	const groups = groupCandidatesByOrigin(
		[candidate("a", "src-a"), candidate("b", "src-b")],
		[assignment],
	);
	assert.equal(groups.length, 1);
	assert.equal(groups[0]?.candidates.length, 2);
	const calls: [string, string][] = [];
	confirmCurrentAssignment(groups[0]!, (accountId, ownerId) =>
		calls.push([accountId, ownerId]),
	);
	assert.deepEqual(calls, [["twitch:runner", "new:p"]]);
});

test("explicitly confirmed candidate origin does not request another confirmation", () => {
	const group = groupCandidatesByOrigin(
		[candidate("a", "src-a"), candidate("b", "src-b")],
		[{accountId: "twitch:runner", ownerId: "new:p", source: "user"}],
	)[0]!;
	let called = false;
	confirmCurrentAssignment(group, () => {
		called = true;
	});
	assert.equal(called, false);
});
