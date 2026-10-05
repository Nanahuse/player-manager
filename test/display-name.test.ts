import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveDisplayName,
	type PlayerInput,
} from "@nanahuse/player-manager-protocol";
import {normalize, validateDirectory} from "../src/domain/player.ts";
import {RaceTimeClient} from "../src/extension/racetime.ts";
test("display name follows manual, Twitch display, login, SRC, RaceTime order", () => {
	const p: PlayerInput = {
		manualDisplayName: "手動名",
		twitch: {userId: null, login: "login_name", displayName: "Twitch表示名"},
		speedrunCom: {userId: "s", name: "SRC名", twitchLogin: null},
		racetime: {userId: "r", name: "RaceTime名", twitchLogin: null},
	};
	assert.equal(resolveDisplayName(p), "手動名");
	p.manualDisplayName = null;
	assert.equal(resolveDisplayName(p), "Twitch表示名");
	delete p.twitch!.displayName;
	assert.equal(resolveDisplayName(p), "login_name");
	p.twitch = null;
	assert.equal(resolveDisplayName(p), "SRC名");
	p.speedrunCom = null;
	assert.equal(resolveDisplayName(p), "RaceTime名");
});
test("Twitch display name survives directory normalization and reload", () => {
	const p = normalize({
		twitch: {login: "runner", userId: null, displayName: "走者"},
	});
	const state = validateDirectory({
		schemaVersion: 1,
		revision: 1,
		players: [{...p, playerId: "p", revision: 1}],
	});
	assert.equal(resolveDisplayName(state.players[0]!), "走者");
	assert.equal(state.players[0]?.manualDisplayName, null);
});
test("RaceTime public Twitch display name is used only for matching Twitch login", async () => {
	const client = new RaceTimeClient(
		(async () =>
			new Response(
				JSON.stringify({
					id: "rt1",
					full_name: "RaceName",
					twitch_channel: "https://twitch.tv/runner",
					twitch_display_name: "走者",
				}),
			)) as typeof fetch,
	);
	const profile = await client.getUser("rt1");
	assert.equal(profile.twitchDisplayName, "走者");
	const p: PlayerInput = {
		manualDisplayName: null,
		racetime: profile,
		speedrunCom: null,
		twitch: {userId: null, login: "runner"},
	};
	assert.equal(resolveDisplayName(p), "走者");
	p.twitch!.login = "different";
	assert.equal(resolveDisplayName(p), "different");
});
