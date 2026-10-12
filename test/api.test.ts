import assert from "node:assert/strict";
import {mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
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
	const messages: {
		name: string;
		payload: unknown;
		publishedRevision: number;
	}[] = [];
	let failNotification = false;
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
		sendMessage: (name: string, payload: unknown) => {
			if (failNotification) throw new Error("message unavailable");
			messages.push({
				name,
				payload,
				publishedRevision: (
					reps.get("player-directory")!.value as {revision: number}
				).revision,
			});
		},
		log: {warn: () => {}, error: () => {}},
	} as unknown as NodeCG.ServerAPI;
	try {
		const api = extension(nodecg);
		await api.ready;
		assert.deepEqual(messages, []);
		assert.equal(api.apiVersion, 3);
		const storage = await api.request("storage", undefined);
		assert.equal(storage.ok && storage.data.destination, "local");
		const unavailable = await api.request("configureStorage", {
			spreadsheet: "test-spreadsheet-id",
		});
		assert.equal(unavailable.ok, true, JSON.stringify(unavailable));
		assert.equal(unavailable.ok && unavailable.data.destination, "local");
		assert.equal(
			unavailable.ok && unavailable.data.spreadsheetId,
			"test-spreadsheet-id",
		);
		assert.match(
			unavailable.ok ? unavailable.data.message : "",
			/認証が未設定/,
		);
		await api.request("configureStorage", {spreadsheet: ""});
		assert.equal(handlers.size, 31);
		const missingRegistration = await api.request(
			"setRegistrationAccountUsage",
			{registrationId: "missing", accountId: "racetime:a", use: false},
		);
		assert.deepEqual(missingRegistration, {
			ok: false,
			error: {
				code: "registration_not_found",
				message: "Registration session not found",
			},
		});
		const missingMergeDecision = await api.request(
			"setRegistrationMergeDecision",
			{registrationId: "missing", decision: "keepSeparate"},
		);
		assert.deepEqual(missingMergeDecision, {
			ok: false,
			error: {
				code: "registration_not_found",
				message: "Registration session not found",
			},
		});
		assert.deepEqual(reps.get("player-directory-status")?.value, {
			ready: true,
			error: null,
		});
		const removedTwitchIdLookup = await api.request("find", {
			provider: "twitch-id",
			value: "123",
		});
		assert.equal(removedTwitchIdLookup.ok, false);
		const rejectedKnownAccount = await api.request("create", {
			input: {
				manualDisplayName: "API test",
				twitch: {userId: "123", login: "TEST"},
			},
		});
		assert.equal(rejectedKnownAccount.ok, false);
		const created = await api.request("create", {
			input: {
				manualDisplayName: "API test",
				profileAccounts: ["https://github.com/api-test"],
			},
		});
		assert.equal(created.ok, true);
		if (!created.ok) throw new Error(created.error.message);
		const p = created.data;
		assert.deepEqual(messages, [
			{
				name: "player-manager.v3.directoryChanged",
				payload: {directoryRevision: 1},
				publishedRevision: 1,
			},
		]);
		assert.deepEqual(await api.request("list", undefined), {
			ok: true,
			data: reps.get("player-directory")?.value,
		});
		const response = await new Promise((resolve) =>
			handlers.get("player-manager.v3.get")!(
				{playerId: p.playerId},
				(error, result) => {
					assert.equal(error, null);
					resolve(result);
				},
			),
		);
		assert.deepEqual(response, {ok: true, data: p});
		assert.deepEqual(
			await api.request("find", {provider: "twitch", value: "TEST"}),
			{
				ok: true,
				data: null,
			},
		);
		const invalid = await api.request("update", {
			playerId: p.playerId,
			revision: 0,
			input: p,
		});
		assert.equal(invalid.ok, false);
		failNotification = true;
		const {accounts: _accounts, ...legacyInput} = p;
		const updated = await api.request("update", {
			playerId: p.playerId,
			revision: 1,
			input: {...legacyInput, manualDisplayName: "Notifying failed"},
		});
		assert.equal(updated.ok, true);
		assert.equal(
			(reps.get("player-directory")!.value as {revision: number}).revision,
			2,
		);
		failNotification = false;
		const restarted = extension(nodecg);
		await restarted.ready;
		assert.equal(messages.length, 1);
		assert.deepEqual(await restarted.request("get", {playerId: p.playerId}), {
			ok: true,
			data: updated.ok ? updated.data : null,
		});
		assert.equal(
			(
				await restarted.request("delete", {
					playerId: p.playerId,
					revision: updated.ok ? updated.data.revision : p.revision,
				})
			).ok,
			true,
		);
		assert.equal(messages.length, 2);
		assert.deepEqual(messages[1], {
			name: "player-manager.v3.directoryChanged",
			payload: {directoryRevision: 3},
			publishedRevision: 3,
		});
		assert.deepEqual(await restarted.request("get", {playerId: p.playerId}), {
			ok: true,
			data: null,
		});
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});

test("startup failure can be explicitly initialized through the public API", async () => {
	const dir = await mkdtemp(join(tmpdir(), "player-manager-api-recovery-"));
	const dataFile = join(dir, "players.json");
	const settingsFile = `${dataFile}.storage.json`;
	const rawData = "{broken directory";
	const rawSettings = "{broken settings";
	await writeFile(dataFile, rawData);
	await writeFile(settingsFile, rawSettings);
	const reps = new Map<string, {value: unknown}>();
	const handlers = new Map<string, (data: unknown, ack: () => void) => void>();
	const logs: unknown[][] = [];
	const messages: string[] = [];
	const nodecg = {
		bundleConfig: {directoryFile: dataFile},
		Replicant: (name: string, options: {defaultValue: unknown}) => {
			const rep = {value: options.defaultValue};
			reps.set(name, rep);
			return rep;
		},
		listenFor: (
			name: string,
			handler: (data: unknown, ack: () => void) => void,
		) => {
			handlers.set(name, handler);
		},
		sendMessage: (name: string) => messages.push(name),
		log: {
			warn: (...args: unknown[]) => logs.push(args),
			error: (...args: unknown[]) => logs.push(args),
		},
	} as unknown as NodeCG.ServerAPI;
	try {
		const api = extension(nodecg);
		await api.ready;
		assert.deepEqual(reps.get("player-directory-status")?.value, {
			ready: false,
			error: "Directory could not be read; existing data was preserved",
		});
		assert.ok(logs.some((entry) => entry[1] instanceof SyntaxError));
		const rejected = await api.request("initializeDirectory", {
			confirm: false,
		} as never);
		assert.equal(rejected.ok, false);
		assert.equal(await readFile(dataFile, "utf8"), rawData);
		assert.equal(await readFile(settingsFile, "utf8"), rawSettings);
		const initialized = await api.request("initializeDirectory", {
			confirm: true,
		});
		assert.equal(initialized.ok, true);
		if (!initialized.ok) throw new Error(initialized.error.message);
		assert.deepEqual(initialized.data, {
			schemaVersion: 2,
			revision: 0,
			players: [],
		});
		assert.deepEqual(reps.get("player-directory")?.value, initialized.data);
		assert.deepEqual(reps.get("player-directory-status")?.value, {
			ready: true,
			error: null,
		});
		assert.deepEqual(messages, ["player-manager.v3.directoryChanged"]);
		assert.equal((await api.request("list", undefined)).ok, true);
		const names = await readdir(dir);
		const dataBackup = names.find((name) =>
			name.startsWith("players.json.before-initialize-"),
		);
		const settingsBackup = names.find((name) =>
			name.startsWith("players.json.storage.json.before-initialize-"),
		);
		assert.ok(dataBackup);
		assert.ok(settingsBackup);
		assert.equal(await readFile(join(dir, dataBackup), "utf8"), rawData);
		assert.equal(
			await readFile(join(dir, settingsBackup), "utf8"),
			rawSettings,
		);
		const created = await api.request("create", {
			input: {profileAccounts: ["https://github.com/recovered-player"]},
		});
		assert.equal(created.ok, true);
		const restarted = extension(nodecg);
		await restarted.ready;
		const loaded = await restarted.request("list", undefined);
		assert.equal(loaded.ok && loaded.data.players.length, 1);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});
