import assert from "node:assert/strict";
import {after, afterEach, before, test} from "node:test";
import type {Directory, Player} from "@nanahuse/player-manager-protocol";
import reactPlugin from "@vitejs/plugin-react";
import {Window} from "happy-dom";
import React, {act} from "react";
import type {Root} from "react-dom/client";
import {createServer, type ViteDevServer} from "vite";

const firstPlayer: Player = {
	playerId: "player-a",
	revision: 4,
	manualDisplayName: "Runner A",
	racetime: null,
	speedrunCom: null,
	twitch: null,
	youtube: null,
	accounts: [],
};
const secondPlayer = {
	...firstPlayer,
	playerId: "player-b",
	manualDisplayName: "Runner B",
};
const directory: Directory = {
	schemaVersion: 2,
	revision: 2,
	players: [firstPlayer, secondPlayer],
};
type Call = {operation: string; payload: unknown};
type Screen = {
	window: Window;
	container: HTMLElement;
	calls: Call[];
	root: Root;
	directoryChanged: (value: Directory) => void;
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

function accountKey(account: NonNullable<Player["accounts"]>[number]) {
	if (account.profileUrl) return `url:${account.service}:${account.profileUrl}`;
	if (account.service === "twitch" && "login" in account.identity)
		return `twitch:${account.identity.login.toLowerCase()}`;
	if (account.service === "youtube" && typeof account.identity === "string")
		return `youtube:${account.identity}`;
	if (typeof account.identity === "string")
		return `${account.service}:${account.identity}`;
	return `${account.service}:${account.identity.userId}`;
}

function resolutionFor(
	player: Player,
	input: {accountRequests?: {service: string; value: string}[]} = {},
) {
	const records = [...(player.accounts ?? [])];
	for (const request of input.accountRequests ?? []) {
		const service =
			request.service === "profileUrl"
				? new URL(request.value).hostname.toLowerCase()
				: request.service;
		const profileUrl =
			request.service === "profileUrl" ? request.value : undefined;
		const identity =
			service === "twitch"
				? {login: request.value.toLowerCase()}
				: (profileUrl ?? request.value);
		const candidate = {
			id: `${service}:${request.value.toLowerCase()}`,
			service,
			role: records.some(
				(account) => account.service === service && account.role === "primary",
			)
				? ("secondary" as const)
				: ("primary" as const),
			...(profileUrl ? {profileUrl} : {}),
			identity,
		};
		if (
			!records.some((account) => accountKey(account) === accountKey(candidate))
		)
			records.push(candidate);
	}
	const accounts = records.map((record) => ({
		id: record.id,
		service: record.service,
		keys: [accountKey(record)],
		profile:
			typeof record.identity === "string"
				? {name: record.identity}
				: {
						userId: "userId" in record.identity ? record.identity.userId : "",
						name:
							"login" in record.identity
								? record.identity.login
								: record.identity.name,
					},
	}));
	return {
		input,
		discardedAccountIds: [] as string[],
		confirmedCandidateAccountIds: [] as string[],
		players: [
			{
				id: player.playerId,
				kind: "existing" as const,
				player,
				assignedAccountIds: accounts.map((item) => item.id),
			},
		],
		accounts,
		evidence: [],
		assignments: records.map((record, index) => ({
			accountId: accounts[index]!.id,
			ownerId: player.playerId,
			role: record.role,
			source: "user" as const,
		})),
		conflicts: [],
		roleConflicts: [],
		candidates: [],
		warnings: [],
		errors: [],
		mergeProposal: null,
		mergeDecision: "undecided" as const,
		mergeAssessment: null,
		requiredAccounts: [],
		requiredStatus: [],
		newPlayerRequired: false,
		deletePlayerIds: [],
		deletionCandidates: [],
	};
}

async function mount(
	url: string,
	editedPlayer: Player = firstPlayer,
): Promise<Screen> {
	const window = testWindow;
	window.happyDOM.setURL(url);
	window.confirm = () => true;
	let currentDirectory: Directory = {
		...directory,
		players: directory.players.map((entry) =>
			entry.playerId === editedPlayer.playerId ? editedPlayer : entry,
		),
	};
	const players = new Map(
		currentDirectory.players.map((player) => [player.playerId, player]),
	);
	const calls: Call[] = [];
	const responses = new Map<string, unknown[]>();
	const directoryListeners: Array<(value: Directory) => void> = [];
	let sessionCounter = 0;
	const sessions = new Map<string, any>();
	const resolveSession = (session: any, input: any) => {
		session.input = input;
		session.resolution = resolutionFor(
			players.get(session.target.playerId)!,
			input,
		);
		return session;
	};
	const apiResponse = (operation: string, payload: unknown): unknown => {
		const value = payload as any;
		if (operation === "get")
			return {ok: true, data: players.get(value.playerId) ?? null};
		if (operation === "beginRegistration") {
			const target = value.target;
			const player = players.get(target.playerId)!;
			const id = `registration-${++sessionCounter}`;
			sessions.set(id, {
				registrationId: id,
				state: "pending",
				input: {},
				target,
				requiredAccounts: [],
				resolution: resolutionFor(player),
				result: null,
			});
			return {
				ok: true,
				data: {
					registrationId: id,
					url: `/Registration.html?registrationId=${id}`,
				},
			};
		}
		if (operation === "getRegistration")
			return {
				ok: true,
				data: structuredClone(sessions.get(value.registrationId) ?? null),
			};
		if (operation === "resolveRegistration")
			return {
				ok: true,
				data: structuredClone(
					resolveSession(sessions.get(value.registrationId), value.input),
				),
			};
		if (operation === "setRegistrationAccountPrimary") {
			const session = sessions.get(value.registrationId);
			const selected = session.resolution.assignments.find(
				(entry: any) => entry.accountId === value.accountId,
			);
			const service = session.resolution.accounts.find(
				(account: any) => account.id === value.accountId,
			)?.service;
			for (const assignment of session.resolution.assignments)
				if (
					assignment.ownerId === selected.ownerId &&
					session.resolution.accounts.find(
						(account: any) => account.id === assignment.accountId,
					)?.service === service
				)
					assignment.role = "secondary";
			selected.role = "primary";
			return {ok: true, data: structuredClone(session)};
		}
		if (operation === "setRegistrationAccountUsage") {
			const session = sessions.get(value.registrationId);
			const ids = new Set(session.resolution.discardedAccountIds);
			value.use ? ids.delete(value.accountId) : ids.add(value.accountId);
			session.resolution.discardedAccountIds = [...ids];
			return {ok: true, data: structuredClone(session)};
		}
		if (operation === "assignRegistrationAccount")
			return {
				ok: true,
				data: structuredClone(sessions.get(value.registrationId)),
			};
		if (operation === "setRegistrationDisplayName") {
			const session = sessions.get(value.registrationId);
			session.displayNameChange = {
				playerId: session.target.playerId,
				value: value.value,
			};
			return {ok: true, data: structuredClone(session)};
		}
		if (operation === "completeRegistration") {
			const session = sessions.get(value.registrationId);
			const before = players.get(session.target.playerId)!;
			const accounts = session.resolution.accounts.flatMap((account: any) => {
				if (session.resolution.discardedAccountIds.includes(account.id))
					return [];
				const assignment = session.resolution.assignments.find(
					(entry: any) => entry.accountId === account.id,
				);
				if (assignment?.ownerId !== before.playerId) return [];
				const current = before.accounts?.find(
					(entry) => entry.id === account.id,
				);
				const profileUrl = account.keys[0]?.startsWith("url:")
					? account.keys[0].slice(account.keys[0].indexOf(":", 4) + 1)
					: undefined;
				return [
					{
						...(current ?? {
							id: account.id,
							service: account.service,
							identity: profileUrl ?? account.keys[0],
						}),
						role: assignment.role ?? "primary",
						...(profileUrl ? {profileUrl} : {}),
					},
				];
			});
			const updated = {
				...before,
				revision: before.revision + 1,
				manualDisplayName:
					session.displayNameChange?.value ?? before.manualDisplayName,
				accounts,
			};
			players.set(before.playerId, updated);
			session.state = "completed";
			return {
				ok: true,
				data: {
					registrationId: value.registrationId,
					directoryRevision: currentDirectory.revision + 1,
					players: [updated],
					deletedPlayerIds: [],
				},
			};
		}
		if (operation === "cancelRegistration") {
			const session = sessions.get(value.registrationId);
			session.state = "cancelled";
			return {ok: true, data: structuredClone(session)};
		}
		if (operation === "delete")
			return {ok: true, data: {playerId: value.playerId}};
		if (operation === "reload") return {ok: true, data: currentDirectory};
		if (operation === "configureStorage")
			return {ok: true, data: {message: "設定しました"}};
		throw new Error(`Unexpected API operation: ${operation}`);
	};
	Object.assign(globalThis, {
		nodecg: {
			Replicant: (name: string) => ({
				on: (_event: string, callback: (value: unknown) => void) => {
					if (name === "player-directory-status")
						callback({ready: true, error: null});
					else {
						directoryListeners.push(callback as (value: Directory) => void);
						callback(currentDirectory);
					}
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
		directoryChanged: (value) => {
			currentDirectory = value;
			for (const player of value.players) players.set(player.playerId, player);
			directoryListeners.forEach((listener) => {
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
async function click(screen: Screen, name: string) {
	await act(async () => button(screen, name).click());
}
async function fill(input: HTMLInputElement, window: Window, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(
			new window.InputEvent("input", {
				bubbles: true,
				inputType: "insertText",
				data: value,
			}),
		);
	});
}
function nameInput(screen: Screen) {
	return screen.container.querySelector(
		".player-display-name input",
	) as HTMLInputElement;
}
function addInput(screen: Screen) {
	return screen.container.querySelector(
		"section[aria-label='Accountを追加'] input",
	) as HTMLInputElement;
}
async function waitForSession(screen: Screen) {
	await act(async () => Promise.resolve());
	assert.equal(
		screen.calls.filter((call) => call.operation === "beginRegistration")
			.length,
		1,
	);
}

test("selecting a Player starts one target Session and shows Accounts in the same editor", async () => {
	const player = {
		...firstPlayer,
		accounts: [
			{
				id: "gh-one",
				service: "github.com",
				role: "primary" as const,
				profileUrl: "https://github.com/runner",
				identity: "https://github.com/runner",
			},
		],
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		player,
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	assert.match(
		screen.container.textContent ?? "",
		/https:\/\/github.com\/runner/,
	);
	assert.match(screen.container.textContent ?? "", /Primary/);
	assert.equal(screen.container.querySelector("a[href*='Registration']"), null);
	assert.deepEqual(
		screen.calls.find((call) => call.operation === "beginRegistration")
			?.payload,
		{input: {}, target: {playerId: "player-a", expectedRevision: 4}},
	);
});

test("Account requests resolve immediately, support repeated services, and remain independent seeds", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await fill(addInput(screen), screen.window, "one");
	await click(screen, "追加");
	await fill(addInput(screen), screen.window, "two");
	await click(screen, "追加");
	const resolves = screen.calls.filter(
		(call) => call.operation === "resolveRegistration",
	);
	assert.equal(resolves.length, 2);
	assert.deepEqual((resolves[1]!.payload as any).input.accountRequests, [
		{service: "twitch", value: "one"},
		{service: "twitch", value: "two"},
	]);
	assert.match(screen.container.textContent ?? "", /one/);
	assert.match(screen.container.textContent ?? "", /two/);
});

test("Primary changes and account exclusion/restoration use the same Session", async () => {
	const player: Player = {
		...firstPlayer,
		accounts: [
			{
				id: "tw-one",
				service: "twitch",
				role: "primary",
				identity: {login: "one"},
			},
			{
				id: "tw-two",
				service: "twitch",
				role: "secondary",
				identity: {login: "two"},
			},
		],
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		player,
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	const secondRow = [...screen.container.querySelectorAll(".account-row")].find(
		(row) => row.textContent?.includes("two"),
	)!;
	await act(async () =>
		(secondRow.querySelector("button") as HTMLButtonElement).click(),
	);
	const changed = screen.calls
		.filter((call) => call.operation === "setRegistrationAccountPrimary")
		.at(-1);
	assert.equal((changed!.payload as any).accountId, "tw-two");
	const firstRow = [...screen.container.querySelectorAll(".account-row")].find(
		(row) => row.textContent?.includes("one"),
	)!;
	await act(async () =>
		(firstRow.querySelectorAll("button")[1] as HTMLButtonElement).click(),
	);
	assert.ok(
		screen.container
			.querySelector(".unused-accounts")
			?.textContent?.includes("one"),
	);
	await click(screen, "復元");
	assert.equal(
		(
			screen.calls
				.filter((call) => call.operation === "setRegistrationAccountUsage")
				.at(-1)!.payload as any
		).accountId,
		"tw-one",
	);
});

test("display name and added Accounts save together through one completion", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await fill(nameInput(screen), screen.window, "New name");
	await fill(addInput(screen), screen.window, "runner");
	await click(screen, "追加");
	await click(screen, "変更を保存");
	const operations = screen.calls.map((call) => call.operation);
	assert.ok(
		operations.indexOf("setRegistrationDisplayName") <
			operations.indexOf("completeRegistration"),
	);
	assert.equal(
		operations.filter((operation) => operation === "completeRegistration")
			.length,
		1,
	);
	assert.match(screen.container.textContent ?? "", /revision 5/);
	assert.match(screen.container.textContent ?? "", /New name/);
});

test("external Directory updates block stale Session saves and reload with the new revision", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await fill(addInput(screen), screen.window, "unsaved");
	await click(screen, "追加");
	await act(async () =>
		screen.directoryChanged({
			...directory,
			players: directory.players.map((entry) =>
				entry.playerId === "player-a"
					? {...entry, revision: 5, manualDisplayName: "Changed elsewhere"}
					: entry,
			),
		}),
	);
	assert.equal(button(screen, "変更を保存").disabled, true);
	assert.match(screen.container.textContent ?? "", /編集中の内容を保持/);
	await click(screen, "最新データを再読込");
	const targets = screen.calls
		.filter((call) => call.operation === "beginRegistration")
		.map((call) => (call.payload as any).target.expectedRevision);
	assert.deepEqual(targets, [4, 5]);
	assert.equal(nameInput(screen).value, "Changed elsewhere");
});

test("Resolution Matrix is hidden until the editor opens conflict details", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	const details = screen.container.querySelector(
		".resolution-details",
	) as HTMLDetailsElement;
	assert.ok(details);
	assert.equal(details.open, false);
	await act(async () => {
		details.open = true;
	});
	assert.equal(details.open, true);
	assert.ok(screen.container.querySelector(".resolution-matrix"));
});

test("deleting a selected Player removes the editor from the Directory", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await click(screen, "Playerを削除");
	await click(screen, "削除を確定");
	await act(async () =>
		screen.directoryChanged({...directory, players: [secondPlayer]}),
	);
	assert.equal(
		screen.container.querySelector("section[aria-label='プレイヤーを編集']"),
		null,
	);
});
