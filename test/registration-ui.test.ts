import assert from "node:assert/strict";
import {after, afterEach, before, test} from "node:test";
import type {
	Directory,
	MatchingInput,
	Player,
} from "@nanahuse/player-manager-protocol";
import reactPlugin from "@vitejs/plugin-react";
import {Window} from "happy-dom";
import React, {act} from "react";
import type {Root} from "react-dom/client";
import {createServer, type ViteDevServer} from "vite";
import {RegistrationService} from "../src/extension/registration.ts";
import {PlayerDirectoryService} from "../src/extension/service.ts";

let vite: ViteDevServer;
let window: Window;
let App: React.ComponentType;
let root: Root;
let container: HTMLDivElement;

before(async () => {
	window = new Window({url: "http://localhost/Registration.html"});
	Object.assign(globalThis, {
		window,
		document: window.document,
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: window.navigator,
	});
	vite = await createServer({
		configFile: false,
		plugins: [
			{
				name: "registration-test-render-stub",
				enforce: "pre",
				resolveId(source, importer) {
					if (
						source === "../../render" &&
						importer?.endsWith("/Registration.tsx")
					)
						return "\0render-stub";
				},
				load(id) {
					if (id === "\0render-stub") return "export const render = () => {};";
				},
			},
			reactPlugin(),
		],
		server: {middlewareMode: true, hmr: false},
		appType: "custom",
	});
	({App} = await vite.ssrLoadModule(
		"/src/browser/dashboard/views/Registration.tsx",
	));
});
afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});
after(async () => {
	await vite?.close();
	await window?.happyDOM.abort();
});

async function mount(input: MatchingInput = {}, existing: Player[] = []) {
	let stored: Directory = {schemaVersion: 2, revision: 0, players: existing};
	let failSave = false;
	let lookupCount = 0;
	const src = {
		getUser: async (userId: string) => {
			lookupCount++;
			return {
				userId,
				name: userId,
				weblink: `https://www.speedrun.com/users/${userId}`,
			};
		},
		searchUsers: async () => ({users: [], hasMore: false}),
	};
	const players = new PlayerDirectoryService(
		{
			load: async () => stored,
			save: async (next) => {
				if (failSave) throw new Error("save unavailable");
				stored = next;
			},
		},
		src,
	);
	await players.reload();
	const registrations = new RegistrationService(
		players,
		{
			getUser: async (userId) => ({userId, name: userId}),
			searchUsers: async () => [],
		},
		src,
		() => {},
	);
	const {registrationId} = await registrations.begin(input, [], true);
	window.happyDOM.setURL(
		`http://localhost/Registration.html?registrationId=${registrationId}`,
	);
	const calls: string[] = [];
	Object.assign(globalThis, {
		nodecg: {
			sendMessage: async (name: string, payload: Record<string, unknown>) => {
				const operation = name.split(".").at(-1)!;
				calls.push(operation);
				try {
					let data: unknown;
					switch (operation) {
						case "getRegistration":
							data = registrations.get(registrationId);
							break;
						case "resolveRegistration":
							data = await registrations.resolve(registrationId, payload.input);
							break;
						case "completeRegistration":
							data = await registrations.complete(registrationId);
							break;
						case "setRegistrationAccountUsage":
							data = registrations.setAccountUsage(
								registrationId,
								String(payload.accountId),
								Boolean(payload.use),
							);
							break;
						case "assignRegistrationAccount":
							data = registrations.assign(
								registrationId,
								String(payload.accountId),
								String(payload.ownerId),
							);
							break;
						case "getUser":
							data = await src.getUser(String(payload.userId));
							break;
						default:
							throw new Error(`Unexpected operation: ${operation}`);
					}
					return {ok: true, data};
				} catch (error) {
					return {
						ok: false,
						error: {code: "invalid_input", message: (error as Error).message},
					};
				}
			},
		},
	});
	container = window.document.createElement("div");
	window.document.body.append(container);
	const {createRoot} = await import("react-dom/client");
	root = createRoot(container);
	await act(async () => root.render(React.createElement(App)));
	return {
		calls,
		registrations,
		registrationId,
		stored: () => stored,
		failSave: (value: boolean) => {
			failSave = value;
		},
		lookups: () => lookupCount,
	};
}
function button(name: string) {
	const found = [...container.querySelectorAll("button")].find(
		(entry) => entry.textContent?.trim() === name,
	);
	assert.ok(found, `Missing button: ${name}`);
	return found;
}
async function click(name: string) {
	await act(async () => button(name).click());
}
async function name(value: string) {
	const input = container.querySelector(
		".matrix-player input",
	) as HTMLInputElement;
	assert.ok(input, "New Player name belongs in the Matrix");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)!.set!.call(input, value);
		input.dispatchEvent(new window.InputEvent("input", {bubbles: true}));
	});
}

test("empty registration cannot save; name-only save can be cancelled and confirmed once", async () => {
	const screen = await mount();
	assert.equal(button("この内容で保存").disabled, true);
	await name("Runner A");
	assert.equal(button("この内容で保存").disabled, false);
	await click("この内容で保存");
	assert.ok(container.querySelector("dialog[open]"));
	assert.equal(screen.calls.includes("completeRegistration"), false);
	await click("戻る");
	assert.equal(screen.stored().players.length, 0);
	await click("この内容で保存");
	const confirm = button("名前だけで登録");
	await act(async () => {
		confirm.click();
		confirm.click();
	});
	assert.equal(
		screen.calls.filter((op) => op === "completeRegistration").length,
		1,
	);
	assert.equal(screen.stored().players[0].manualDisplayName, "Runner A");
	assert.equal(screen.stored().players[0].accounts?.length, 0);
});

test("name changes save with accounts without manual exploration or profile refetch", async () => {
	const screen = await mount({speedrunCom: "runner"});
	const lookups = screen.lookups();
	await name("New name");
	assert.doesNotMatch(container.textContent ?? "", /入力に未反映の変更/);
	await click("この内容で保存");
	assert.equal(container.querySelector("dialog"), null);
	assert.equal(screen.lookups(), lookups);
	assert.equal(screen.stored().players[0].manualDisplayName, "New name");
	assert.equal(screen.stored().players[0].accounts?.length, 1);
});

test("accounts alone save normally and blank names never create empty Players", async () => {
	const screen = await mount({twitch: {login: "runner"}});
	await click("この内容で保存");
	assert.equal(container.querySelector("dialog"), null);
	assert.equal(screen.stored().players[0].accounts?.length, 1);
});

test("discarded discovered accounts require name-only confirmation and retain Registration evidence", async () => {
	const screen = await mount({twitch: {login: "runner"}});
	assert.match(container.textContent ?? "", /Evidence:/);
	assert.equal(
		container.querySelector(".account-chip a")?.textContent,
		"runner",
	);
	await act(async () =>
		(container.querySelector(".chip-select") as HTMLButtonElement).click(),
	);
	const unused = container.querySelector(
		"input[value='unused']",
	) as HTMLInputElement;
	await act(async () => unused.click());
	await name("Name only");
	await click("この内容で保存");
	assert.ok(container.querySelector("dialog[open]"));
	await click("名前だけで登録");
	assert.equal(screen.stored().players[0].accounts?.length, 0);
	assert.equal(screen.stored().players[0].manualDisplayName, "Name only");
});

test("save failures keep the name and allow confirmation and retry", async () => {
	const screen = await mount();
	await name("Retry runner");
	screen.failSave(true);
	await click("この内容で保存");
	await click("名前だけで登録");
	assert.match(container.textContent ?? "", /Could not save directory/);
	assert.equal(
		(container.querySelector(".matrix-player input") as HTMLInputElement).value,
		"Retry runner",
	);
	screen.failSave(false);
	await click("この内容で保存");
	await click("名前だけで登録");
	assert.equal(screen.stored().players[0].manualDisplayName, "Retry runner");
});

test("name-only Player is created when discovered accounts belong to an existing Player", async () => {
	const existing: Player = {
		playerId: "existing",
		revision: 1,
		manualDisplayName: "Existing",
		racetime: null,
		speedrunCom: null,
		twitch: {login: "runner"},
		youtube: null,
		accounts: [
			{
				id: "tw-existing",
				service: "twitch",
				role: "primary",
				identity: {login: "runner"},
			},
		],
	};
	const screen = await mount({twitch: {login: "runner"}}, [existing]);
	await name("Separate name");
	await click("この内容で保存");
	assert.ok(container.querySelector("dialog[open]"));
	await click("名前だけで登録");
	assert.equal(screen.stored().players.length, 2);
	assert.equal(
		screen
			.stored()
			.players.find((player) => player.manualDisplayName === "Separate name")
			?.accounts?.length,
		0,
	);
	assert.equal(
		screen.stored().players.find((player) => player.playerId === "existing")
			?.accounts?.length,
		1,
	);
});
