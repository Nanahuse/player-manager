import assert from "node:assert/strict";
import {after, afterEach, before, test} from "node:test";
import reactPlugin from "@vitejs/plugin-react";
import {Window} from "happy-dom";
import React, {act} from "react";
import type {Root} from "react-dom/client";
import {createServer, type ViteDevServer} from "vite";

const firstPlayer = {
	playerId: "player-a",
	revision: 4,
	manualDisplayName: "Runner A",
	racetime: null,
	speedrunCom: null,
	twitch: null,
	youtube: null,
};
const secondPlayer = {
	...firstPlayer,
	playerId: "player-b",
	manualDisplayName: "Runner B",
};
const directory = {
	schemaVersion: 1 as const,
	revision: 2,
	players: [firstPlayer, secondPlayer],
};
type Call = {operation: string; payload: unknown};
type Screen = {
	window: Window;
	container: HTMLElement;
	calls: Call[];
	root: Root;
	statusChanged: (
		value: {ready: boolean; error: string | null} | undefined,
	) => void;
	deferNext: (operation: string) => (value: unknown) => void;
	respondNext: (operation: string, response: unknown) => void;
};

let vite: ViteDevServer;
let App: React.ComponentType;
let testWindow: Window;
let screens: Screen[] = [];

before(async () => {
	testWindow = new Window({url: "http://localhost/"});
	Object.assign(globalThis, {
		window: testWindow,
		document: testWindow.document,
		HTMLElement: testWindow.HTMLElement,
		MouseEvent: testWindow.MouseEvent,
		InputEvent: testWindow.InputEvent,
		Event: testWindow.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: testWindow.navigator,
	});
	vite = await createServer({
		configFile: false,
		plugins: [
			{
				enforce: "pre",
				name: "player-mapping-test-render-stub",
				resolveId(source, importer) {
					if (
						source === "../../render" &&
						importer?.endsWith("/dashboard/views/PlayerMapping.tsx")
					)
						return "\0player-mapping-test-render";
				},
				load(id) {
					if (id === "\0player-mapping-test-render")
						return "export const render = () => {};";
				},
			},
			reactPlugin(),
		],
		server: {middlewareMode: true},
		appType: "custom",
	});
	({App} = await vite.ssrLoadModule(
		"/src/browser/dashboard/views/PlayerMapping.tsx",
	));
});

afterEach(async () => {
	for (const screen of screens) {
		await act(async () => screen.root.unmount());
		screen.container.remove();
	}
	screens = [];
});

after(async () => {
	await vite?.close();
	testWindow?.happyDOM.abort();
});

async function mount(url: string): Promise<Screen> {
	const window = testWindow;
	window.happyDOM.setURL(url);
	window.confirm = () => true;
	const calls: Call[] = [];
	const responses = new Map<string, unknown[]>();
	const statusListeners: Array<
		(value: {ready: boolean; error: string | null} | undefined) => void
	> = [];
	const status = {ready: true, error: null as string | null};
	const apiResponse = (operation: string, payload: unknown): unknown => {
		if (operation === "get") return {ok: true, data: firstPlayer};
		if (operation === "update") {
			const request = payload as {
				playerId: string;
				revision: number;
				input: typeof firstPlayer;
			};
			return {
				ok: true,
				data: {
					...firstPlayer,
					...request.input,
					playerId: request.playerId,
					revision: request.revision + 1,
				},
			};
		}
		if (operation === "delete")
			return {
				ok: true,
				data: {playerId: (payload as {playerId: string}).playerId},
			};
		if (operation === "reload") return {ok: true, data: directory};
		if (operation === "configureStorage")
			return {ok: true, data: {message: "設定しました"}};
		throw new Error(`Unexpected API operation: ${operation}`);
	};
	Object.assign(globalThis, {
		nodecg: {
			Replicant: (name: string) => ({
				on: (_event: string, callback: (value: unknown) => void) => {
					if (name === "player-directory-status") {
						statusListeners.push(callback as (typeof statusListeners)[number]);
						callback(status);
					} else callback(directory);
				},
				removeListener: () => {},
			}),
			sendMessage: (name: string, payload: unknown) => {
				const operation = name.split(".").at(-1)!;
				calls.push({operation, payload});
				return Promise.resolve(
					responses.get(operation)?.shift() ?? apiResponse(operation, payload),
				);
			},
		},
	});
	const container = window.document.createElement("div");
	window.document.body.append(container);
	const {createRoot} = await import("react-dom/client");
	const root = createRoot(container);
	await act(async () => root.render(React.createElement(App)));
	const screen: Screen = {
		window,
		container,
		calls,
		root,
		statusChanged: (value) => {
			statusListeners.forEach((listener) => {
				listener(value);
			});
		},
		deferNext: (operation) => {
			let finish!: (value: unknown) => void;
			const pending = new Promise<unknown>((resolve) => {
				finish = resolve;
			});
			responses.set(operation, [...(responses.get(operation) ?? []), pending]);
			return finish;
		},
		respondNext: (operation, response) =>
			responses.set(operation, [...(responses.get(operation) ?? []), response]),
	};
	screens.push(screen);
	return screen;
}

function button(screen: Screen, name: string): HTMLButtonElement {
	const found = [...screen.container.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === name,
	);
	assert.ok(found, `button not found: ${name}`);
	return found as HTMLButtonElement;
}
async function click(screen: Screen, name: string): Promise<void> {
	await act(async () => button(screen, name).click());
}
async function fillName(screen: Screen, value: string): Promise<void> {
	const input = screen.container.querySelector("input") as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			screen.window.HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(
			new screen.window.InputEvent("input", {
				bubbles: true,
				inputType: "insertText",
				data: value,
			}),
		);
	});
}
async function submit(screen: Screen): Promise<void> {
	await act(async () =>
		screen.container
			.querySelector("section[aria-label='プレイヤーを編集'] form")!
			.dispatchEvent(
				new screen.window.Event("submit", {bubbles: true, cancelable: true}),
			),
	);
}

test("editing operation locks Directory selection and reload until save completes", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	await click(screen, "Runner Aplayer-a");
	const finish = screen.deferNext("update");
	await submit(screen);
	assert.equal(button(screen, "Runner Bplayer-b").disabled, true);
	assert.equal(button(screen, "保存先から再読込").disabled, true);
	assert.equal(button(screen, "ローカル保存を使用").disabled, true);
	assert.equal(
		screen.calls.filter((call) => call.operation === "update").length,
		1,
	);
	await act(async () =>
		finish({ok: true, data: {...firstPlayer, revision: 5}}),
	);
	await click(screen, "プレイヤーを削除");
	const finishDelete = screen.deferNext("delete");
	await click(screen, "削除を確定");
	assert.equal(button(screen, "Runner Bplayer-b").disabled, true);
	assert.equal(button(screen, "保存先から再読込").disabled, true);
	await act(async () => finishDelete({ok: true, data: {playerId: "player-a"}}));
	assert.equal(
		screen.container.querySelector("section[aria-label='プレイヤーを編集']"),
		null,
	);
});

test("Directory reload locks editor save and rejects a simultaneous submit", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	await click(screen, "Runner Aplayer-a");
	const finish = screen.deferNext("reload");
	await click(screen, "保存先から再読込");
	assert.equal(button(screen, "保存").disabled, true);
	await submit(screen);
	assert.equal(
		screen.calls.filter((call) => call.operation === "update").length,
		0,
	);
	await act(async () => finish({ok: true, data: directory}));
});

test("a direct edit loads and updates the addressed existing player", async () => {
	const screen = await mount(
		"http://localhost/bundles/player-manager/dashboard/PlayerMapping.html?standalone=true&playerId=player-a",
	);
	assert.match(screen.container.textContent ?? "", /Runner A/);
	assert.deepEqual(screen.calls[0], {
		operation: "get",
		payload: {playerId: "player-a"},
	});
	await fillName(screen, "Changed");
	await submit(screen);
	assert.deepEqual(
		screen.calls.find((call) => call.operation === "update")?.payload,
		{
			playerId: "player-a",
			revision: 4,
			input: {...firstPlayer, manualDisplayName: "Changed"},
		},
	);
});

test("canceling conflict reload preserves input and conflict actions", async () => {
	const screen = await mount(
		"http://localhost/bundles/player-manager/dashboard/PlayerMapping.html?playerId=player-a",
	);
	await fillName(screen, "Unsubmitted");
	screen.respondNext("update", {
		ok: false,
		error: {code: "player_changed", message: "stale"},
	});
	await submit(screen);
	screen.window.confirm = () => false;
	await click(screen, "最新データを再読込");
	assert.equal(
		(screen.container.querySelector("input") as HTMLInputElement).value,
		"Unsubmitted",
	);
	assert.match(screen.container.textContent ?? "", /player_changed: stale/);
	assert.equal(
		screen.calls.filter((call) => call.operation === "get").length,
		1,
	);
});

test("confirmed conflict reload applies the latest player and revision", async () => {
	const screen = await mount(
		"http://localhost/bundles/player-manager/dashboard/PlayerMapping.html?playerId=player-a",
	);
	screen.respondNext("update", {
		ok: false,
		error: {code: "player_changed", message: "stale"},
	});
	await submit(screen);
	screen.window.confirm = () => true;
	screen.respondNext("get", {
		ok: true,
		data: {...firstPlayer, revision: 9, manualDisplayName: "Newest"},
	});
	await click(screen, "最新データを再読込");
	assert.equal(
		(screen.container.querySelector("input") as HTMLInputElement).value,
		"Newest",
	);
	assert.match(screen.container.textContent ?? "", /revision 9/);
});

test("a missing player after reload cannot be saved or deleted", async () => {
	const screen = await mount(
		"http://localhost/bundles/player-manager/dashboard/PlayerMapping.html?playerId=player-a",
	);
	screen.respondNext("update", {
		ok: false,
		error: {code: "player_changed", message: "stale"},
	});
	await submit(screen);
	screen.window.confirm = () => true;
	screen.respondNext("get", {ok: true, data: null});
	await click(screen, "最新データを再読込");
	assert.match(
		screen.container.textContent ?? "",
		/Playerが存在しないため編集できません/,
	);
	assert.equal(button(screen, "保存").disabled, true);
	assert.equal(button(screen, "プレイヤーを削除").disabled, true);
	assert.equal(
		screen.calls.filter((call) => call.operation === "update").length,
		1,
	);
});

test("successful save clears delete confirmation", async () => {
	const screen = await mount(
		"http://localhost/bundles/player-manager/dashboard/PlayerMapping.html?playerId=player-a",
	);
	await click(screen, "プレイヤーを削除");
	assert.match(
		screen.container.textContent ?? "",
		/このプレイヤーを削除しますか/,
	);
	await submit(screen);
	assert.doesNotMatch(screen.container.textContent ?? "", /削除を確定/);
	assert.match(screen.container.textContent ?? "", /保存しました/);
});

test("directory availability changes preserve direct edit input without another get", async () => {
	const screen = await mount(
		"http://localhost/bundles/player-manager/dashboard/PlayerMapping.html?playerId=player-a",
	);
	await fillName(screen, "Keep this draft");
	await act(async () => screen.statusChanged({ready: false, error: "offline"}));
	assert.equal(
		(screen.container.querySelector("input") as HTMLInputElement).value,
		"Keep this draft",
	);
	assert.equal(button(screen, "保存").disabled, true);
	await act(async () => screen.statusChanged({ready: true, error: null}));
	assert.equal(
		(screen.container.querySelector("input") as HTMLInputElement).value,
		"Keep this draft",
	);
	assert.equal(button(screen, "保存").disabled, false);
	assert.equal(
		screen.calls.filter((call) => call.operation === "get").length,
		1,
	);
});

test("ordinary Directory selects and edits a player without fetching or standalone controls", async () => {
	const screen = await mount(
		"http://localhost/bundles/player-manager/dashboard/PlayerMapping.html",
	);
	assert.equal(
		screen.calls.filter((call) => call.operation === "get").length,
		0,
	);
	assert.equal(
		[...screen.container.querySelectorAll("button")].some((item) =>
			item.textContent?.includes("別画面で編集"),
		),
		false,
	);
	await click(screen, "Runner Bplayer-b");
	assert.match(screen.container.textContent ?? "", /player-b/);
	await submit(screen);
	assert.deepEqual(
		screen.calls.find((call) => call.operation === "update")?.payload,
		{playerId: "player-b", revision: 4, input: secondPlayer},
	);
});
