import assert from "node:assert/strict";
import {after, afterEach, before, test} from "node:test";
import type {Directory, Player} from "@nanahuse/player-manager-protocol";
import reactPlugin from "@vitejs/plugin-react";
import {Window} from "happy-dom";
import React, {act} from "react";
import type {Root} from "react-dom/client";
import {createServer, type ViteDevServer} from "vite";
import {collectMatching} from "../src/extension/matching/collect.ts";
import {
	analyze,
	setAccountPrimary,
	setAccountUsage,
} from "../src/matching/analyze.ts";
import {buildCommitPlan, publicResolution} from "../src/matching/commit.ts";
import type {Resolution} from "../src/matching/model.ts";

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
	getPlayer: (playerId: string) => Player | undefined;
	getSession: (registrationId: string) => any;
	directoryChanged: (value: Directory) => void;
	statusChanged: (value: {ready: boolean; error: string | null}) => void;
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
	initialReady = true,
	initialError: string | null = null,
	options: {
		useRealMatching?: boolean;
		responses?: [string, unknown][];
		directory?: Directory;
	} = {},
): Promise<Screen> {
	const window = testWindow;
	window.happyDOM.setURL(url);
	window.confirm = () => true;
	const baseDirectory = options.directory ?? directory;
	let currentDirectory: Directory = {
		...baseDirectory,
		players: baseDirectory.players.map((entry) =>
			entry.playerId === editedPlayer.playerId ? editedPlayer : entry,
		),
	};
	const players = new Map(
		currentDirectory.players.map((player) => [player.playerId, player]),
	);
	const calls: Call[] = [];
	const responses = new Map<string, unknown[]>();
	for (const [operation, response] of options.responses ?? [])
		responses.set(operation, [...(responses.get(operation) ?? []), response]);
	const statusListeners: Array<
		(value: {ready: boolean; error: string | null}) => void
	> = [];
	const directoryListeners: Array<(value: Directory) => void> = [];
	let sessionCounter = 0;
	const sessions = new Map<string, any>();
	const domainResolutions = new Map<string, Resolution>();
	const resolveSession = async (session: any, input: any) => {
		if (options.useRealMatching) {
			const previous = domainResolutions.get(session.registrationId);
			const collection = await collectMatching({
				directory: currentDirectory,
				input,
				target: session.target,
				racetime: {
					getUser: async (userId) => ({
						userId,
						name: userId,
						twitchLogin: null,
					}),
					searchUsers: async () => [],
				},
				src: {
					getUser: async (userId) => ({
						userId,
						name: userId,
						twitchLogin: null,
					}),
					searchUsers: async () => ({users: [], hasMore: false}),
				},
			});
			const resolution = analyze(collection, {
				discardedAccountIds: previous?.discardedAccountIds,
				choices: previous?.choices,
				resolvedConflictIds: previous?.conflicts
					.filter((item) => item.status === "resolved")
					.map((item) => item.id),
			});
			domainResolutions.set(session.registrationId, resolution);
			session.input = input;
			session.resolution = publicResolution(resolution);
			return session;
		}
		const discardedAccountIds = session.resolution?.discardedAccountIds ?? [];
		session.input = input;
		session.resolution = resolutionFor(
			players.get(session.target.playerId)!,
			input,
		);
		session.resolution.discardedAccountIds = discardedAccountIds.filter(
			(id: string) =>
				session.resolution.accounts.some((account: any) => account.id === id),
		);
		return session;
	};
	const apiResponse = async (
		operation: string,
		payload: unknown,
	): Promise<unknown> => {
		const value = payload as any;
		if (operation === "get")
			return {ok: true, data: players.get(value.playerId) ?? null};
		if (operation === "getUser")
			return {
				ok: true,
				data: {
					userId: value.userId,
					name: value.userId,
					weblink: `https://www.speedrun.com/users/${encodeURIComponent(value.userId)}`,
				},
			};
		if (operation === "getAccountProfileUrl") {
			const account = [...players.values()]
				.flatMap((player) => player.accounts ?? [])
				.find((entry) => entry.id === value.accountId);
			if (!account)
				return {
					ok: false,
					error: {code: "account_not_found", message: "Account not found"},
				};
			const identity = account.identity;
			const userId =
				identity && typeof identity === "object" && "userId" in identity
					? identity.userId
					: null;
			const login =
				identity && typeof identity === "object" && "login" in identity
					? identity.login
					: null;
			const url =
				account.service === "speedrunCom" && userId
					? `https://www.speedrun.com/users/${encodeURIComponent(userId)}`
					: account.service === "racetime" && userId
						? `https://racetime.gg/user/${encodeURIComponent(userId)}`
						: account.service === "twitch" && login
							? `https://www.twitch.tv/${login}`
							: account.service === "youtube" && typeof identity === "string"
								? identity
								: (account.profileUrl ?? null);
			return url
				? {ok: true, data: {url}}
				: {
						ok: false,
						error: {
							code: "lookup_failed",
							message: "No profile URL for this account",
						},
					};
		}
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
					await resolveSession(sessions.get(value.registrationId), value.input),
				),
			};
		if (operation === "setRegistrationAccountPrimary") {
			const session = sessions.get(value.registrationId);
			if (options.useRealMatching) {
				const next = setAccountPrimary(
					domainResolutions.get(value.registrationId)!,
					value.accountId,
				);
				domainResolutions.set(value.registrationId, next);
				session.resolution = publicResolution(next);
				return {ok: true, data: structuredClone(session)};
			}
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
			if (options.useRealMatching) {
				const next = setAccountUsage(
					domainResolutions.get(value.registrationId)!,
					value.accountId,
					value.use,
				);
				domainResolutions.set(value.registrationId, next);
				session.resolution = publicResolution(next);
				return {ok: true, data: structuredClone(session)};
			}
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
			if (options.useRealMatching) {
				const plan = buildCommitPlan(
					domainResolutions.get(value.registrationId)!,
				);
				const update = plan.updates.find(
					(entry) => entry.playerId === before.playerId,
				);
				const updated = update
					? {...before, ...update.input, revision: before.revision + 1}
					: before;
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
		if (operation === "initializeDirectory")
			return {
				ok: true,
				data: {schemaVersion: 2, revision: 0, players: []},
			};
		throw new Error(`Unexpected API operation: ${operation}`);
	};
	Object.assign(globalThis, {
		nodecg: {
			Replicant: (name: string) => ({
				on: (_event: string, callback: (value: unknown) => void) => {
					if (name === "player-directory-status") {
						statusListeners.push(
							callback as (value: {
								ready: boolean;
								error: string | null;
							}) => void,
						);
						callback({ready: initialReady, error: initialError});
					} else {
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
		getPlayer: (playerId) => players.get(playerId),
		getSession: (registrationId) => sessions.get(registrationId),
		directoryChanged: (value) => {
			currentDirectory = value;
			for (const player of value.players) players.set(player.playerId, player);
			directoryListeners.forEach((listener) => {
				listener(value);
			});
		},
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
	const profileLink = screen.container.querySelector(
		".account-service a[href='https://github.com/runner']",
	) as HTMLAnchorElement | null;
	assert.ok(profileLink);
	assert.equal(profileLink.target, "_blank");
	assert.equal(profileLink.rel, "noopener noreferrer");
	assert.match(screen.container.textContent ?? "", /Primary/);
	assert.equal(screen.container.querySelector("a[href*='Registration']"), null);
	assert.deepEqual(
		screen.calls.find((call) => call.operation === "beginRegistration")
			?.payload,
		{input: {}, target: {playerId: "player-a", expectedRevision: 4}},
	);
});

test("registration retry discards cancelled, expired, completed, and mismatched Sessions", async () => {
	const invalidSessions = [
		{
			registrationId: "stale",
			state: "cancelled",
			target: {playerId: "player-a", expectedRevision: 4},
		},
		{
			registrationId: "registration-1",
			state: "expired",
			target: {playerId: "player-a", expectedRevision: 4},
		},
		{
			registrationId: "registration-1",
			state: "completed",
			target: {playerId: "player-a", expectedRevision: 4},
		},
		{
			registrationId: "registration-1",
			state: "pending",
			target: {playerId: "player-b", expectedRevision: 4},
		},
		{
			registrationId: "registration-1",
			state: "pending",
			target: {playerId: "player-a", expectedRevision: 3},
		},
	];
	for (const session of invalidSessions) {
		const screen = await mount(
			"http://localhost/dashboard/PlayerMapping.html",
			firstPlayer,
			true,
			null,
			{responses: [["getRegistration", {ok: true, data: session}]]},
		);
		await click(screen, "Runner Aplayer-a");
		await act(async () => Promise.resolve());
		assert.ok(
			[...screen.container.querySelectorAll("button")].some(
				(button) => button.textContent === "再試行",
			),
		);
		await click(screen, "再試行");
		await act(async () => Promise.resolve());
		assert.equal(
			screen.calls.filter((call) => call.operation === "beginRegistration")
				.length,
			2,
		);
		assert.equal(
			screen.calls.filter((call) => call.operation === "cancelRegistration")
				.length,
			1,
		);
	}
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
	assert.equal(
		screen.container.querySelector(".pending-account-requests"),
		null,
	);
	assert.equal(
		[...screen.container.querySelectorAll("button")].some((button) =>
			button.textContent?.includes("追加を取り消す"),
		),
		false,
	);
});

test("Speedrun.com profile links use getAccountProfileUrl for saved accounts", async () => {
	const player: Player = {
		...firstPlayer,
		accounts: [
			{
				id: "src-id",
				service: "speedrunCom",
				role: "primary",
				identity: {userId: "src-id", name: "Runner SRC"},
			},
		],
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		player,
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await act(async () => Promise.resolve());
	assert.equal(
		screen.container.querySelector(
			"a[href='https://www.speedrun.com/users/src-id']",
		)?.textContent,
		"Runner SRC",
	);
	assert.equal(
		screen.calls.filter((call) => call.operation === "getAccountProfileUrl")
			.length,
		1,
	);
});

test("failed saved profile lookup exposes an explicit retry", async () => {
	const player: Player = {
		...firstPlayer,
		accounts: [
			{
				id: "src-retry",
				service: "speedrunCom",
				role: "primary",
				identity: {userId: "src-retry", name: "SRC Retry"},
			},
		],
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		player,
		true,
		null,
		{
			responses: [
				[
					"getAccountProfileUrl",
					{ok: false, error: {code: "lookup_failed", message: "offline"}},
				],
			],
		},
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await act(async () => Promise.resolve());
	assert.ok(
		[...screen.container.querySelectorAll("button")].some(
			(button) => button.textContent === "プロフィールリンクを再試行",
		),
	);
	await click(screen, "プロフィールリンクを再試行");
	await act(async () => Promise.resolve());
	assert.ok(
		screen.container.querySelector(
			"a[href='https://www.speedrun.com/users/src-retry']",
		),
	);
	assert.equal(
		screen.calls.filter((call) => call.operation === "getAccountProfileUrl")
			.length,
		2,
	);
});

test("a retried profile lookup cannot replace the link after selecting another Account", async () => {
	const resolution = resolutionFor(firstPlayer) as Resolution;
	resolution.players.push({
		id: "player-b",
		kind: "existing",
		player: secondPlayer,
		assignedAccountIds: ["account-a", "account-b"],
	});
	resolution.accounts = [
		{
			id: "account-a",
			service: "speedrunCom",
			keys: ["speedrunCom:account-a"],
			profile: {userId: "account-a", name: "Account A"},
		},
		{
			id: "account-b",
			service: "speedrunCom",
			keys: ["speedrunCom:account-b"],
			profile: {userId: "account-b", name: "Account B"},
		},
	];
	resolution.assignments = [
		{
			accountId: "account-a",
			ownerId: "player-b",
			role: "primary",
			source: "user",
		},
		{
			accountId: "account-b",
			ownerId: "player-b",
			role: "secondary",
			source: "user",
		},
	];
	const session = {
		registrationId: "registration-1",
		state: "pending",
		input: {},
		target: {playerId: "player-a", expectedRevision: 4},
		requiredAccounts: [],
		resolution,
		result: null,
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		firstPlayer,
		true,
		null,
		{
			responses: [
				["getRegistration", {ok: true, data: session}],
				[
					"getUser",
					{ok: false, error: {code: "lookup_failed", message: "offline"}},
				],
			],
		},
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	const details = screen.container.querySelector(
		".resolution-details",
	) as HTMLDetailsElement;
	await act(async () => {
		details.open = true;
	});
	const accountA = [...screen.container.querySelectorAll(".account-chip")].find(
		(chip) => chip.textContent?.includes("account-a"),
	) as HTMLButtonElement;
	await act(async () =>
		(accountA.querySelector(".chip-select") as HTMLButtonElement).click(),
	);
	await act(async () => Promise.resolve());
	const finishLookup = screen.deferNext("getUser");
	await click(screen, "プロフィールリンクを再試行");
	const accountB = [...screen.container.querySelectorAll(".account-chip")].find(
		(chip) => chip.textContent?.includes("account-b"),
	) as HTMLButtonElement;
	await act(async () =>
		(accountB.querySelector(".chip-select") as HTMLButtonElement).click(),
	);
	await act(async () => Promise.resolve());
	assert.ok(
		screen.container.querySelector(
			".account-detail a[href='https://www.speedrun.com/users/account-b']",
		),
	);
	await act(async () => {
		finishLookup({
			ok: true,
			data: {weblink: "https://www.speedrun.com/users/account-a"},
		});
		await Promise.resolve();
	});
	assert.ok(
		screen.container.querySelector(
			".account-detail a[href='https://www.speedrun.com/users/account-b']",
		),
	);
	assert.equal(
		screen.container.querySelector(
			".account-detail a[href='https://www.speedrun.com/users/account-a']",
		),
		null,
	);
});

test("excluded Accounts keep their profile links and restore operation", async () => {
	const player: Player = {
		...firstPlayer,
		accounts: [
			{
				id: "gh-one",
				service: "github.com",
				role: "primary",
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
	await click(screen, "使用しない");
	assert.ok(
		screen.container.querySelector(
			".unused-accounts a[href='https://github.com/runner']",
		),
	);
	await click(screen, "復元");
	assert.ok(
		screen.container.querySelector(
			".account-service a[href='https://github.com/runner']",
		),
	);
});

test("the unused account list also resolves through getAccountProfileUrl", async () => {
	const player: Player = {
		...firstPlayer,
		accounts: [
			{
				id: "gh-one",
				service: "github.com",
				role: "primary",
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
	await click(screen, "使用しない");
	await act(async () => Promise.resolve());
	assert.equal(
		screen.container.querySelector(".unused-accounts a")?.textContent,
		"https://github.com/runner",
	);
	assert.ok(
		screen.calls.some(
			(call) =>
				call.operation === "getAccountProfileUrl" &&
				(call.payload as {accountId: string}).accountId === "gh-one",
		),
	);
});

test("a saved account assigned from another Player uses getAccountProfileUrl", async () => {
	const bob: Player = {
		...secondPlayer,
		accounts: [
			{
				id: "gh-bob",
				service: "github.com",
				role: "primary",
				profileUrl: "https://github.com/bob",
				identity: "https://github.com/bob",
			},
		],
	};
	const baseDirectory: Directory = {...directory, players: [firstPlayer, bob]};
	const resolution = resolutionFor(firstPlayer) as any;
	resolution.accounts = [
		{
			id: "gh-bob",
			service: "github.com",
			keys: ["url:github.com:https://github.com/bob"],
			profile: {name: "Bob"},
		},
	];
	resolution.players[0].assignedAccountIds = ["gh-bob"];
	resolution.assignments = [
		{
			accountId: "gh-bob",
			ownerId: "player-a",
			role: "primary",
			source: "user",
		},
	];
	const session = {
		registrationId: "registration-1",
		state: "pending",
		input: {},
		target: {playerId: "player-a", expectedRevision: 4},
		requiredAccounts: [],
		resolution,
		result: null,
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		firstPlayer,
		true,
		null,
		{
			directory: baseDirectory,
			responses: [["getRegistration", {ok: true, data: session}]],
		},
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await act(async () => Promise.resolve());
	assert.ok(
		screen.container.querySelector(
			".account-service a[href='https://github.com/bob']",
		),
	);
	assert.ok(
		screen.calls.some(
			(call) =>
				call.operation === "getAccountProfileUrl" &&
				(call.payload as {accountId: string}).accountId === "gh-bob",
		),
	);
});

test("an unsaved discovered account keeps the legacy profile lookup", async () => {
	const resolution = resolutionFor(firstPlayer) as any;
	resolution.accounts = [
		{
			id: "speedrunCom:src-new",
			service: "speedrunCom",
			keys: ["speedrunCom:src-new"],
			profile: {userId: "src-new", name: "New Runner"},
		},
	];
	resolution.players[0].assignedAccountIds = ["speedrunCom:src-new"];
	resolution.assignments = [
		{
			accountId: "speedrunCom:src-new",
			ownerId: "player-a",
			role: "primary",
			source: "new",
		},
	];
	const session = {
		registrationId: "registration-1",
		state: "pending",
		input: {},
		target: {playerId: "player-a", expectedRevision: 4},
		requiredAccounts: [],
		resolution,
		result: null,
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		firstPlayer,
		true,
		null,
		{responses: [["getRegistration", {ok: true, data: session}]]},
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await act(async () => Promise.resolve());
	assert.ok(
		screen.container.querySelector(
			"a[href='https://www.speedrun.com/users/src-new']",
		),
	);
	assert.ok(screen.calls.some((call) => call.operation === "getUser"));
	assert.equal(
		screen.calls.filter((call) => call.operation === "getAccountProfileUrl")
			.length,
		0,
	);
});

test("a saved profile link refreshes its URL before it is used", async () => {
	const player: Player = {
		...firstPlayer,
		accounts: [
			{
				id: "gh-one",
				service: "github.com",
				role: "primary",
				profileUrl: "https://github.com/old",
				identity: "https://github.com/old",
			},
		],
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		player,
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await act(async () => Promise.resolve());
	const link = screen.container.querySelector(
		".account-service a[href='https://github.com/old']",
	) as HTMLAnchorElement;
	assert.ok(link);
	screen.respondNext("getAccountProfileUrl", {
		ok: true,
		data: {url: "https://github.com/new"},
	});
	await act(async () => {
		link.dispatchEvent(new screen.window.Event("focusin", {bubbles: true}));
		await Promise.resolve();
	});
	await act(async () => Promise.resolve());
	assert.ok(
		screen.container.querySelector(
			".account-service a[href='https://github.com/new']",
		),
	);
	assert.equal(
		screen.calls.filter((call) => call.operation === "getAccountProfileUrl")
			.length,
		2,
	);
});

test("a failed refresh replaces a saved profile link with a retry", async () => {
	const player: Player = {
		...firstPlayer,
		accounts: [
			{
				id: "gh-one",
				service: "github.com",
				role: "primary",
				profileUrl: "https://github.com/old",
				identity: "https://github.com/old",
			},
		],
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		player,
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await act(async () => Promise.resolve());
	assert.ok(
		screen.container.querySelector(
			".account-service a[href='https://github.com/old']",
		),
	);
	screen.respondNext("getAccountProfileUrl", {
		ok: false,
		error: {code: "lookup_failed", message: "offline"},
	});
	const link = screen.container.querySelector(
		".account-service a",
	) as HTMLAnchorElement;
	await act(async () => {
		link.dispatchEvent(new screen.window.Event("focusin", {bubbles: true}));
		await Promise.resolve();
	});
	await act(async () => Promise.resolve());
	assert.equal(
		screen.container.querySelector(".account-service a"),
		null,
		"the stale link is discarded",
	);
	assert.ok(
		[...screen.container.querySelectorAll("button")].some(
			(entry) => entry.textContent === "プロフィールリンクを再試行",
		),
	);
});

test("an unsaved SRC account keeps its stored weblink instead of re-querying", async () => {
	const resolution = resolutionFor(firstPlayer) as any;
	resolution.accounts = [
		{
			id: "speedrunCom:src-known",
			service: "speedrunCom",
			keys: ["speedrunCom:src-known"],
			profile: {
				userId: "src-known",
				name: "Known",
				weblink: "https://www.speedrun.com/users/Known",
			},
		},
	];
	resolution.players[0].assignedAccountIds = ["speedrunCom:src-known"];
	resolution.assignments = [
		{
			accountId: "speedrunCom:src-known",
			ownerId: "player-a",
			role: "primary",
			source: "new",
		},
	];
	const session = {
		registrationId: "registration-1",
		state: "pending",
		input: {},
		target: {playerId: "player-a", expectedRevision: 4},
		requiredAccounts: [],
		resolution,
		result: null,
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		firstPlayer,
		true,
		null,
		{responses: [["getRegistration", {ok: true, data: session}]]},
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await act(async () => Promise.resolve());
	assert.ok(
		screen.container.querySelector(
			"a[href='https://www.speedrun.com/users/Known']",
		),
	);
	assert.equal(
		screen.calls.filter((call) => call.operation === "getUser").length,
		0,
	);
});

test("profile links appear in Matrix, conflict, candidate, and merge review without changing decisions", async () => {
	const player: Player = {
		...firstPlayer,
		accounts: [
			{
				id: "gh-runner",
				service: "github.com",
				role: "primary",
				profileUrl: "https://github.com/runner",
				identity: "https://github.com/runner",
			},
			{
				id: "src-runner",
				service: "speedrunCom",
				role: "secondary",
				identity: {userId: "src-runner", name: "SRC Runner"},
			},
		],
	};
	const resolution = resolutionFor(player) as any;
	const github = resolution.accounts.find(
		(account: any) => account.id === "gh-runner",
	)!;
	const src = resolution.accounts.find(
		(account: any) => account.id === "src-runner",
	)!;
	resolution.evidence = [
		{id: "ev-conflict", source: "input", accounts: [github.id, src.id]},
	];
	resolution.conflicts = [
		{
			id: "conflict",
			evidenceId: "ev-conflict",
			ownerIds: ["player-a", "player-b"],
			status: "conflict",
		},
	];
	resolution.candidates = [
		{
			id: "candidate",
			service: "speedrunCom",
			profile: {
				userId: "candidate-user",
				name: "Candidate",
				weblink: "https://www.speedrun.com/users/candidate-user",
			},
			query: "runner",
			originAccountId: src.id,
		},
	];
	resolution.players.push({
		id: "player-b",
		kind: "existing",
		player: secondPlayer,
		assignedAccountIds: ["tw-b"],
	});
	resolution.accounts.push({
		id: "tw-b",
		service: "twitch",
		keys: ["twitch:runnerb"],
		profile: {name: "runnerb"},
	});
	resolution.assignments.push({
		accountId: "tw-b",
		ownerId: "player-b",
		role: "primary",
		source: "user",
	});
	resolution.mergeProposal = {
		playerIds: ["player-a", "player-b"],
		accountIds: [github.id, "tw-b"],
		reason: "test",
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		player,
		true,
		null,
		{
			responses: [
				[
					"getRegistration",
					{
						ok: true,
						data: {
							registrationId: "registration-1",
							state: "pending",
							input: {},
							target: {playerId: "player-a", expectedRevision: 4},
							requiredAccounts: [],
							resolution,
							result: null,
						},
					},
				],
			],
		},
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	const details = screen.container.querySelector(
		".resolution-details",
	) as HTMLDetailsElement;
	assert.ok(details, screen.container.textContent);
	await act(async () => {
		details.open = true;
	});
	const chip = [...screen.container.querySelectorAll(".account-chip")].find(
		(item) => item.textContent?.includes("github.com"),
	) as HTMLButtonElement;
	await act(async () =>
		(chip.querySelector(".chip-select") as HTMLButtonElement).click(),
	);
	assert.equal(
		screen.container.querySelector(
			".account-detail a[href='https://github.com/runner']",
		)?.textContent,
		"https://github.com/runner",
	);
	assert.ok(
		screen.container.querySelector(
			".conflict-item a[href='https://github.com/runner']",
		),
	);
	assert.ok(
		screen.container.querySelector(
			".candidate-group a[href='https://www.speedrun.com/users/candidate-user']",
		),
	);
	assert.ok(
		screen.container.querySelector(
			".candidate-group a[href='https://www.speedrun.com/users/src-runner']",
		),
	);
	assert.ok(screen.container.querySelector("section h2")?.textContent);
	assert.ok(
		[
			...screen.container.querySelectorAll(
				"a[href='https://github.com/runner']",
			),
		].some(
			(link) =>
				link.closest("section")?.querySelector("h2")?.textContent ===
				"Merge proposal",
		),
	);
	assert.equal(resolution.conflicts[0].status, "conflict");
	assert.equal(resolution.mergeProposal.playerIds.length, 2);
});

test("real matching keeps exclusions through add, restore, and save", async () => {
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		firstPlayer,
		true,
		null,
		{useRealMatching: true},
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await fill(addInput(screen), screen.window, "one");
	await click(screen, "追加");
	let accountRows = [...screen.container.querySelectorAll(".account-row")];
	let first = accountRows.find((row) => row.textContent?.includes("one"));
	assert.ok(first);
	const firstAccountId = /ID: ([^\s·]+)/.exec(first.textContent ?? "")?.[1];
	await act(async () =>
		(first.querySelectorAll("button")[1] as HTMLButtonElement).click(),
	);
	assert.ok(
		screen.container
			.querySelector(".unused-accounts")
			?.textContent?.includes("one"),
	);
	assert.equal(
		[
			...screen.container.querySelectorAll(".account-service .account-row"),
		].some((row) => row.textContent?.includes("one")),
		false,
	);
	await fill(addInput(screen), screen.window, "two");
	await click(screen, "追加");
	assert.ok(
		screen.container
			.querySelector(".unused-accounts")
			?.textContent?.includes("one"),
	);
	assert.equal(
		[
			...screen.container.querySelectorAll(".account-service .account-row"),
		].some((row) => row.textContent?.includes("one")),
		false,
	);
	assert.ok(
		[...screen.container.querySelectorAll(".account-row")].some((row) =>
			row.textContent?.includes("two"),
		),
	);
	await click(screen, "復元");
	accountRows = [...screen.container.querySelectorAll(".account-row")];
	first = accountRows.find((row) => row.textContent?.includes("one"));
	assert.ok(first);
	assert.equal(screen.container.querySelector(".unused-accounts"), null);
	assert.equal(
		/ID: ([^\s·]+)/.exec(first.textContent ?? "")?.[1],
		firstAccountId,
	);
	await click(screen, "変更を保存");
	const saved = screen.getPlayer("player-a")!;
	assert.equal(saved.accounts?.length, 2);
	assert.deepEqual(
		saved.accounts?.map(({identity, role}) => ({
			identity,
			role,
		})),
		[
			{identity: {login: "one"}, role: "primary"},
			{identity: {login: "two"}, role: "secondary"},
		],
	);
	assert.ok(saved.accounts?.every((account) => account.id));
});

test("Registration initialization failures can be retried without leaking Sessions", async () => {
	const failure = {
		ok: false,
		error: {code: "invalid_input", message: "temporary failure"},
	};
	const beginFailure = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		firstPlayer,
		true,
		null,
		{responses: [["beginRegistration", failure]]},
	);
	await click(beginFailure, "Runner Aplayer-a");
	await act(async () => Promise.resolve());
	assert.match(beginFailure.container.textContent ?? "", /temporary failure/);
	assert.equal(
		beginFailure.calls.filter((call) => call.operation === "beginRegistration")
			.length,
		1,
	);
	await click(beginFailure, "再試行");
	await act(async () => Promise.resolve());
	assert.equal(
		beginFailure.calls.filter((call) => call.operation === "beginRegistration")
			.length,
		2,
	);
	assert.equal(button(beginFailure, "変更を保存").disabled, false);

	const getFailure = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		firstPlayer,
		true,
		null,
		{responses: [["getRegistration", failure]]},
	);
	await click(getFailure, "Runner Aplayer-a");
	await act(async () => Promise.resolve());
	assert.equal(
		getFailure.calls.filter((call) => call.operation === "cancelRegistration")
			.length,
		1,
	);
	await click(getFailure, "再試行");
	await act(async () => Promise.resolve());
	assert.equal(
		getFailure.calls.filter((call) => call.operation === "beginRegistration")
			.length,
		2,
	);
	assert.equal(button(getFailure, "変更を保存").disabled, false);
});

test("unsaved Account input and unresolved conflicts disable saving with clear guidance", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await fill(addInput(screen), screen.window, "not added");
	assert.equal(button(screen, "変更を保存").disabled, true);
	assert.match(
		screen.container.textContent ?? "",
		/未追加のAccount入力があります/,
	);
	await fill(addInput(screen), screen.window, "");
	assert.equal(button(screen, "変更を保存").disabled, false);
	await fill(addInput(screen), screen.window, "runner");
	await click(screen, "追加");
	const getRegistrationCall = screen.calls.find(
		(call) => call.operation === "getRegistration",
	);
	assert.ok(getRegistrationCall);
	const registrationId = (getRegistrationCall.payload as any).registrationId;
	const session = screen.getSession(registrationId);
	const accountId = session.resolution.accounts[0].id;
	session.resolution.conflicts = [
		{id: "unresolved", status: "conflict", evidenceId: "e", ownerIds: []},
	];
	screen.respondNext("setRegistrationAccountUsage", {
		ok: true,
		data: structuredClone(session),
	});
	const accountRow = [
		...screen.container.querySelectorAll(".account-row"),
	].find((row) => row.textContent?.includes("runner"))!;
	await act(async () =>
		(accountRow.querySelectorAll("button")[1] as HTMLButtonElement).click(),
	);
	assert.equal(button(screen, "変更を保存").disabled, true);
	assert.match(
		screen.container.textContent ?? "",
		/Accountの所有者競合が未解決/,
	);
	await click(screen, "競合・確認事項を開く");
	assert.equal(
		(
			screen.container.querySelector(
				".resolution-details",
			) as HTMLDetailsElement
		).open,
		true,
	);
	assert.ok(accountId);
});

test("new Accounts use the shared exclusion and restoration controls across additions", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await fill(addInput(screen), screen.window, "one");
	await click(screen, "追加");
	let firstRow = [...screen.container.querySelectorAll(".account-row")].find(
		(row) => row.textContent?.includes("one"),
	)!;
	assert.ok(firstRow);
	assert.equal(
		screen.container.querySelector(".pending-account-requests"),
		null,
	);
	await act(async () =>
		(firstRow.querySelectorAll("button")[1] as HTMLButtonElement).click(),
	);
	assert.ok(
		screen.container
			.querySelector(".unused-accounts")
			?.textContent?.includes("one"),
	);
	await fill(addInput(screen), screen.window, "two");
	await click(screen, "追加");
	assert.ok(
		screen.container
			.querySelector(".unused-accounts")
			?.textContent?.includes("one"),
	);
	assert.ok(
		[...screen.container.querySelectorAll(".account-row")].some((row) =>
			row.textContent?.includes("two"),
		),
	);
	await click(screen, "復元");
	firstRow = [...screen.container.querySelectorAll(".account-row")].find(
		(row) => row.textContent?.includes("one"),
	)!;
	assert.ok(firstRow);
	assert.equal(screen.container.querySelector(".unused-accounts"), null);
	assert.equal(
		screen.calls.filter(
			(call) => call.operation === "setRegistrationAccountUsage",
		).length,
		2,
	);
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

test("failed initial load shows recovery actions and reload restores normal UI", async () => {
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		firstPlayer,
		false,
		"Directory could not be read; existing data was preserved",
	);
	assert.equal(
		screen.container.querySelector("h1")?.textContent,
		"Directoryを復旧",
	);
	assert.ok(
		screen.container.textContent?.includes("Directory could not be read"),
	);
	assert.equal(screen.container.querySelector(".player-editor"), null);
	await click(screen, "再読み込み");
	assert.equal(screen.calls.at(-1)?.operation, "reload");
	assert.equal(
		screen.container.querySelector("h1")?.textContent,
		"Player Directory",
	);
});

test("empty Directory initialization requires confirmation and returns to normal UI", async () => {
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		firstPlayer,
		false,
		"Directory could not be read; existing data was preserved",
	);
	screen.window.confirm = () => false;
	await click(screen, "空のDirectoryを初期化");
	assert.equal(
		screen.calls.some((call) => call.operation === "initializeDirectory"),
		false,
	);
	let confirmation = "";
	screen.window.confirm = (message) => {
		confirmation = message;
		return true;
	};
	await click(screen, "空のDirectoryを初期化");
	assert.match(confirmation, /バックアップ/);
	assert.match(confirmation, /Google Sheets は変更されません/);
	assert.deepEqual(
		screen.calls.find((call) => call.operation === "initializeDirectory")
			?.payload,
		{confirm: true},
	);
	assert.equal(
		screen.container.querySelector("h1")?.textContent,
		"Player Directory",
	);
	const directoryStatus = screen.container.querySelector(
		"[aria-label='Directoryの状態']",
	);
	assert.ok(directoryStatus?.textContent?.includes("PLAYERS0"));
	assert.ok(directoryStatus?.textContent?.includes("DIRECTORYReady"));
});

test("tabs confirm discarding editor and settings drafts and keep rejected changes", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	assert.equal(screen.container.querySelector(".storage-settings"), null);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	await fill(nameInput(screen), screen.window, "Unsaved name");
	screen.window.confirm = () => false;
	await click(screen, "Settings");
	assert.equal(nameInput(screen).value, "Unsaved name");
	assert.equal(screen.container.querySelector(".storage-settings"), null);
	screen.window.confirm = () => true;
	await click(screen, "Settings");
	assert.ok(screen.container.querySelector(".storage-settings"));
	assert.equal(screen.container.querySelector(".player-editor"), null);
	assert.ok(
		screen.calls.some((call) => call.operation === "cancelRegistration"),
	);
	const settingsInput = screen.container.querySelector(
		".storage-settings input",
	) as HTMLInputElement;
	await fill(settingsInput, screen.window, "unsaved-sheet");
	screen.window.confirm = () => false;
	await click(screen, "Players");
	assert.equal(settingsInput.value, "unsaved-sheet");
	assert.ok(screen.container.querySelector(".storage-settings"));
	screen.window.confirm = () => true;
	await click(screen, "Players");
	await act(async () => Promise.resolve());
	assert.equal(nameInput(screen).value, "Runner A");
});

test("tabs cannot switch while editor or settings operations are pending", async () => {
	const screen = await mount("http://localhost/dashboard/PlayerMapping.html");
	const finish = screen.deferNext("beginRegistration");
	await click(screen, "Runner Aplayer-a");
	assert.equal(button(screen, "Settings").disabled, true);
	await click(screen, "Settings");
	assert.equal(screen.container.querySelector(".storage-settings"), null);
	await act(async () => finish({ok: true, data: {registrationId: "delayed"}}));
	await click(screen, "Settings");
	const finishSettings = screen.deferNext("configureStorage");
	await click(screen, "ローカル保存を使用");
	assert.equal(button(screen, "Players").disabled, true);
	await act(async () =>
		finishSettings({ok: true, data: {message: "configured"}}),
	);
	assert.equal(button(screen, "Players").disabled, false);
});

test("editor hides evidence while retaining account IDs, states, and independent Matrix links", async () => {
	const player: Player = {
		...firstPlayer,
		accounts: [
			{
				id: "tw-ui",
				service: "twitch",
				role: "primary",
				identity: {login: "runner"},
			},
		],
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		player,
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	assert.doesNotMatch(screen.container.textContent ?? "", /Evidence:/);
	assert.match(screen.container.textContent ?? "", /ID: tw-ui/);
	const chip = screen.container.querySelector(".account-chip")!;
	const link = chip.querySelector("a")!;
	assert.equal(link.textContent, "runner");
	assert.equal(link.closest("button"), null);
	await act(async () =>
		link.dispatchEvent(
			new screen.window.MouseEvent("click", {bubbles: true, cancelable: true}),
		),
	);
	assert.equal(screen.container.querySelector(".account-detail"), null);
	await act(async () =>
		(chip.querySelector(".chip-select") as HTMLButtonElement).click(),
	);
	assert.ok(screen.container.querySelector(".account-detail"));
	assert.doesNotMatch(screen.container.textContent ?? "", /Evidence:/);
	assert.match(screen.container.textContent ?? "", /Primary/);
});

test("saved profile URLs use the account API throughout Matrix and reviews while candidates keep their URLs", async () => {
	const savedUrl = "https://www.speedrun.com/users/current-runner";
	const oldUrl = "https://www.speedrun.com/users/old-runner";
	const candidateUrl = "https://www.speedrun.com/users/candidate";
	const unsavedUrl = "https://www.speedrun.com/users/unsaved";
	const player: Player = {
		...firstPlayer,
		accounts: [
			{
				id: "src-saved",
				service: "speedrunCom",
				role: "primary",
				identity: {userId: "saved-id", name: "Saved Runner"},
			},
		],
	};
	const resolution = resolutionFor(player) as any;
	resolution.accounts[0].profile.weblink = oldUrl;
	resolution.accounts.push({
		id: "src-unsaved",
		service: "speedrunCom",
		keys: ["speedrunCom:unsaved"],
		profile: {userId: "unsaved", name: "Unsaved Runner", weblink: unsavedUrl},
	});
	resolution.assignments.push({
		accountId: "src-unsaved",
		ownerId: "player-a",
		role: "secondary",
		source: "user",
	});
	resolution.players.push({
		id: "player-b",
		kind: "existing",
		player: secondPlayer,
		assignedAccountIds: [],
	});
	resolution.evidence = [
		{id: "saved-evidence", source: "input", accounts: ["src-saved"]},
	];
	resolution.conflicts = [
		{
			id: "saved-conflict",
			evidenceId: "saved-evidence",
			ownerIds: ["player-a", "player-b"],
			status: "conflict",
		},
	];
	resolution.candidates = [
		{
			id: "candidate",
			service: "speedrunCom",
			profile: {
				userId: "candidate",
				name: "Candidate Runner",
				weblink: candidateUrl,
			},
			query: "runner",
			originAccountId: "src-saved",
		},
	];
	resolution.mergeProposal = {
		playerIds: ["player-a", "player-b"],
		accountIds: ["src-saved"],
		reason: "test",
	};
	const screen = await mount(
		"http://localhost/dashboard/PlayerMapping.html",
		player,
		true,
		null,
		{
			responses: [
				[
					"getRegistration",
					{
						ok: true,
						data: {
							registrationId: "registration-1",
							state: "pending",
							input: {},
							target: {playerId: "player-a", expectedRevision: 4},
							requiredAccounts: [],
							resolution,
							result: null,
						},
					},
				],
				["getAccountProfileUrl", {ok: true, data: {url: savedUrl}}],
			],
		},
	);
	await click(screen, "Runner Aplayer-a");
	await waitForSession(screen);
	for (const selector of [
		".account-service",
		".account-chip",
		".conflict-item",
		".candidate-group h3",
	]) {
		assert.ok(
			screen.container.querySelector(`${selector} a[href='${savedUrl}']`),
			selector,
		);
	}
	const merge = [...screen.container.querySelectorAll("section")].find(
		(section) => section.querySelector("h2")?.textContent === "Merge proposal",
	)!;
	assert.ok(merge.querySelector(`a[href='${savedUrl}']`));
	assert.ok(
		screen.container.querySelector(
			`.candidate-group a[href='${candidateUrl}']`,
		),
	);
	assert.ok(
		screen.container.querySelector(`.account-chip a[href='${unsavedUrl}']`),
	);
	assert.equal(screen.container.querySelector(`a[href='${oldUrl}']`), null);
	const savedChip = [
		...screen.container.querySelectorAll(".account-chip"),
	].find((chip) => chip.textContent?.includes("Saved Runner"))!;
	screen.respondNext("getAccountProfileUrl", {ok: true, data: {url: savedUrl}});
	await act(async () =>
		(savedChip.querySelector(".chip-select") as HTMLButtonElement).click(),
	);
	assert.ok(
		screen.container.querySelector(`.account-detail a[href='${savedUrl}']`),
	);
	const refreshedUrl = "https://www.speedrun.com/users/renamed-again";
	screen.respondNext("getAccountProfileUrl", {
		ok: true,
		data: {url: refreshedUrl},
	});
	await act(async () =>
		savedChip
			.querySelector("a")!
			.dispatchEvent(new screen.window.Event("focusin", {bubbles: true})),
	);
	assert.ok(savedChip.querySelector(`a[href='${refreshedUrl}']`));
	assert.equal(
		savedChip.querySelector(".chip-select")?.getAttribute("aria-pressed"),
		"true",
	);
	assert.ok(
		screen.calls
			.filter((call) => call.operation === "getAccountProfileUrl")
			.every(
				(call) =>
					(call.payload as {accountId: string}).accountId === "src-saved",
			),
	);
	assert.equal(
		screen.calls.some((call) => call.operation === "getUser"),
		false,
	);
});
