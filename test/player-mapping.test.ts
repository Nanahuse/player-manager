import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import reactPlugin from "@vitejs/plugin-react";
import {Window} from "happy-dom";
import {act} from "react";
import {createServer, type ViteDevServer} from "vite";

const player = {
	playerId: "existing/id",
	revision: 4,
	manualDisplayName: "Runner",
	racetime: null,
	speedrunCom: null,
	twitch: null,
	youtube: null,
};
let vite: ViteDevServer;
let window: Window;
let calls: Array<{operation: string; payload: unknown}>;
let failNextUpdate = false;

before(async () => {
	window = new Window({
		url: "http://localhost/bundles/player-manager/dashboard/PlayerMapping.html?standalone=true&playerId=existing%2Fid",
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		HTMLElement: window.HTMLElement,
		MouseEvent: window.MouseEvent,
		InputEvent: window.InputEvent,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: window.navigator,
	});
	calls = [];
	Object.assign(globalThis, {
		nodecg: {
			Replicant: (name: string) => ({
				on: (_event: string, callback: (value: unknown) => void) =>
					callback(
						name === "player-directory-status"
							? {ready: true, error: null}
							: {schemaVersion: 1, revision: 1, players: [player]},
					),
				removeListener: () => {},
			}),
			sendMessage: async (name: string, payload: unknown) => {
				const operation = name.split(".").at(-1)!;
				calls.push({operation, payload});
				if (operation === "get") return {ok: true, data: player};
				if (operation === "update") {
					if (failNextUpdate) {
						failNextUpdate = false;
						return {
							ok: false,
							error: {code: "player_changed", message: "stale"},
						};
					}
					const request = payload as {
						playerId: string;
						revision: number;
						input: typeof player;
					};
					return {
						ok: true,
						data: {...player, ...request.input, revision: request.revision + 1},
					};
				}
				return {ok: true, data: {playerId: "existing/id"}};
			},
		},
	});
	vite = await createServer({
		configFile: false,
		plugins: [reactPlugin()],
		server: {middlewareMode: true},
		appType: "custom",
	});
	window.document.body.innerHTML = "<div id='root'></div>";
	await act(async () => {
		await vite.ssrLoadModule("/src/browser/dashboard/views/PlayerMapping.tsx");
	});
});

after(async () => {
	await vite?.close();
	window?.happyDOM.abort();
});

test("direct URL loads the existing player and saves changes through update", async () => {
	const container = window.document.getElementById("root")!;
	assert.match(container.textContent ?? "", /Runner/);
	assert.match(container.textContent ?? "", /existing\/id/);
	assert.deepEqual(calls[0], {
		operation: "get",
		payload: {playerId: "existing/id"},
	});
	const name = container.querySelector("input") as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set?.call(name, "Changed");
		name.dispatchEvent(
			new window.InputEvent("input", {
				bubbles: true,
				inputType: "insertText",
				data: "Changed",
			}),
		);
	});
	await act(async () => {
		container
			.querySelector("form")!
			.dispatchEvent(
				new window.Event("submit", {bubbles: true, cancelable: true}),
			);
	});
	const update = calls.find((call) => call.operation === "update");
	assert.deepEqual(update?.payload, {
		playerId: "existing/id",
		revision: 4,
		input: {...player, manualDisplayName: "Changed"},
	});
	assert.match(container.textContent ?? "", /保存しました/);
});

test("a stale update keeps edited input and delete requires confirmation", async () => {
	const container = window.document.getElementById("root")!;
	const name = container.querySelector("input") as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set?.call(name, "Unsubmitted");
		name.dispatchEvent(
			new window.InputEvent("input", {
				bubbles: true,
				inputType: "insertText",
				data: "Unsubmitted",
			}),
		);
	});
	failNextUpdate = true;
	await act(async () =>
		container
			.querySelector("form")!
			.dispatchEvent(
				new window.Event("submit", {bubbles: true, cancelable: true}),
			),
	);
	assert.match(container.textContent ?? "", /player_changed: stale/);
	assert.equal(
		(container.querySelector("input") as HTMLInputElement).value,
		"Unsubmitted",
	);
	assert.ok(
		[...container.querySelectorAll("button")].some(
			(button) => button.textContent === "最新データを再読込",
		),
	);
	window.confirm = () => true;
	await act(async () =>
		[...container.querySelectorAll("button")]
			.find((button) => button.textContent === "最新データを再読込")!
			.click(),
	);
	assert.equal(
		(container.querySelector("input") as HTMLInputElement).value,
		"Runner",
	);
	await act(async () =>
		[...container.querySelectorAll("button")]
			.find((button) => button.textContent === "プレイヤーを削除")!
			.click(),
	);
	await act(async () =>
		[...container.querySelectorAll("button")]
			.find((button) => button.textContent === "削除を確定")!
			.click(),
	);
	assert.deepEqual(
		calls.findLast((call) => call.operation === "delete")?.payload,
		{playerId: "existing/id", revision: 4},
	);
	assert.match(container.textContent ?? "", /このPlayerを削除しました/);
});
