import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import reactPlugin from "@vitejs/plugin-react";
import {Window} from "happy-dom";
import React, {act} from "react";
import type {Root} from "react-dom/client";
import {createServer, type ViteDevServer} from "vite";

type SearchResponse = {
	identities: Array<{
		userId: string;
		name: string;
		twitchLogin?: string | null;
	}>;
	hasMore: boolean;
};

let vite: ViteDevServer;
let window: Window;
let root: Root;
let createRoot: typeof import("react-dom/client").createRoot;
let container: HTMLDivElement;
let SpeedrunUserSearch: React.ComponentType<{
	onSelect: (identity: {userId: string; name: string}) => void;
}>;
let requests: Array<{
	payload: unknown;
	resolve: (value: {ok: true; data: SearchResponse}) => void;
	reject: (error: Error) => void;
}>;
let sendMessage: (operation: string, payload: unknown) => Promise<unknown>;

before(async () => {
	window = new Window({url: "http://localhost/"});
	Object.assign(globalThis, {
		window,
		document: window.document,
		HTMLElement: window.HTMLElement,
		MouseEvent: window.MouseEvent,
		KeyboardEvent: window.KeyboardEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: window.navigator,
	});
	({createRoot} = await import("react-dom/client"));
	vite = await createServer({
		configFile: false,
		plugins: [reactPlugin()],
		server: {middlewareMode: true},
		appType: "custom",
	});
	({SpeedrunUserSearch} = await vite.ssrLoadModule(
		"/src/browser/dashboard/views/SpeedrunUserSearch.tsx",
	));
	sendMessage = (_operation, payload) =>
		new Promise((resolve, reject) =>
			requests.push({
				payload,
				resolve: resolve as (value: {ok: true; data: SearchResponse}) => void,
				reject,
			}),
		);
	Object.assign(globalThis, {
		nodecg: {sendMessage: (...args: [string, unknown]) => sendMessage(...args)},
	});
});

after(async () => {
	await vite?.close();
	window?.happyDOM.abort();
});

function response(...users: SearchResponse["identities"]): {
	ok: true;
	data: SearchResponse;
} {
	return {ok: true, data: {identities: users, hasMore: false}};
}

async function render(
	onSelect: (identity: {userId: string; name: string}) => void,
) {
	requests = [];
	container = window.document.createElement("div");
	window.document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root.render(React.createElement(SpeedrunUserSearch, {onSelect})),
	);
}

async function cleanup() {
	await act(async () => root.unmount());
	container.remove();
}

function input(): HTMLInputElement {
	return container.querySelector("input") as HTMLInputElement;
}

async function enterSearch(value: string) {
	await act(async () => {
		const field = input();
		Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set?.call(field, value);
		field.dispatchEvent(
			new window.InputEvent("input", {
				bubbles: true,
				inputType: "insertText",
				data: value,
			}),
		);
	});
}

async function pressEnter() {
	await act(async () =>
		input().dispatchEvent(
			new window.KeyboardEvent("keydown", {key: "Enter", bubbles: true}),
		),
	);
}

test("invalidates stale results, deduplicates searches, and allows selecting a result without a profile link", async () => {
	const selected: string[] = [];
	await render((identity) => selected.push(identity.userId));
	try {
		await enterSearch("   ");
		assert.equal(container.querySelector("button")?.disabled, true);
		await pressEnter();
		assert.equal(requests.length, 0);

		await enterSearch("previous");
		await pressEnter();
		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0].payload, {
			provider: "speedrunCom",
			query: "previous",
			mode: "name",
		});
		requests[0].resolve(response({userId: "old-id", name: "Old result"}));
		await act(async () => Promise.resolve());
		assert.ok(container.textContent?.includes("Old result"));

		await enterSearch("alpha");
		assert.equal(container.textContent?.includes("Old result"), false);
		await pressEnter();
		assert.equal(requests.length, 2);

		await enterSearch("beta");
		assert.equal(container.textContent?.includes("Old result"), false);
		await act(async () =>
			container
				.querySelector(".search button")
				?.dispatchEvent(new window.MouseEvent("click", {bubbles: true})),
		);
		assert.equal(requests.length, 3);
		await pressEnter();
		assert.equal(requests.length, 3);

		requests[2].resolve(response({userId: "beta-id", name: "Beta result"}));
		await act(async () => Promise.resolve());
		assert.ok(container.textContent?.includes("Beta result"));
		assert.equal(container.querySelector("a"), null);
		await act(async () =>
			[...container.querySelectorAll("button")]
				.find((button) => button.textContent?.includes("Beta result"))
				?.dispatchEvent(new window.MouseEvent("click", {bubbles: true})),
		);
		assert.deepEqual(selected, ["beta-id"]);
		assert.equal(requests.length, 3);

		requests[1].resolve(
			response({userId: "alpha-id", name: "Late alpha result"}),
		);
		await act(async () => Promise.resolve());
		assert.ok(container.textContent?.includes("Beta result"));
		assert.equal(container.textContent?.includes("Late alpha result"), false);
	} finally {
		await cleanup();
	}
});

test("clears search errors when the query changes and allows retry after failure", async () => {
	await render(() => {});
	try {
		await enterSearch("first");
		await act(async () =>
			container
				.querySelector(".search button")
				?.dispatchEvent(new window.MouseEvent("click", {bubbles: true})),
		);
		assert.equal(requests.length, 1);
		requests[0].reject(new Error("lookup_failed: unavailable"));
		await act(async () => Promise.resolve());
		assert.ok(container.querySelector('[role="alert"]'));

		await enterSearch("second");
		assert.equal(container.querySelector('[role="alert"]'), null);
		await pressEnter();
		assert.equal(requests.length, 2);
		requests[1].resolve(response({userId: "second-id", name: "Second result"}));
		await act(async () => Promise.resolve());
		assert.ok(container.textContent?.includes("Second result"));
	} finally {
		await cleanup();
	}
});

test("selected search identity reaches Registration input and Resolution only after re-exploration", async () => {
	const emptyResolution = {
		input: {},
		discardedAccountIds: [],
		confirmedCandidateAccountIds: [],
		players: [{id: "new-player", kind: "new", assignedAccountIds: []}],
		accounts: [],
		evidence: [],
		assignments: [],
		conflicts: [],
		candidates: [],
		warnings: [],
		errors: [],
		mergeProposal: null,
		mergeAssessment: null,
		requiredAccounts: [],
		requiredStatus: [],
		newPlayerRequired: true,
		deletePlayerIds: [],
		deletionCandidates: [],
	};
	const session: Record<string, unknown> = {
		registrationId: "registration-1",
		state: "pending",
		input: {},
		requiredAccounts: [],
		resolution: emptyResolution,
		result: null,
	};
	const operations: Array<{operation: string; payload: unknown}> = [];
	sendMessage = async (operation, payload) => {
		const name = operation.replace("player-manager.v2.", "");
		operations.push({operation: name, payload});
		if (name === "beginRegistration")
			return {
				ok: true,
				data: {registrationId: "registration-1", url: ""},
			};
		if (name === "getRegistration") return {ok: true, data: session};
		if (name === "searchIdentities")
			return {
				ok: true,
				data: {
					identities: [{userId: "runner-user", name: "Runner"}],
					hasMore: false,
				},
			};
		if (name === "resolveRegistration") {
			const input = (payload as {input: {speedrunCom: string}}).input;
			Object.assign(session, {
				input,
				resolution: {
					...emptyResolution,
					input,
					accounts: [
						{
							id: "speedrun-account",
							service: "speedrunCom",
							keys: [`speedrunCom:${input.speedrunCom}`],
							profile: {
								userId: input.speedrunCom,
								name: "Runner",
							},
						},
					],
					evidence: [
						{
							id: "input-evidence",
							source: "input",
							accounts: ["speedrun-account"],
						},
					],
					players: [
						{
							id: "new-player",
							kind: "new",
							assignedAccountIds: ["speedrun-account"],
						},
					],
					assignments: [
						{
							accountId: "speedrun-account",
							ownerId: "new-player",
							source: "new",
						},
					],
				},
			});
			return {ok: true, data: session};
		}
		if (name === "completeRegistration") {
			Object.assign(session, {
				state: "completed",
				result: {
					registrationId: "registration-1",
					directoryRevision: 1,
					players: [],
					deletedPlayerIds: [],
				},
			});
			return {ok: true, data: session.result};
		}
		throw new Error(`Unexpected operation: ${name}`);
	};
	let closeCalled = false;
	Object.defineProperty(window, "close", {
		configurable: true,
		value: () => {
			closeCalled = true;
		},
	});
	window.history.replaceState(null, "", "/Registration.html");
	const registrationContainer = window.document.createElement("div");
	registrationContainer.id = "root";
	window.document.body.append(registrationContainer);
	try {
		await act(async () => {
			await vite.ssrLoadModule("/src/browser/dashboard/views/Registration.tsx");
			await Promise.resolve();
		});
		const searchField = registrationContainer.querySelector(
			'[aria-label="Speedrun.comユーザー検索"] input',
		) as HTMLInputElement;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				window.HTMLInputElement.prototype,
				"value",
			)?.set?.call(searchField, "runner");
			searchField.dispatchEvent(
				new window.InputEvent("input", {bubbles: true, data: "runner"}),
			);
		});
		await act(async () =>
			[...registrationContainer.querySelectorAll("button")]
				.find((button) => button.textContent === "検索")
				?.dispatchEvent(new window.MouseEvent("click", {bubbles: true})),
		);
		assert.ok(
			operations.some(({operation}) => operation === "searchIdentities"),
		);
		await act(async () =>
			[...registrationContainer.querySelectorAll("button")]
				.find((button) => button.textContent?.includes("Runner · runner-user"))
				?.dispatchEvent(new window.MouseEvent("click", {bubbles: true})),
		);
		const accountField = [...registrationContainer.querySelectorAll("label")]
			.find((label) => label.textContent?.includes("Speedrun.com ID / URL"))
			?.querySelector("input");
		assert.equal(accountField?.value, "runner-user");
		const saveButton = [
			...registrationContainer.querySelectorAll("button"),
		].find((button) => button.textContent?.includes("この内容で保存"));
		assert.ok(saveButton?.disabled);
		assert.equal(
			operations.some(({operation}) => operation === "completeRegistration"),
			false,
		);
		assert.equal(
			operations.some(({operation}) => operation === "resolveRegistration"),
			false,
		);

		await act(async () =>
			[...registrationContainer.querySelectorAll("button")]
				.find((button) => button.textContent === "入力を再探索")
				?.dispatchEvent(new window.MouseEvent("click", {bubbles: true})),
		);
		const resolveOperation = operations.find(
			({operation}) => operation === "resolveRegistration",
		);
		assert.deepEqual(resolveOperation?.payload, {
			registrationId: "registration-1",
			input: {speedrunCom: "runner-user"},
		});
		assert.ok(registrationContainer.textContent?.includes("runner-user"));
		assert.equal(saveButton?.disabled, false);
		await act(async () =>
			saveButton?.dispatchEvent(
				new window.MouseEvent("click", {bubbles: true}),
			),
		);
		assert.ok(
			registrationContainer.textContent?.includes("登録が完了しました"),
		);
		await act(async () =>
			[...registrationContainer.querySelectorAll("button")]
				.find((button) => button.textContent === "閉じる")
				?.dispatchEvent(new window.MouseEvent("click", {bubbles: true})),
		);
		assert.equal(closeCalled, true);
	} finally {
		registrationContainer.remove();
	}
});
