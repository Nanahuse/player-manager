import {
	DirectoryError,
	login,
	object,
	type ProviderIdentity,
	text,
} from "../domain/player.ts";

export interface RaceTimeLookup {
	getUser(id: string): Promise<ProviderIdentity>;
	searchUsers(name: string): Promise<ProviderIdentity[]>;
}

export function raceTimeId(value: unknown): string {
	let id = text(value, "RaceTime user ID or profile URL", 2048);
	if (/^https?:\/\//i.test(id)) {
		let url: URL;
		try {
			url = new URL(id);
		} catch {
			throw new DirectoryError("invalid_input", "Invalid RaceTime profile URL");
		}
		if (
			url.protocol !== "https:" ||
			url.hostname !== "racetime.gg" ||
			url.port ||
			url.username ||
			url.password
		)
			throw new DirectoryError(
				"invalid_input",
				"Use a https://racetime.gg/user/<id> profile URL",
			);
		const match = /^\/user\/([a-zA-Z0-9]+)\/?$/.exec(url.pathname);
		if (!match)
			throw new DirectoryError("invalid_input", "Invalid RaceTime profile URL");
		id = match[1]!;
	}
	if (!/^[a-zA-Z0-9]{1,100}$/.test(id))
		throw new DirectoryError("invalid_input", "Invalid RaceTime user ID");
	return id;
}

export class RaceTimeClient implements RaceTimeLookup {
	constructor(private readonly fetcher: typeof fetch = fetch) {}
	async getUser(value: string): Promise<ProviderIdentity> {
		const id = raceTimeId(value);
		try {
			const response = await this.fetcher(
				`https://racetime.gg/user/${id}/data`,
				{
					signal: AbortSignal.timeout(10000),
					headers: {Accept: "application/json"},
				},
			);
			if (response.status === 429)
				throw new DirectoryError(
					"rate_limited",
					"RaceTime rate limit reached; retry later",
				);
			if (!response.ok)
				throw new DirectoryError(
					"lookup_failed",
					`RaceTime returned HTTP ${response.status}`,
				);
			const user = object(await response.json());
			if (user["id"] !== id) throw new Error("RaceTime user ID mismatch");
			let twitchLogin: string | null = null;
			if (user["twitch_channel"] != null) {
				const url = new URL(
					text(user["twitch_channel"], "Twitch channel URL", 2048),
				);
				if (
					!["https:", "http:"].includes(url.protocol) ||
					!["twitch.tv", "www.twitch.tv"].includes(url.hostname) ||
					url.username ||
					url.password ||
					url.port
				)
					throw new Error("Invalid Twitch channel URL");
				twitchLogin = login(url.pathname.replace(/^\//, "").replace(/\/$/, ""));
			} else if (user["twitch_name"] != null) {
				twitchLogin = login(user["twitch_name"]);
			}
			return {
				userId: id,
				name: text(user["full_name"] ?? user["name"], "RaceTime name"),
				twitchLogin,
				...(twitchLogin &&
				typeof user["twitch_display_name"] === "string" &&
				user["twitch_display_name"].trim()
					? {
							twitchDisplayName: text(
								user["twitch_display_name"],
								"Twitch display name",
							),
						}
					: {}),
			};
		} catch (error) {
			if (
				error instanceof DirectoryError &&
				["lookup_failed", "rate_limited"].includes(error.code)
			)
				throw error;
			throw new DirectoryError(
				"lookup_failed",
				"RaceTime request failed or returned invalid profile data",
			);
		}
	}

	async searchUsers(name: string): Promise<ProviderIdentity[]> {
		try {
			const response = await this.fetcher(
				"https://racetime.gg/user/search?" +
					new URLSearchParams({name: text(name, "RaceTime search name")}),
				{
					signal: AbortSignal.timeout(10000),
					headers: {Accept: "application/json"},
				},
			);
			if (!response.ok) throw new Error("HTTP " + response.status);
			const body = object(await response.json());
			if (!Array.isArray(body["results"]))
				throw new Error("Invalid search response");
			return body["results"].map((raw) => {
				const user = object(raw);
				let twitchLogin: string | null = null;
				if (user["twitch_channel"] != null) {
					const url = new URL(text(user["twitch_channel"], "Twitch URL", 2048));
					if (
						!["http:", "https:"].includes(url.protocol) ||
						!["twitch.tv", "www.twitch.tv"].includes(url.hostname)
					)
						throw new Error("Invalid Twitch URL");
					twitchLogin = login(
						url.pathname.replace(/^\//, "").replace(/\/$/, ""),
					);
				} else if (user["twitch_name"] != null)
					twitchLogin = login(user["twitch_name"]);
				return {
					userId: text(user["id"], "RaceTime id"),
					name: text(user["full_name"] ?? user["name"], "RaceTime name"),
					twitchLogin,
					...(twitchLogin &&
					typeof user["twitch_display_name"] === "string" &&
					user["twitch_display_name"].trim()
						? {
								twitchDisplayName: text(
									user["twitch_display_name"],
									"Twitch display name",
								),
							}
						: {}),
				};
			});
		} catch {
			throw new DirectoryError("lookup_failed", "RaceTime user search failed");
		}
	}
}
