import assert from "node:assert/strict";
import test from "node:test";
import {type Directory, validateDirectory} from "../src/domain/player.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";
import {RegistrationService} from "../src/extension/registration.ts";
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
			searchUsers: async () => [],
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
test("registration URL contains only opaque ID; existing completion and retries never mutate the player", async () => {
	const {service} = await setup();
	const p = await service.createPlayer({manualDisplayName: "saved"});
	const events: unknown[] = [];
	const reg = new RegistrationService(service, (...args) => events.push(args));
	const started = reg.begin({
		twitch: {login: "input-name"},
		source: "consumer",
		raceId: "discard",
	});
	assert.equal(started.url.includes("input-name"), false);
	assert.deepEqual(reg.get(started.registrationId)?.input, {
		twitch: {login: "input-name"},
	});
	const before = service.snapshot();
	const result = await reg.complete(started.registrationId, {
		action: "existing",
		playerId: p.playerId,
	});
	assert.equal(result.player.playerId, p.playerId);
	assert.deepEqual(service.snapshot(), before);
	assert.deepEqual(
		await reg.complete(started.registrationId, {
			action: "existing",
			playerId: p.playerId,
		}),
		result,
	);
	assert.equal(events.length, 1);
	assert.deepEqual(reg.get(started.registrationId)?.result, result);
});
test("registration create, explicit update, cancellation and expiration remain separate from Directory", async () => {
	const {service} = await setup();
	let now = 0;
	const events: unknown[] = [];
	const reg = new RegistrationService(
		service,
		(...args) => events.push(args),
		() => now,
		100,
	);
	const a = reg.begin({});
	const result = await reg.complete(a.registrationId, {
		action: "created",
		input: {manualDisplayName: "new"},
	});
	assert.equal(result.action, "created");
	const b = reg.begin({});
	const updated = await reg.complete(b.registrationId, {
		action: "updated",
		playerId: result.player.playerId,
		revision: 1,
		input: {manualDisplayName: "updated"},
	});
	assert.equal(updated.player.revision, 2);
	const c = reg.begin({});
	reg.cancel(c.registrationId);
	assert.equal(reg.get(c.registrationId)?.state, "cancelled");
	await assert.rejects(
		reg.complete(c.registrationId, {action: "created", input: {}}),
	);
	const d = reg.begin({});
	now = 101;
	assert.equal(reg.get(d.registrationId)?.state, "expired");
	await assert.rejects(reg.resolve(d.registrationId, {}), {
		code: "registration_expired",
	});
	assert.equal(service.snapshot().players.length, 1);
	assert.equal(
		JSON.stringify(service.snapshot()).includes("registrationId"),
		false,
	);
	assert.equal(events.length, 3);
});
test("registration conflict requires correction; duplicate completion in flight cannot create twice", async () => {
	const {service} = await setup();
	const reg = new RegistrationService(service, () => {});
	const a = reg.begin({});
	const s = await reg.resolve(a.registrationId, {
		racetime: {userId: "rt"},
		twitch: {login: "wrong"},
	});
	assert.equal(s.resolution?.status, "conflict");
	await assert.rejects(
		reg.complete(a.registrationId, {action: "created", input: {}}),
		{code: "identity_conflict"},
	);
	await reg.resolve(a.registrationId, {});
	const calls = await Promise.allSettled([
		reg.complete(a.registrationId, {action: "created", input: {}}),
		reg.complete(a.registrationId, {action: "created", input: {}}),
	]);
	assert.equal(calls.filter((c) => c.status === "fulfilled").length, 1);
	assert.equal(service.snapshot().players.length, 1);
});
import {completeRegistration} from "../src/browser/dashboard/complete-registration.ts";
import type {Operations, RegistrationSession} from "../src/protocol/index.ts";

test("registration submit resolves edited input and creates without a separate resolve click", async () => {
	const {service} = await setup();
	const registrations = new RegistrationService(service, () => {});
	const {registrationId} = registrations.begin({});
	const calls: string[] = [];
	const request = (async (operation: string, data: any) => {
		calls.push(operation);
		if (operation === "resolveRegistration")
			return registrations.resolve(data.registrationId, data.input);
		if (operation === "completeRegistration")
			return registrations.complete(data.registrationId, data);
		return registrations.get(data.registrationId);
	}) as <K extends keyof Operations>(
		op: K,
		data: Operations[K]["request"],
	) => Promise<Operations[K]["response"]>;
	const input = {
		manualDisplayName: "Edited name",
		racetime: null,
		speedrunCom: null,
		twitch: null,
		youtube: null,
	};
	const result = await completeRegistration(
		request,
		registrationId,
		{action: "created", input},
		true,
		input,
		() => {},
	);
	assert.equal(result?.state, "completed");
	assert.equal(result?.result?.player.manualDisplayName, "Edited name");
	assert.equal(service.snapshot().players.length, 1);
	assert.deepEqual(calls, [
		"resolveRegistration",
		"completeRegistration",
		"getRegistration",
	]);
});

test("automatic submit stops on conflicts, ambiguity and lookup failure without committing", async () => {
	for (const status of ["conflict", "ambiguous", "failure"] as const) {
		let saved = false;
		let shown: RegistrationSession | undefined;
		const request = (async (operation: string) => {
			if (operation === "resolveRegistration") {
				if (status === "failure") throw new Error("lookup failed");
				return {
					registrationId: "test",
					state: "pending",
					input: {},
					result: null,
					resolution: {
						status,
						playerId: null,
						input: {},
						candidates: [],
						warnings: [],
						message: status,
					},
				};
			}
			saved = true;
		}) as <K extends keyof Operations>(
			op: K,
			data: Operations[K]["request"],
		) => Promise<Operations[K]["response"]>;
		await assert.rejects(
			completeRegistration(
				request,
				"test",
				{action: "created", input: {}},
				true,
				{},
				(s) => {
					shown = s;
				},
			),
		);
		assert.equal(saved, false);
		if (status !== "failure") assert.equal(shown?.resolution?.status, status);
	}
});
