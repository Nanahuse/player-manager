import type {
	AccountIdentity,
	Directory,
	DirectoryAccount,
	FailureCode,
	IdentityInput,
	Player,
	PlayerInput,
	ProviderIdentity,
	StoredPlayerInput,
} from "@nanahuse/player-manager-protocol";

export class DirectoryError extends Error {
	constructor(
		public code: FailureCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DirectoryError("invalid_input", "Object required");
	return value as Record<string, unknown>;
}
export function text(value: unknown, field: string, max = 200): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > max)
		throw new DirectoryError(
			"invalid_input",
			`${field}: non-empty string required (max ${max})`,
		);
	return value.trim();
}

function profileReference(
	value: unknown,
	service: "twitch" | "speedrun",
): string {
	const raw = text(value, service + " account", 2048);
	const host = service === "twitch" ? "twitch.tv" : "speedrun.com";
	const candidate = /^(?:www\.)?(?:twitch\.tv|speedrun\.com)\//i.test(raw)
		? "https://" + raw
		: raw;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return raw;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new DirectoryError("invalid_input", "Invalid profile URL");
	}
	if (
		!["https:", "http:"].includes(url.protocol) ||
		![host, "www." + host].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.port
	)
		throw new DirectoryError("invalid_input", "Use a " + host + " profile URL");
	const match = (
		service === "twitch" ? /^\/([a-zA-Z0-9_]+)\/?$/ : /^\/users?\/([^/]+)\/?$/
	).exec(url.pathname);
	if (!match)
		throw new DirectoryError(
			"invalid_input",
			"Invalid " + service + " profile URL",
		);
	try {
		return decodeURIComponent(match[1]!);
	} catch {
		throw new DirectoryError("invalid_input", "Invalid profile URL encoding");
	}
}
export function speedrunReference(value: unknown): string {
	const result = profileReference(value, "speedrun");
	if (
		!/^[a-zA-Z0-9_.-]{1,100}$/.test(result) ||
		result === "." ||
		result === ".."
	)
		throw new DirectoryError(
			"invalid_input",
			"Invalid Speedrun.com user ID or username",
		);
	return result;
}

export function login(value: unknown): string {
	const result = text(
		profileReference(value, "twitch"),
		"Twitch login",
		25,
	).toLowerCase();
	if (!/^[a-z0-9_]+$/.test(result))
		throw new DirectoryError("invalid_input", "Invalid Twitch login");
	return result;
}
function optionalText(value: unknown, field: string): string | null {
	return value == null ? null : text(value, field);
}
function provider(value: unknown): ProviderIdentity | null {
	if (value == null) return null;
	const v = object(value);
	return {
		...displayNameField(v["twitchDisplayName"], "twitchDisplayName"),
		...(speedrunWeblink(v["weblink"])
			? {weblink: speedrunWeblink(v["weblink"])!}
			: {}),
		...(v["youtube"] == null ? {} : {youtube: youtubeUrl(v["youtube"])}),
		userId: text(v["userId"], "userId"),
		name: text(v["name"], "name"),
		twitchLogin: v["twitchLogin"] == null ? null : login(v["twitchLogin"]),
	};
}
export function normalize(value: unknown): PlayerInput {
	const v = object(value);
	const tw = v["twitch"] == null ? null : object(v["twitch"]);
	const result: PlayerInput = {
		...(v["youtube"] == null || v["youtube"] === ""
			? {}
			: {youtube: youtubeUrl(v["youtube"])}),
		manualDisplayName: optionalText(v["manualDisplayName"], "display name"),
		racetime: provider(v["racetime"]),
		speedrunCom: provider(v["speedrunCom"]),
		twitch: tw
			? {
					...displayNameField(tw["displayName"], "displayName"),
					login: login(tw["login"]),
				}
			: null,
	};
	return result;
}
export function identityKeys(p: IdentityInput): string[] {
	const directoryAccounts = (p as PlayerInput).accounts ?? [];
	return [
		...new Set(
			[
				...directoryAccounts.flatMap(directoryAccountIdentityKeys),
				p.youtube && `youtube:${p.youtube}`,
				p.racetime?.youtube && `youtube:${p.racetime.youtube}`,
				p.speedrunCom?.youtube && `youtube:${p.speedrunCom.youtube}`,
				p.racetime && `racetime:${p.racetime.userId}`,
				p.speedrunCom && `speedrunCom:${p.speedrunCom.userId}`,
				p.twitch && `twitch:${p.twitch.login}`,
				p.racetime?.twitchLogin && `twitch:${p.racetime.twitchLogin}`,
				p.speedrunCom?.twitchLogin && `twitch:${p.speedrunCom.twitchLogin}`,
			].filter(
				(key): key is string => typeof key === "string" && key.length > 0,
			),
		),
	];
}

export function primaryIdentityKeys(p: IdentityInput): string[] {
	const accounts = (p as PlayerInput).accounts;
	if (!accounts) return identityKeys(p);
	return [
		...new Set(
			accounts
				.filter((account) => account.role === "primary")
				.flatMap(directoryAccountIdentityKeys),
		),
	];
}

export function directoryAccountIdentityKeys(
	account: DirectoryAccount,
): string[] {
	if (account.service === "racetime" || account.service === "speedrunCom") {
		const identity = account.identity as AccountIdentity;
		return typeof identity === "string" || !identity.userId
			? []
			: [`${account.service}:${identity.userId}`];
	}
	if (account.service === "twitch") {
		if (typeof account.identity === "string")
			return [`twitch:${login(account.identity)}`];
		const twitch = account.identity as {login?: string};
		return twitch.login ? [`twitch:${login(twitch.login)}`] : [];
	}
	if (account.service === "youtube")
		return typeof account.identity === "string"
			? [`youtube:${youtubeUrl(account.identity)}`]
			: [];
	return account.profileUrl
		? [`url:${account.service}:${account.profileUrl}`]
		: [];
}
export function assertUnique(players: Player[]): void {
	const owners = new Map<string, string>();
	for (const p of players) {
		const perPlayer: {service: string; keys: string[]}[] = [];
		for (const account of p.accounts ?? []) {
			const keys = directoryAccountIdentityKeys(account);
			if (
				perPlayer.some(
					(prior) =>
						prior.service === account.service &&
						prior.keys.some((key) => keys.includes(key)),
				)
			)
				throw new DirectoryError(
					"identity_conflict",
					`${account.service} account is duplicated within ${p.playerId}`,
				);
			perPlayer.push({service: account.service, keys});
		}
		for (const key of identityKeys(p)) {
			const owner = owners.get(key);
			if (owner && owner !== p.playerId)
				throw new DirectoryError(
					"identity_conflict",
					`${key} is already linked to ${owner}`,
				);
			owners.set(key, p.playerId);
		}
	}
}
export function integer(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new DirectoryError("invalid_input", "Non-negative revision required");
	return value as number;
}
export function validateDirectory(value: unknown): Directory {
	const v = object(value);
	if (
		(v["schemaVersion"] !== 1 && v["schemaVersion"] !== 2) ||
		!Array.isArray(v["players"])
	)
		throw new DirectoryError("invalid_input", "Unsupported directory format");
	const players = v["players"].map((raw: unknown) => {
		const p = object(raw);
		return {
			...compactPlayer(p),
			playerId: text(p["playerId"], "playerId"),
			revision: integer(p["revision"]),
		};
	});
	if (new Set(players.map((p) => p.playerId)).size !== players.length)
		throw new DirectoryError("invalid_input", "Duplicate playerId");
	const accountIds = new Set<string>();
	for (const player of players)
		for (const account of player.accounts ?? []) {
			if (accountIds.has(account.id))
				throw new DirectoryError(
					"identity_conflict",
					`Account ID ${account.id} is assigned more than once`,
				);
			accountIds.add(account.id);
		}
	assertUnique(players);
	return {schemaVersion: 2, revision: integer(v["revision"]), players};
}

function displayNameField(value: unknown, key: string): Record<string, string> {
	if (value == null || value === "") return {};
	return {[key]: text(value, "Twitch display name")};
}

export function youtubeUrl(value: unknown): string {
	const raw = text(value, "YouTube channel URL", 2048);
	const candidate = raw.startsWith("@")
		? "https://www.youtube.com/" + raw
		: /^(?:www\.|m\.)?youtube\.com\//i.test(raw)
			? "https://" + raw
			: raw;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new DirectoryError(
			"invalid_input",
			"Enter a YouTube channel URL or @handle",
		);
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(
			url.hostname,
		) ||
		url.username ||
		url.password ||
		url.port
	)
		throw new DirectoryError("invalid_input", "Use a youtube.com channel URL");
	let path: string;
	try {
		path = decodeURIComponent(url.pathname).normalize("NFC").replace(/\/$/, "");
	} catch {
		throw new DirectoryError("invalid_input", "Invalid YouTube URL encoding");
	}
	if (/^\/channel\/UC[a-zA-Z0-9_-]{22}$/.test(path))
		return "https://www.youtube.com" + path;
	if (/^\/@[\p{L}\p{N}\p{M}._-]+$/u.test(path))
		return "https://www.youtube.com" + path.toLowerCase();
	if (/^\/(user|c)\/[a-zA-Z0-9._-]+$/.test(path))
		return "https://www.youtube.com" + path;
	throw new DirectoryError(
		"invalid_input",
		"Use a channel, @handle, /user/ or /c/ profile URL, not a video URL",
	);
}

export function speedrunWeblink(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			!["speedrun.com", "www.speedrun.com"].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.port
		)
			return null;
		speedrunReference(url.href);
		return url.href;
	} catch {
		return null;
	}
}

/** Consolidate provider evidence before discarding its source-specific copies. */
export function compactPlayer(value: unknown): StoredPlayerInput {
	const input = normalize(value);
	const raw = object(value);
	const twitchLogin =
		input.twitch?.login ??
		input.racetime?.twitchLogin ??
		input.speedrunCom?.twitchLogin;
	const displayName =
		input.twitch?.displayName ??
		input.racetime?.twitchDisplayName ??
		input.speedrunCom?.twitchDisplayName;
	const account = (
		p: ProviderIdentity | null,
		includeWeblink = false,
	): AccountIdentity | null =>
		p
			? {
					userId: p.userId,
					name: p.name,
					...(includeWeblink && p.weblink ? {weblink: p.weblink} : {}),
				}
			: null;
	const legacy: StoredPlayerInput = {
		manualDisplayName: input.manualDisplayName,
		racetime: account(input.racetime),
		speedrunCom: account(input.speedrunCom, true),
		twitch: twitchLogin
			? {
					login: twitchLogin,
					...(displayName ? {displayName} : {}),
				}
			: null,
		youtube: input.youtube ?? null,
	};
	let accounts = Array.isArray(raw["accounts"])
		? normalizeDirectoryAccounts(raw["accounts"])
		: legacyAccounts(legacy);
	if (!Array.isArray(raw["accounts"])) {
		accounts = accounts.map((account) => {
			const provider =
				account.service === "racetime"
					? input.racetime
					: account.service === "speedrunCom"
						? input.speedrunCom
						: null;
			const evidenceKeys = [
				provider?.twitchLogin ? "twitch:" + login(provider.twitchLogin) : null,
				provider?.youtube ? "youtube:" + youtubeUrl(provider.youtube) : null,
			].filter((key): key is string => Boolean(key));
			return evidenceKeys.length ? {...account, evidenceKeys} : account;
		});
		for (const provider of [input.racetime, input.speedrunCom]) {
			if (provider?.twitchLogin) {
				const value = login(provider.twitchLogin);
				if (
					!accounts.some(
						(account) =>
							account.service === "twitch" &&
							directoryAccountIdentityKeys(account).includes("twitch:" + value),
					)
				)
					accounts.push({
						id: "twitch:" + value,
						service: "twitch",
						role: accounts.some((account) => account.service === "twitch")
							? "secondary"
							: "primary",
						identity: {login: value},
					});
			}
			if (provider?.youtube) {
				const value = youtubeUrl(provider.youtube);
				if (
					!accounts.some(
						(account) =>
							account.service === "youtube" &&
							directoryAccountIdentityKeys(account).includes(
								"youtube:" + value,
							),
					)
				)
					accounts.push({
						id: "youtube:" + value,
						service: "youtube",
						role: accounts.some((account) => account.service === "youtube")
							? "secondary"
							: "primary",
						identity: value,
					});
			}
		}
	}
	const primaryByService = new Map(
		accounts
			.filter((account) => account.role === "primary")
			.map((account) => [account.service, account]),
	);
	const primaryIdentity = (service: string) =>
		primaryByService.get(service)?.identity;
	const racetime = primaryIdentity("racetime") as AccountIdentity | undefined;
	const speedrunCom = primaryIdentity("speedrunCom") as
		| AccountIdentity
		| undefined;
	const twitch = primaryIdentity("twitch") as
		| import("@nanahuse/player-manager-protocol").TwitchIdentity
		| undefined;
	const youtube = primaryIdentity("youtube") as string | undefined;
	return {
		manualDisplayName: legacy.manualDisplayName,
		racetime: racetime ? {userId: racetime.userId, name: racetime.name} : null,
		speedrunCom: speedrunCom
			? {
					userId: speedrunCom.userId,
					name: speedrunCom.name,
					...(speedrunCom.weblink ? {weblink: speedrunCom.weblink} : {}),
				}
			: null,
		twitch: twitch
			? {
					login: twitch.login,
					...(twitch.displayName ? {displayName: twitch.displayName} : {}),
				}
			: null,
		youtube: youtube ?? null,
		accounts,
	};
}

function legacyAccounts(player: StoredPlayerInput): DirectoryAccount[] {
	const accounts: DirectoryAccount[] = [];
	if (player.racetime)
		accounts.push({
			id: directoryAccountId("racetime", player.racetime.userId),
			service: "racetime",
			role: "primary",
			identity: player.racetime,
		});
	if (player.speedrunCom)
		accounts.push({
			id: directoryAccountId("speedrunCom", player.speedrunCom.userId),
			service: "speedrunCom",
			role: "primary",
			identity: player.speedrunCom,
		});
	if (player.twitch)
		accounts.push({
			id: directoryAccountId("twitch", player.twitch.login),
			service: "twitch",
			role: "primary",
			identity: player.twitch,
		});
	if (player.youtube)
		accounts.push({
			id: directoryAccountId("youtube", player.youtube),
			service: "youtube",
			role: "primary",
			identity: player.youtube,
		});
	return accounts;
}

export function directoryAccountId(service: string, identity: string): string {
	return `account:${service}:${encodeURIComponent(identity)}`;
}

function normalizeDirectoryAccounts(value: unknown[]): DirectoryAccount[] {
	const accounts = value.map((raw) => {
		const account = object(raw);
		const service = text(account["service"], "account service", 200);
		const role = account["role"];
		if (role !== "primary" && role !== "secondary")
			throw new DirectoryError("invalid_input", "Invalid account role");
		const normalizedRole = role as DirectoryAccount["role"];
		let identity: DirectoryAccount["identity"];
		const evidenceKeys = Array.isArray(account["evidenceKeys"])
			? account["evidenceKeys"].map((key) =>
					text(key, "account evidence key", 2048),
				)
			: undefined;
		if (service === "racetime" || service === "speedrunCom") {
			const v = object(account["identity"]);
			identity = {
				userId: text(v["userId"], "account userId"),
				name: text(v["name"], "account name"),
				...(service === "speedrunCom" && speedrunWeblink(v["weblink"])
					? {weblink: speedrunWeblink(v["weblink"])!}
					: {}),
			};
		} else if (service === "twitch") {
			const v = object(account["identity"]);
			identity = {
				login: login(v["login"]),
				...(typeof v["displayName"] === "string"
					? {displayName: text(v["displayName"], "displayName")}
					: {}),
			};
		} else if (service === "youtube") {
			identity = youtubeUrl(account["identity"]);
		} else {
			const profileUrl = normalizeProfileUrl(account["profileUrl"]);
			const derivedService = new URL(profileUrl).hostname.toLowerCase();
			identity = profileUrl;
			return {
				id: text(
					account["id"] ?? directoryAccountId(derivedService, profileUrl),
					"account id",
					2048,
				),
				service: derivedService,
				role: normalizedRole,
				profileUrl,
				identity,
				...(evidenceKeys?.length ? {evidenceKeys} : {}),
			};
		}
		const id = text(account["id"], "account id", 2048);
		return {
			id,
			service,
			role: normalizedRole,
			identity,
			...(evidenceKeys?.length ? {evidenceKeys} : {}),
		};
	});
	const ids = new Set<string>();
	for (const account of accounts) {
		if (ids.has(account.id))
			throw new DirectoryError("identity_conflict", "Duplicate account");
		ids.add(account.id);
	}
	const counts = new Map<string, {total: number; primary: number}>();
	for (const account of accounts) {
		const count = counts.get(account.service) ?? {total: 0, primary: 0};
		count.total++;
		if (account.role === "primary") count.primary++;
		counts.set(account.service, count);
	}
	for (const [service, count] of counts)
		if (count.primary !== 1)
			throw new DirectoryError(
				"invalid_input",
				`${service} must have exactly one Primary account`,
			);
	return accounts;
}

export function normalizeProfileUrl(value: unknown): string {
	const raw = text(value, "Profile URL", 2048);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new DirectoryError("invalid_input", "Invalid profile URL");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!url.hostname ||
		url.username ||
		url.password
	)
		throw new DirectoryError(
			"invalid_input",
			"Use a valid HTTP or HTTPS profile URL",
		);
	return url.href;
}

export function knownProfileService(
	value: string | URL,
): "racetime" | "speedrunCom" | "twitch" | "youtube" | null {
	const host = (
		typeof value === "string" ? new URL(value) : value
	).hostname.toLowerCase();
	if (host === "racetime.gg" || host === "www.racetime.gg") return "racetime";
	if (host === "speedrun.com" || host === "www.speedrun.com")
		return "speedrunCom";
	if (host === "twitch.tv" || host === "www.twitch.tv") return "twitch";
	if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host))
		return "youtube";
	return null;
}
