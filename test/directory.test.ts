import assert from "node:assert/strict";
import {mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {
	type Directory,
	type IdentityResolutionInput,
} from "@nanahuse/player-manager-protocol";
import {
	DirectoryError,
	normalize,
	validateDirectory,
} from "../src/domain/player.ts";
import {JsonRepository, type Repository} from "../src/extension/repository.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";
import {SpeedrunClient, type UserLookup} from "../src/extension/speedrun.ts";

const input = (slug = "runner"): IdentityResolutionInput => ({
	manualDisplayName: "Runner",
	profileAccounts: [`https://github.com/${slug.trim().toLowerCase()}`],
});
const user = {userId: "src1", name: "SRC runner", twitchLogin: "runner"};
const lookup: UserLookup = {
	getUser: async () => user,
	searchUsers: async () => ({users: [user], hasMore: false}),
};
class Memory implements Repository {
	value: Directory = {schemaVersion: 1, revision: 0, players: []};
	fail = false;
	failInitialization = false;
	loadError: unknown;
	async load() {
		if (this.loadError) throw this.loadError;
		return structuredClone(this.value);
	}
	async save(value: Directory) {
		if (this.fail) throw new Error("disk full");
		this.value = structuredClone(value);
	}
	async initializeEmpty() {
		if (this.failInitialization) throw new Error("backup failed");
		this.value = {schemaVersion: 2, revision: 0, players: []};
		return structuredClone(this.value);
	}
}
async function setup(client = lookup) {
	const repo = new Memory();
	const service = new PlayerDirectoryService(repo, client, undefined, {
		searchUsers: async () => [],
		getUser: async (userId) => ({
			userId,
			name: "RaceTime runner",
			twitchLogin: userId === "rt1" ? "runner" : null,
		}),
	});
	await service.reload();
	return {repo, service};
}

test("CRUD persists stable internal IDs and revisions across restart", async () => {
	const folder = await mkdtemp(join(tmpdir(), "player-manager-"));
	try {
		const file = join(folder, "directory.json");
		const repo = new JsonRepository(file);
		const service = new PlayerDirectoryService(repo, lookup);
		await service.reload();
		const created = await service.createPlayer(input(" RUNNER "));
		assert.equal(
			created.accounts?.[0]?.profileUrl,
			"https://github.com/runner",
		);
		assert.notEqual(created.playerId, "runner");
		const updated = await service.updatePlayer(created.playerId, 1, {
			manualDisplayName: "Updated",
		});
		const restarted = new PlayerDirectoryService(repo, lookup);
		await restarted.reload();
		assert.deepEqual(restarted.getPlayer(created.playerId), updated);
		await restarted.deletePlayer(updated.playerId, updated.revision);
		assert.equal(JSON.parse(await readFile(file, "utf8")).players.length, 0);
	} finally {
		await rm(folder, {recursive: true, force: true});
	}
});
test("concurrent duplicate registration has exactly one winner", async () => {
	const {service} = await setup();
	const results = await Promise.allSettled([
		service.createPlayer(input()),
		service.createPlayer(input("RUNNER")),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(service.snapshot().players.length, 1);
});
test("optimistic revisions reject stale edit and delete", async () => {
	const {service} = await setup();
	const p = await service.createPlayer(input());
	await service.updatePlayer(p.playerId, 1, {manualDisplayName: "New"});
	await assert.rejects(service.updatePlayer(p.playerId, 1, p), {
		code: "player_changed",
	});
	await assert.rejects(service.deletePlayer(p.playerId, 1), {
		code: "player_changed",
	});
});
test("failed persistence does not publish or change state", async () => {
	const {service, repo} = await setup();
	repo.fail = true;
	await assert.rejects(service.createPlayer(input()), {
		code: "persistence_failed",
	});
	assert.equal(service.snapshot().players.length, 0);
	repo.fail = false;
	await service.createPlayer(input());
	assert.equal(service.snapshot().players.length, 1);
});
test("directory change notification compares full contents and ignores initial or identical loads", async () => {
	const repo = new Memory();
	const notifications: number[] = [];
	const service = new PlayerDirectoryService(
		repo,
		lookup,
		undefined,
		undefined,
		(revision) => notifications.push(revision),
	);
	await service.reload();
	assert.deepEqual(notifications, []);
	await service.reload();
	assert.deepEqual(notifications, []);
	repo.value = {
		schemaVersion: 1,
		revision: 0,
		players: [
			{
				playerId: "external",
				revision: 1,
				manualDisplayName: "External",
				racetime: null,
				speedrunCom: null,
				twitch: null,
				youtube: null,
			},
		],
	};
	await service.reload();
	assert.deepEqual(notifications, [0]);
	await service.reload();
	assert.deepEqual(notifications, [0]);
});
test("corrupt storage is preserved and cannot be overwritten", async () => {
	const folder = await mkdtemp(join(tmpdir(), "player-manager-corrupt-"));
	try {
		const file = join(folder, "data.json");
		await writeFile(file, "broken");
		const service = new PlayerDirectoryService(
			new JsonRepository(file),
			lookup,
		);
		await assert.rejects(service.reload(), {code: "directory_unavailable"});
		await assert.rejects(service.createPlayer(input()), {
			code: "directory_unavailable",
		});
		assert.equal(await readFile(file, "utf8"), "broken");
	} finally {
		await rm(folder, {recursive: true, force: true});
	}
});

test("read failures retain their cause and explicit initialization backs up corrupt JSON", async () => {
	const folder = await mkdtemp(join(tmpdir(), "player-manager-recovery-"));
	try {
		const file = join(folder, "data.json");
		await writeFile(file, "{broken");
		const errors: unknown[] = [];
		const service = new PlayerDirectoryService(
			new JsonRepository(file),
			lookup,
			undefined,
			undefined,
			undefined,
			(error) => errors.push(error),
		);
		await assert.rejects(service.reload(), (error: DirectoryError) => {
			assert.equal(error.code, "directory_unavailable");
			assert.ok(error.cause instanceof SyntaxError);
			return true;
		});
		assert.ok(errors[0] instanceof SyntaxError);
		assert.equal(await readFile(file, "utf8"), "{broken");
		await assert.rejects(service.initializeDirectory(false), {
			code: "invalid_input",
		});
		assert.equal(await readFile(file, "utf8"), "{broken");
		assert.deepEqual(await service.initializeDirectory(true), {
			schemaVersion: 2,
			revision: 0,
			players: [],
		});
		assert.equal(
			await readFile(file, "utf8"),
			'{\n  "schemaVersion": 2,\n  "revision": 0,\n  "players": []\n}\n',
		);
		const backupName = (await readdir(folder)).find((name) =>
			name.startsWith("data.json.before-initialize-"),
		);
		assert.ok(backupName);
		assert.equal(await readFile(join(folder, backupName), "utf8"), "{broken");
		await assert.rejects(service.initializeDirectory(true), {
			code: "invalid_input",
		});
	} finally {
		await rm(folder, {recursive: true, force: true});
	}
});

test("failed initialization leaves service unavailable and can be retried", async () => {
	const repo = new Memory();
	repo.failInitialization = true;
	const notifications: number[] = [];
	const service = new PlayerDirectoryService(
		repo,
		lookup,
		undefined,
		undefined,
		(revision) => notifications.push(revision),
	);
	await assert.rejects(service.initializeDirectory(true), {
		code: "persistence_failed",
	});
	assert.deepEqual(notifications, []);
	assert.throws(() => service.snapshot(), {code: "directory_unavailable"});
	repo.failInitialization = false;
	await service.initializeDirectory(true);
	assert.deepEqual(notifications, [0]);
});

test("a failed reload keeps an already loaded Directory available", async () => {
	const repo = new Memory();
	const service = new PlayerDirectoryService(repo, lookup);
	const loaded = await service.reload();
	const failure = new Error("file became unreadable");
	repo.loadError = failure;
	await assert.rejects(service.reload(), (error: DirectoryError) => {
		assert.equal(error.code, "directory_unavailable");
		assert.equal(error.cause, failure);
		return true;
	});
	assert.deepEqual(service.snapshot(), loaded);
});

test("initialization and reload are serialized around the uninitialized state", async () => {
	const repo = new Memory();
	const service = new PlayerDirectoryService(repo, lookup);
	const initialized = service.initializeDirectory(true);
	const loaded = service.reload();
	assert.deepEqual(await initialized, {
		schemaVersion: 2,
		revision: 0,
		players: [],
	});
	assert.deepEqual(await loaded, await initialized);
	await assert.rejects(service.initializeDirectory(true), {
		code: "invalid_input",
	});
});
test("known service accounts require Registration instead of direct create", async () => {
	const {service} = await setup();
	await assert.rejects(
		service.createPlayer({
			manualDisplayName: "Runner",
			racetime: {userId: "rt1", name: "One", twitchLogin: "runner"},
		}),
		{code: "invalid_input"},
	);
});
test("snapshots cannot mutate authoritative state", async () => {
	const {service} = await setup();
	const p = await service.createPlayer(input());
	p.accounts![0]!.profileUrl = "changed";
	service.snapshot().players.length = 0;
	assert.equal(
		service.getPlayer(p.playerId)?.accounts?.[0]?.profileUrl,
		"https://github.com/runner",
	);
});
test("malformed stored IDs, schema versions and logins are rejected", () => {
	assert.throws(() =>
		normalize({twitch: {login: "https://twitch.tv/videos/123"}}),
	);
	assert.throws(() =>
		validateDirectory({schemaVersion: 3, revision: 0, players: []}),
	);
	assert.throws(() =>
		validateDirectory({schemaVersion: 1, revision: -1, players: []}),
	);
});
test("Speedrun adapter maps public API and encodes queries", async () => {
	const paths: string[] = [];
	const client = new SpeedrunClient((async (url) => {
		paths.push(String(url));
		return new Response(
			JSON.stringify({
				data: [
					{
						id: "src1",
						names: {international: "Name"},
						twitch: {uri: "https://www.twitch.tv/Runner"},
					},
				],
				pagination: {links: []},
			}),
		);
	}) as typeof fetch);
	const result = await client.searchUsers("a&b", "name");
	assert.equal(result.users[0]?.twitchLogin, "runner");
	assert.match(paths[0]!, /name=a%26b/);
});
test("Speedrun optional profile links do not invalidate users", async () => {
	let logCalls = 0;
	const makeClient = (data: Record<string, unknown>) =>
		new SpeedrunClient(
			(async () => new Response(JSON.stringify({data}))) as typeof fetch,
			() => logCalls++,
		);
	const base = {
		id: "src1",
		names: {international: "ArgorRTA"},
		weblink: "not a URL",
	};
	const valid = await makeClient({
		...base,
		twitch: {uri: "https://www.twitch.tv/foo"},
	}).getUser("src1");
	assert.equal(valid.twitchLogin, "foo");
	assert.equal(valid.userId, "src1");
	assert.equal(valid.name, "ArgorRTA");

	for (const twitch of [
		{uri: "https://www.twitch.tv/foo/videos"},
		{uri: "https://www.twitch.tv/foo/about"},
		{uri: "https://example.com/foo"},
		{uri: "not a URL"},
		{uri: "https://twitch.tv/invalid-login!"},
	]) {
		const user = await makeClient({...base, twitch}).getUser("src1");
		assert.equal(user.twitchLogin, null);
		assert.equal(user.userId, "src1");
		assert.equal(user.name, "ArgorRTA");
	}
	const invalidYoutube = await makeClient({
		...base,
		youtube: {uri: "https://www.youtube.com/watch?v=video"},
	}).getUser("src1");
	assert.equal(invalidYoutube.userId, "src1");
	assert.equal(invalidYoutube.youtube, undefined);
	assert.equal((await makeClient(base).getUser("src1")).weblink, undefined);
	assert.equal(logCalls, 0);
});
test("Speedrun required identity fields remain mandatory", async () => {
	const logged: {message: string; error: unknown}[] = [];
	const clientFor = (data: Record<string, unknown>) =>
		new SpeedrunClient(
			(async () => new Response(JSON.stringify({data}))) as typeof fetch,
			(message, error) => logged.push({message, error}),
		);
	await assert.rejects(
		clientFor({names: {international: "Name"}}).getUser("src1"),
		{code: "lookup_failed"},
	);
	await assert.rejects(clientFor({id: "src1", names: {}}).getUser("src1"), {
		code: "lookup_failed",
	});
	assert.equal(logged.length, 2);
	assert.equal(logged[0]?.message, "Invalid Speedrun.com user response");
	assert.ok(logged[0]?.error instanceof Error);
	assert.equal(logged[1]?.message, "Invalid Speedrun.com user response");
	assert.ok(logged[1]?.error instanceof Error);
});
test("rate limits and malformed upstream responses are explicit failures", async () => {
	let calls = 0;
	const limited = new SpeedrunClient((async () => {
		calls++;
		return new Response("", {status: 429});
	}) as typeof fetch);
	await assert.rejects(limited.getUser("id"), {code: "rate_limited"});
	await assert.rejects(limited.getUser("id"), {code: "rate_limited"});
	assert.equal(calls, 1);
	const malformed = new SpeedrunClient(
		(async () => new Response('{"data":{}}')) as typeof fetch,
	);
	await assert.rejects(malformed.getUser("id"), {code: "lookup_failed"});
});
