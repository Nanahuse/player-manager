import type {
	AccountIdentity,
	ProviderIdentity,
	IdentityInput,
	PlayerInput,
	StoredPlayerInput,
	Player,
	Directory,
	FailureCode,
} from "@nanahuse/player-manager-protocol";

export class DirectoryError extends Error {
	constructor(
		public code: FailureCode,
		message: string,
	) {
		super(message);
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
					userId: optionalText(tw["userId"], "Twitch userId"),
					login: login(tw["login"]),
				}
			: null,
	};
	const logins = new Set(
		[
			result.racetime?.twitchLogin,
			result.speedrunCom?.twitchLogin,
			result.twitch?.login,
		].filter(Boolean),
	);
	if (logins.size > 1)
		throw new DirectoryError(
			"identity_conflict",
			"Linked accounts have different Twitch logins",
		);
	const channels = [
		result.youtube,
		result.racetime?.youtube,
		result.speedrunCom?.youtube,
	].filter((v): v is string => Boolean(v));
	if (new Set(channels).size > 1)
		throw new DirectoryError(
			"identity_conflict",
			"Linked accounts have different YouTube channels",
		);
	if (channels[0]) result.youtube = channels[0];
	return result;
}
export function identityKeys(p: IdentityInput): string[] {
	return [
		...new Set(
			[
				p.youtube && `youtube:${youtubeUrl(p.youtube)}`,
				p.racetime?.youtube && `youtube:${youtubeUrl(p.racetime.youtube)}`,
				p.speedrunCom?.youtube &&
					`youtube:${youtubeUrl(p.speedrunCom.youtube)}`,
				p.racetime && `racetime:${p.racetime.userId}`,
				p.speedrunCom && `speedrunCom:${p.speedrunCom.userId}`,
				p.twitch?.userId && `twitch-id:${p.twitch.userId}`,
				p.twitch && `twitch:${p.twitch.login}`,
				p.racetime?.twitchLogin && `twitch:${p.racetime.twitchLogin}`,
				p.speedrunCom?.twitchLogin && `twitch:${p.speedrunCom.twitchLogin}`,
			].filter(
				(key): key is string => typeof key === "string" && key.length > 0,
			),
		),
	];
}
export function assertUnique(players: Player[]): void {
	const owners = new Map<string, string>();
	for (const p of players)
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
export function integer(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new DirectoryError("invalid_input", "Non-negative revision required");
	return value as number;
}
export function validateDirectory(value: unknown): Directory {
	const v = object(value);
	if (v["schemaVersion"] !== 1 || !Array.isArray(v["players"]))
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
	assertUnique(players);
	return {schemaVersion: 1, revision: integer(v["revision"]), players};
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
	return {
		manualDisplayName: input.manualDisplayName,
		racetime: account(input.racetime),
		speedrunCom: account(input.speedrunCom, true),
		twitch: twitchLogin
			? {
					userId: input.twitch?.userId ?? null,
					login: twitchLogin,
					...(displayName ? {displayName} : {}),
				}
			: null,
		youtube: input.youtube ?? null,
	};
}
