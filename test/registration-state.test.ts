import assert from "node:assert/strict";
import test from "node:test";
import {
	isInputDirty,
	newPlayerRegistration,
	nextMergeSurvivorSelection,
} from "../src/browser/dashboard/views/registration-state.ts";

test("draft input dirty comparison treats omitted and null optional values equally", () => {
	assert.equal(isInputDirty({}, {racetime: null, twitch: null}), false);
	assert.equal(
		isInputDirty({twitch: {login: "runner"}}, {twitch: {login: "other"}}),
		true,
	);
	assert.equal(
		isInputDirty({manualDisplayName: "Alice"}, {manualDisplayName: null}),
		false,
	);
	assert.equal(isInputDirty({racetime: "rt-a"}, {racetime: "rt-a"}), false);
});

test("merge survivor stays empty until selected and clears when proposal no longer contains it", () => {
	const proposal = {playerIds: ["alice", "bob"]};
	assert.equal(nextMergeSurvivorSelection("", proposal), "");
	assert.equal(nextMergeSurvivorSelection("bob", proposal), "bob");
	assert.equal(nextMergeSurvivorSelection("charlie", proposal), "");
	assert.equal(nextMergeSurvivorSelection("alice", null), "");
});

test("name-only confirmation counts only valid accounts assigned to the New Player", () => {
	const resolution = {
		players: [{id: "new", kind: "new"}],
		accounts: [{id: "assigned"}, {id: "elsewhere"}, {id: "discarded"}],
		assignments: [
			{accountId: "assigned", ownerId: "new"},
			{accountId: "elsewhere", ownerId: "existing"},
			{accountId: "discarded", ownerId: "new"},
			{accountId: "missing", ownerId: "new"},
		],
		discardedAccountIds: ["discarded"],
		newPlayerRequired: true,
	} as Parameters<typeof newPlayerRegistration>[0];
	assert.deepEqual(newPlayerRegistration(resolution, "Runner"), {
		accountCount: 1,
		needsConfirmation: false,
		empty: false,
	});
	resolution.assignments = resolution.assignments.filter(
		(item) => item.accountId !== "assigned",
	);
	assert.deepEqual(newPlayerRegistration(resolution, "Runner"), {
		accountCount: 0,
		needsConfirmation: true,
		empty: false,
	});
	assert.deepEqual(newPlayerRegistration(resolution, "  "), {
		accountCount: 0,
		needsConfirmation: false,
		empty: true,
	});
});
