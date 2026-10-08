import assert from "node:assert/strict";
import test from "node:test";
import {type Directory} from "@nanahuse/player-manager-protocol";
import {validateDirectory} from "../src/domain/player.ts";
import {RegistrationService} from "../src/extension/registration.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";

async function setup() {
	let stored: Directory = {schemaVersion: 1, revision: 0, players: []},
		saves = 0,
		fail = false;
	const service = new PlayerDirectoryService(
		{
			load: async () => structuredClone(stored),
			save: async (d) => {
				if (fail) throw new Error("disk failure");
				saves++;
				stored = structuredClone(d);
			},
		},
		{
			getUser: async (id) => ({
				userId: id,
				name: id,
				twitchLogin: "linked",
				youtube: "https://youtube.com/@linked",
			}),
			searchUsers: async () => ({users: [], hasMore: false}),
		},
		undefined,
		{
			getUser: async (id) => ({userId: id, name: id, twitchLogin: "linked"}),
			searchUsers: async () => ({users: [], hasMore: false}),
		},
	);
	await service.reload();
	return {
		service,
		get saves() {
			return saves;
		},
		get stored() {
			return stored;
		},
		setFail: () => {
			fail = true;
		},
	};
}
test("mutate commits once, generates IDs, correlates refs and permits final-state identity swaps", async () => {
	const env = await setup();
	const first = await env.service.mutate([
		{type: "create", ref: "a", input: {twitch: {login: "a"}}},
		{type: "create", ref: "b", input: {twitch: {login: "b"}}},
	]);
	assert.equal(env.saves, 1);
	assert.equal(first.directoryRevision, 1);
	assert.deepEqual(
		first.results.map((r) => r.ref),
		["a", "b"],
	);
	const [a, b] = env.service.snapshot().players;
	await env.service.mutate([
		{
			type: "update",
			ref: "a",
			playerId: a!.playerId,
			revision: 1,
			input: {twitch: {login: "b"}},
		},
		{
			type: "update",
			ref: "b",
			playerId: b!.playerId,
			revision: 1,
			input: {twitch: {login: "a"}},
		},
	]);
	assert.equal(env.saves, 2);
	assert.equal(env.service.getPlayer(a!.playerId)?.twitch?.login, "b");
	assert.equal(JSON.stringify(env.stored).includes('"ref"'), false);
});
test("mutate rejects duplicate refs, duplicate identities, stale revisions and persistence errors without partial commits", async () => {
	const env = await setup();
	const p = await env.service.createPlayer({manualDisplayName: "original"});
	const before = env.service.snapshot();
	for (const operations of [
		[
			{type: "create", ref: "same", input: {}},
			{type: "create", ref: "same", input: {}},
		],
		[
			{type: "create", ref: "a", input: {twitch: {login: "same"}}},
			{type: "create", ref: "b", input: {twitch: {login: "same"}}},
		],
		[
			{type: "create", ref: "a", input: {}},
			{type: "delete", ref: "b", playerId: p.playerId, revision: 0},
		],
		[{type: "create", ref: "a", input: {playerId: "caller-owned"}}],
	]) {
		await assert.rejects(env.service.mutate(operations));
		assert.deepEqual(env.service.snapshot(), before);
		assert.equal(env.saves, 1);
	}
	env.setFail();
	await assert.rejects(
		env.service.mutate([
			{type: "delete", ref: "a", playerId: p.playerId, revision: p.revision},
			{type: "create", ref: "b", input: {}},
		]),
		{code: "persistence_failed"},
	);
	assert.deepEqual(env.service.snapshot(), before);
});
test("explicit null clears linked identities and missing YouTube is always canonical null", async () => {
	const {service} = await setup();
	const p = await service.createPlayer({speedrunCom: {userId: "src"}});
	assert.equal(p.twitch?.login, "linked");
	const updated = await service.updatePlayer(p.playerId, p.revision, {
		speedrunCom: {userId: "src"},
		twitch: null,
		youtube: null,
	});
	assert.equal(updated.twitch, null);
	assert.equal(updated.youtube, null);
	assert.equal(validateDirectory(service.snapshot()).players[0]?.youtube, null);
});
function registrations(env: Awaited<ReturnType<typeof setup>>) {
	return new RegistrationService(
		env.service,
		{
			getUser: async (value) => ({
				userId: value,
				name: value,
				twitchLogin: null,
				youtube: null,
			}),
			searchUsers: async () => [],
		},
		{
			getUser: async (value) => ({
				userId: value,
				name: value,
				twitchLogin: null,
			}),
			searchUsers: async () => ({users: [], hasMore: false}),
		},
		() => {},
	);
}

test("registration begins with a graph Resolution and commits once atomically", async () => {
	const env = await setup();
	const registration = registrations(env);
	const {registrationId} = await registration.begin({twitch: "runner"});
	const session = registration.get(registrationId)!;
	assert.equal(session.resolution?.accounts.length, 1);
	assert.equal(
		session.resolution?.evidence.some((item) => item.source === "input"),
		true,
	);
	assert.equal(env.saves, 0);
	const result = await registration.complete(registrationId);
	assert.equal(env.saves, 1);
	assert.equal(result.players.length, 1);
	assert.equal(result.players[0]?.twitch?.login, "runner");
	assert.equal(registration.get(registrationId)?.state, "completed");
});

test("failed atomic registration commit leaves Directory unchanged", async () => {
	const env = await setup();
	const registration = registrations(env);
	const {registrationId} = await registration.begin({twitch: "runner"});
	const before = env.service.snapshot();
	env.setFail();
	await assert.rejects(registration.complete(registrationId), {
		code: "persistence_failed",
	});
	assert.deepEqual(env.service.snapshot(), before);
	assert.equal(registration.get(registrationId)?.state, "pending");
});
