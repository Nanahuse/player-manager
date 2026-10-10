import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {Window} from "happy-dom";
import React, {act} from "react";
import type {Root} from "react-dom/client";
import reactPlugin from "@vitejs/plugin-react";
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
	Object.assign(globalThis, {
		nodecg: {
			sendMessage: (_operation: string, payload: unknown) =>
				new Promise((resolve, reject) =>
					requests.push({
						payload,
						resolve: resolve as (value: {
							ok: true;
							data: SearchResponse;
						}) => void,
						reject,
					}),
				),
		},
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

		await enterSearch("alpha");
		await pressEnter();
		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0].payload, {
			provider: "speedrunCom",
			query: "alpha",
			mode: "name",
		});
		requests[0].resolve(response({userId: "old-id", name: "Old result"}));
		await act(async () => Promise.resolve());
		assert.ok(container.textContent?.includes("Old result"));

		await enterSearch("beta");
		assert.equal(container.textContent?.includes("Old result"), false);
		await act(async () =>
			container
				.querySelector(".search button")
				?.dispatchEvent(new window.MouseEvent("click", {bubbles: true})),
		);
		assert.equal(requests.length, 2);
		await pressEnter();
		assert.equal(requests.length, 2);

		requests[1].resolve(response({userId: "beta-id", name: "Beta result"}));
		await act(async () => Promise.resolve());
		assert.ok(container.textContent?.includes("Beta result"));
		assert.equal(container.querySelector("a"), null);
		await act(async () =>
			[...container.querySelectorAll("button")]
				.find((button) => button.textContent?.includes("Beta result"))
				?.dispatchEvent(new window.MouseEvent("click", {bubbles: true})),
		);
		assert.deepEqual(selected, ["beta-id"]);
		assert.equal(requests.length, 2);

		requests[0].resolve(response({userId: "old-id", name: "Late old result"}));
		await act(async () => Promise.resolve());
		assert.ok(container.textContent?.includes("Beta result"));
		assert.equal(container.textContent?.includes("Late old result"), false);
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
