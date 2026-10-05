import {type ProviderIdentity} from "@nanahuse/player-manager-protocol";
import {
	DirectoryError,
	login,
	youtubeUrl,
	speedrunReference,
	speedrunWeblink,
	object,
	text,
} from "../domain/player.ts";
export type SearchMode = "name" | "lookup" | "twitch";
export interface UserLookup {
	getUser(id: string): Promise<ProviderIdentity>;
	searchUsers(
		query: string,
		mode: SearchMode,
	): Promise<{users: ProviderIdentity[]; hasMore: boolean}>;
}
type ErrorLogger = (message: string, error: unknown) => void;
function optionalYoutube(raw: unknown): string | null {
	if (raw == null) return null;
	try {
		const uri = text(object(raw)["uri"], "YouTube URL", 2048);
		// Some imported profiles encode a query separator into the channel path.
		return youtubeUrl(uri.replace(/%(?:3f|23).*$/i, ""));
	} catch {
		// An unusable optional link must not discard the user account.
		return null;
	}
}
function optionalTwitchLogin(raw: unknown): string | null {
	if (raw == null) return null;
	try {
		const uri = new URL(text(object(raw)["uri"], "Twitch URL", 2048));
		if (
			!["twitch.tv", "www.twitch.tv"].includes(uri.hostname) ||
			!["http:", "https:"].includes(uri.protocol) ||
			uri.username ||
			uri.password ||
			uri.port ||
			uri.search ||
			uri.hash
		)
			return null;
		const match = /^\/([^/]+)\/?$/.exec(uri.pathname);
		return match ? login(match[1]) : null;
	} catch {
		return null;
	}
}
function mapUser(raw: unknown): ProviderIdentity {
	const v = object(raw);
	const names = object(v["names"]);
	const userId = text(v["id"], "SRC id");
	const name = text(names["international"], "SRC name");
	const youtube = optionalYoutube(v["youtube"]);
	const weblink = speedrunWeblink(v["weblink"]);
	const twitchLogin = optionalTwitchLogin(v["twitch"]);
	return {
		...(youtube ? {youtube} : {}),
		...(weblink ? {weblink} : {}),
		userId,
		name,
		twitchLogin,
	};
}
export class SpeedrunClient implements UserLookup {
	private cooldownUntil = 0;
	constructor(
		private readonly fetcher: typeof fetch = fetch,
		private readonly errorLogger: ErrorLogger = () => {},
	) {}
	private async request(path: string): Promise<Record<string, unknown>> {
		if (Date.now() < this.cooldownUntil)
			throw new DirectoryError(
				"rate_limited",
				"Speedrun.com is rate limited; retry later",
			);
		try {
			const response = await this.fetcher(
				`https://www.speedrun.com/api/v1/${path}`,
				{
					signal: AbortSignal.timeout(10000),
					headers: {Accept: "application/json"},
				},
			);
			if (response.status === 429) {
				const seconds = Number(response.headers.get("retry-after") ?? 60);
				this.cooldownUntil =
					Date.now() +
					(Number.isFinite(seconds) && seconds > 0
						? Math.min(seconds, 3600)
						: 60) *
						1000;
				throw new DirectoryError(
					"rate_limited",
					"Speedrun.com rate limit reached; retry later",
				);
			}
			if (!response.ok)
				throw new DirectoryError(
					"lookup_failed",
					`Speedrun.com returned HTTP ${response.status}`,
				);
			return object(await response.json());
		} catch (error) {
			if (error instanceof DirectoryError) throw error;
			throw new DirectoryError(
				"lookup_failed",
				"Speedrun.com request failed or returned invalid data",
			);
		}
	}
	async getUser(id: string): Promise<ProviderIdentity> {
		const response = await this.request(
			`users/${encodeURIComponent(speedrunReference(id))}`,
		);
		try {
			return mapUser(response["data"]);
		} catch (error) {
			this.errorLogger("Invalid Speedrun.com user response", error);
			throw new DirectoryError(
				"lookup_failed",
				"Invalid Speedrun.com user response",
			);
		}
	}
	async searchUsers(
		query: string,
		mode: SearchMode = "name",
	): Promise<{users: ProviderIdentity[]; hasMore: boolean}> {
		if (!["name", "lookup", "twitch"].includes(mode))
			throw new DirectoryError("invalid_input", "Unknown search mode");
		const params = new URLSearchParams({
			[mode]: text(query, "Search query", 2048),
			max: "100",
		});
		const response = await this.request(`users?${params}`);
		try {
			if (!Array.isArray(response["data"])) throw new Error("Missing users");
			const users = response["data"].map(mapUser);
			const pagination = response["pagination"]
				? object(response["pagination"])
				: {};
			const links = pagination["links"];
			return {
				users,
				hasMore:
					users.length >= 100 ||
					(Array.isArray(links) &&
						links.some((link) => object(link)["rel"] === "next")),
			};
		} catch (error) {
			this.errorLogger("Invalid Speedrun.com search response", error);
			throw new DirectoryError(
				"lookup_failed",
				"Invalid Speedrun.com search response",
			);
		}
	}
}
