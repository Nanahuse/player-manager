import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {
	type Directory,
	type PlayerInput,
} from "@nanahuse/player-manager-protocol";
import {normalize, validateDirectory} from "../src/domain/player.ts";
import {JsonRepository, type Repository} from "../src/extension/repository.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";
import {SpeedrunClient, type UserLookup} from "../src/extension/speedrun.ts";

const input = (login = "runner"): PlayerInput => ({
	manualDisplayName: "Runner",
	racetime: null,
	speedrunCom: null,
	twitch: {login, userId: null},
});
const user = {userId: "src1", name: "SRC runner", twitchLogin: "runner"};
const lookup: UserLookup = {
	getUser: async () => user,
	searchUsers: async () => ({users: [user], hasMore: false}),
};
class Memory implements Repository {
	value: Directory = {schemaVersion: 1, revision: 0, players: []};
	fail = false;
	async load() {
		return structuredClone(this.value);
	}
	async save(value: Directory) {
		if (this.fail) throw new Error("disk full");
		this.value = structuredClone(value);
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
		assert.equal(created.twitch?.login, "runner");
		assert.notEqual(created.playerId, "runner");
		const updated = await service.updatePlayer(created.playerId, 1, {
			...created,
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
	await service.updatePlayer(p.playerId, 1, {...p, manualDisplayName: "New"});
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
test("Twitch metadata reserves ownership even without explicit Twitch link", async () => {
	const {service} = await setup();
	await service.createPlayer({
		...input(),
		twitch: undefined,
		racetime: {userId: "rt1", name: "One", twitchLogin: "runner"},
	});
	await assert.rejects(service.createPlayer(input()), {
		code: "identity_conflict",
	});
});
test("snapshots cannot mutate authoritative state", async () => {
	const {service} = await setup();
	const p = await service.createPlayer(input());
	p.twitch!.login = "changed";
	service.snapshot().players.length = 0;
	assert.equal(service.getPlayer(p.playerId)?.twitch?.login, "runner");
});
test("malformed stored IDs, schema versions and logins are rejected", () => {
	assert.throws(() =>
		normalize({twitch: {login: "https://twitch.tv/videos/123"}}),
	);
	assert.throws(() =>
		validateDirectory({schemaVersion: 2, revision: 0, players: []}),
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
