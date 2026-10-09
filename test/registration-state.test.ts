import assert from "node:assert/strict";
import test from "node:test";
import {
	isInputDirty,
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
		true,
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
