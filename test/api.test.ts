import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import type NodeCG from "@nodecg/types";
import extension from "../src/extension/index.ts";

test("public API startup, message ACK, errors, CRUD and restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "player-manager-api-"));
	const reps = new Map<string, {value: unknown}>();
	const handlers = new Map<
		string,
		(data: unknown, ack: (error: unknown, result: unknown) => void) => void
	>();
	const nodecg = {
		bundleConfig: {directoryFile: join(dir, "players.json")},
		Replicant: (name: string, options: {defaultValue: unknown}) => {
			const rep = {value: options.defaultValue};
			reps.set(name, rep);
			return rep;
		},
		listenFor: (
			name: string,
			handler: (
				data: unknown,
				ack: (error: unknown, result: unknown) => void,
			) => void,
		) => {
			handlers.set(name, handler);
		},
		log: {warn: () => {}, error: () => {}},
	} as unknown as NodeCG.ServerAPI;
	try {
		const api = extension(nodecg);
		await api.ready;
		assert.equal(api.apiVersion, 1);
		assert.equal(handlers.size, 10);
		assert.deepEqual(reps.get("player-directory-status")?.value, {
			ready: true,
			error: null,
		});
		const created = await api.request("create", {
			input: {
				manualDisplayName: "API test",
				racetime: null,
				speedrunCom: null,
				twitch: {userId: "123", login: "TEST"},
			},
		});
		assert.equal(created.ok, true);
		if (!created.ok) throw new Error(created.error.message);
		const p = created.data;
		const response = await new Promise((resolve) =>
			handlers.get("player-directory.v1.get")!(
				{playerId: p.playerId},
				(error, result) => {
					assert.equal(error, null);
					resolve(result);
				},
			),
		);
		assert.deepEqual(response, {ok: true, data: p});
		assert.deepEqual(
			await api.request("find", {provider: "twitch-id", value: "123"}),
			{ok: true, data: p},
		);
		assert.deepEqual(
			await api.request("find", {provider: "twitch", value: " TEST "}),
			{ok: true, data: p},
		);
		const invalid = await api.request("update", {
			playerId: p.playerId,
			revision: 0,
			input: p,
		});
		assert.equal(invalid.ok, false);
		const restarted = extension(nodecg);
		await restarted.ready;
		assert.deepEqual(await restarted.request("get", {playerId: p.playerId}), {
			ok: true,
			data: p,
		});
		assert.equal(
			(
				await restarted.request("delete", {
					playerId: p.playerId,
					revision: p.revision,
				})
			).ok,
			true,
		);
		assert.deepEqual(await restarted.request("get", {playerId: p.playerId}), {
			ok: true,
			data: null,
		});
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});
