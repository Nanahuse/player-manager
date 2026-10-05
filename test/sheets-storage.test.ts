import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {type Directory} from "@nanahuse/player-manager-protocol";
import {validateDirectory} from "../src/domain/player.ts";
import {JsonRepository} from "../src/extension/repository.ts";
import {StorageRepository} from "../src/extension/storage.ts";
import {
	SheetsRepository,
	fromRows,
	toRows,
	spreadsheetId,
	serviceAccountToken,
	type SharedDirectory,
} from "../src/extension/sheets.ts";
const seed = validateDirectory({
	schemaVersion: 1,
	revision: 2,
	players: [
		{
			playerId: "p1",
			revision: 1,
			manualDisplayName: "=not-a-formula",
			racetime: null,
			speedrunCom: null,
			twitch: {userId: null, login: "runner"},
			youtube: "https://youtube.com/@runner",
		},
	],
});
const changed = validateDirectory({
	...seed,
	revision: 3,
	players: [{...seed.players[0], revision: 2, manualDisplayName: "Changed"}],
});
class Remote implements SharedDirectory {
	data: Directory | null = null;
	offline = false;
	readonly = false;
	writes = 0;
	loseResponse = false;
	async load() {
		if (this.offline) throw new Error("offline");
		return structuredClone(this.data);
	}
	async checkWritable() {
		if (this.readonly) throw new Error("read only");
	}
	async save(d: Directory) {
		await this.checkWritable();
		if (this.offline) throw new Error("offline");
		this.writes++;
		this.data = structuredClone(d);
		if (this.loseResponse) throw new Error("lost response");
	}
}
async function setup(t: any) {
	const dir = await mkdtemp(join(tmpdir(), "player-sheets-"));
	t.after(() => rm(dir, {recursive: true, force: true}));
	const local = new JsonRepository(join(dir, "players.json"));
	await local.save(seed);
	const remote = new Remote();
	const backups: Directory[] = [];
	const make = () =>
		new StorageRepository(
			local,
			join(dir, "storage.json"),
			() => remote,
			() => {},
			async (d) => {
				backups.push(d);
			},
		);
	return {local, remote, backups, make};
}
test("sheet rows roundtrip optional accounts, IDs and literal text without duplicate metadata", () => {
	assert.deepEqual(fromRows(toRows(seed)), seed);
	assert.deepEqual(
		fromRows(toRows({schemaVersion: 1, revision: 0, players: []})),
		{schemaVersion: 1, revision: 0, players: []},
	);
	assert.equal(fromRows([]), null);
	assert.throws(() => fromRows([["unrelated data"]]));
	assert.equal(
		spreadsheetId(
			"https://docs.google.com/spreadsheets/d/abcdefghijk/edit#gid=4",
		),
		"abcdefghijk",
	);
	assert.throws(() =>
		spreadsheetId("https://evil.test/spreadsheets/d/abcdefghijk"),
	);
});
test("empty shared tab is seeded; existing shared data is read with local backup", async (t) => {
	const {make, remote, local, backups} = await setup(t);
	const repo = make();
	await repo.load();
	await repo.configure("abcdefghijk", seed);
	assert.deepEqual(remote.data, seed);
	assert.equal(repo.status().destination, "spreadsheet");
	remote.data = changed;
	assert.deepEqual(await repo.load(), changed);
	assert.deepEqual(await local.load(), changed);
	assert.deepEqual(backups, [seed]);
});
test("no credentials and read-only sheets use local storage", async (t) => {
	await assert.rejects(serviceAccountToken()(), /未設定/);
	const {make, remote, local} = await setup(t);
	remote.data = seed;
	remote.readonly = true;
	const repo = make();
	assert.deepEqual(await repo.configure("abcdefghijk", seed), seed);
	assert.equal(repo.status().destination, "local");
	await repo.save(changed);
	assert.deepEqual(await local.load(), changed);
	assert.deepEqual(remote.data, seed);
	assert.equal(repo.status().pending, true);
	remote.readonly = false;
	// The first connection never established a shared base: do not overwrite its data.
	await repo.configure("abcdefghijk", changed);
	assert.equal(repo.status().destination, "local");
});
test("write outage falls back locally and survives restart; retry syncs if remote is unchanged", async (t) => {
	const {make, remote, local} = await setup(t);
	const repo = make();
	await repo.configure("abcdefghijk", seed);
	remote.offline = true;
	await repo.save(changed);
	assert.deepEqual(await local.load(), changed);
	assert.equal(repo.status().pending, true);
	remote.offline = false;
	const restarted = make();
	assert.deepEqual(await restarted.load(), changed);
	assert.equal(restarted.status().destination, "local");
	await restarted.configure("abcdefghijk", changed);
	assert.deepEqual(remote.data, changed);
	assert.equal(restarted.status().pending, false);
	assert.equal(restarted.status().destination, "spreadsheet");
});
test("remote edits block overwrites and keep the local pending version", async (t) => {
	const {make, remote, local} = await setup(t);
	const repo = make();
	await repo.configure("abcdefghijk", seed);
	const other = validateDirectory({...changed, revision: 4, players: []});
	remote.data = other;
	await repo.save(changed);
	assert.deepEqual(remote.data, other);
	assert.deepEqual(await local.load(), changed);
	assert.equal(repo.status().pending, true);
	await repo.configure("abcdefghijk", changed);
	assert.equal(repo.status().pending, true);
	assert.deepEqual(remote.data, other);
	await assert.rejects(repo.configure("other-sheet-id", changed));
	await repo.configure("", changed);
	assert.equal(repo.status().spreadsheetId, "");
	assert.deepEqual(await local.load(), changed);
});
test("lost write response is recovered without writing again", async (t) => {
	const {make, remote} = await setup(t);
	const repo = make();
	await repo.configure("abcdefghijk", seed);
	remote.loseResponse = true;
	await repo.save(changed);
	assert.equal(repo.status().pending, true);
	const writes = remote.writes;
	remote.loseResponse = false;
	await repo.configure("abcdefghijk", changed);
	assert.equal(repo.status().destination, "spreadsheet");
	assert.equal(remote.writes, writes);
});
test("Sheets adapter writes literal strings and clears deleted rows in one batch", async () => {
	const calls: {url: string; body: any}[] = [];
	const fetcher = (async (url, options) => {
		const u = String(url);
		const body = options?.body ? JSON.parse(String(options.body)) : null;
		calls.push({url: u, body});
		if (u.includes("?fields="))
			return Response.json({
				sheets: [
					{
						properties: {
							title: "PlayerDirectory",
							sheetId: 7,
							gridProperties: {rowCount: 1000, columnCount: 12},
						},
					},
				],
			});
		if (u.includes("/values/")) return Response.json({values: toRows(seed)});
		return Response.json({});
	}) as typeof fetch;
	const repo = new SheetsRepository(
		"abcdefghijk",
		async () => "test-token",
		fetcher,
	);
	assert.deepEqual(await repo.load(), seed);
	await repo.checkWritable();
	await repo.save(seed);
	const batch = calls.at(-1)!.body.requests;
	assert.equal(batch.length, 1);
	assert.equal(batch[0].updateCells.range.sheetId, 7);
	assert.equal(batch[0].updateCells.range.endRowIndex, undefined);
	assert.deepEqual(batch[0].updateCells.rows[2].values[2], {
		userEnteredValue: {stringValue: "=not-a-formula"},
	});
});
test("malformed shared content never gets overwritten", async (t) => {
	const {make, remote, local} = await setup(t);
	remote.load = async () => {
		throw new Error("invalid rows");
	};
	const repo = make();
	assert.deepEqual(await repo.configure("abcdefghijk", seed), seed);
	assert.equal(remote.writes, 0);
	await repo.save(changed);
	assert.deepEqual(await local.load(), changed);
	assert.equal(remote.writes, 0);
});

test("service account file supplies email and key to the token client", async (t) => {
	const {writeFile} = await import("node:fs/promises");
	const {JWT} = await import("google-auth-library");
	const dir = await mkdtemp(join(tmpdir(), "player-auth-"));
	t.after(() => rm(dir, {recursive: true, force: true}));
	const path = join(dir, "test-credentials.json");
	await writeFile(
		path,
		JSON.stringify({
			type: "service_account",
			client_email: "test@example.invalid",
			private_key: "test-only-key",
		}),
	);
	t.mock.method(
		JWT.prototype,
		"getAccessToken",
		async function (this: InstanceType<typeof JWT>) {
			assert.equal(this.email, "test@example.invalid");
			assert.equal(this.key, "test-only-key");
			assert.deepEqual(this.scopes, [
				"https://www.googleapis.com/auth/spreadsheets",
			]);
			return {token: "test-only-token"};
		},
	);
	assert.equal(await serviceAccountToken(path)(), "test-only-token");
});
