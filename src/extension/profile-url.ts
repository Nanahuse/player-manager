import type {DirectoryAccount} from "@nanahuse/player-manager-protocol";
import {
	DirectoryError,
	login,
	normalizeProfileUrl,
	speedrunReference,
	speedrunWeblink,
	youtubeUrl,
} from "../domain/player.ts";
import {raceTimeId} from "./racetime.ts";
import type {UserLookup} from "./speedrun.ts";

const PROFILE_URL_TTL_MS = 10 * 60 * 1000;

function accountUserId(account: DirectoryAccount): string {
	const identity = account.identity;
	if (identity && typeof identity === "object" && "userId" in identity)
		return String(identity.userId);
	throw new DirectoryError("lookup_failed", "Account has no stored user ID");
}

function accountLogin(account: DirectoryAccount): string {
	const identity = account.identity;
	if (typeof identity === "string") return identity;
	if (identity && typeof identity === "object" && "login" in identity)
		return String(identity.login);
	throw new DirectoryError("lookup_failed", "Account has no stored login");
}

function buildProfileUrl(build: () => string): string {
	try {
		return normalizeProfileUrl(build());
	} catch {
		throw new DirectoryError(
			"lookup_failed",
			"Could not resolve a valid profile URL for this account",
		);
	}
}

export class AccountProfileUrlResolver {
	private readonly cache = new Map<string, {url: string; expiresAt: number}>();
	constructor(
		private readonly lookup: Pick<UserLookup, "getUser">,
		private readonly now: () => number = Date.now,
	) {}

	async resolve(account: DirectoryAccount): Promise<string> {
		const cached = this.cache.get(account.id);
		if (cached && cached.expiresAt > this.now()) return cached.url;
		const url = await this.lookupUrl(account);
		this.cache.set(account.id, {
			url,
			expiresAt: this.now() + PROFILE_URL_TTL_MS,
		});
		return url;
	}

	private async lookupUrl(account: DirectoryAccount): Promise<string> {
		switch (account.service) {
			case "racetime":
				return buildProfileUrl(
					() =>
						`https://racetime.gg/user/${encodeURIComponent(raceTimeId(accountUserId(account)))}`,
				);
			case "speedrunCom":
				return this.lookupSpeedrun(account);
			case "twitch":
				return buildProfileUrl(
					() => `https://www.twitch.tv/${login(accountLogin(account))}`,
				);
			case "youtube":
				return buildProfileUrl(() => youtubeUrl(account.identity));
			default:
				return buildProfileUrl(() => String(account.profileUrl ?? ""));
		}
	}

	private async lookupSpeedrun(account: DirectoryAccount): Promise<string> {
		try {
			const profile = await this.lookup.getUser(
				speedrunReference(accountUserId(account)),
			);
			const weblink = speedrunWeblink(profile.weblink);
			if (!weblink)
				throw new DirectoryError(
					"lookup_failed",
					"Speedrun.com has no usable profile link for this account",
				);
			return weblink;
		} catch (error) {
			if (
				error instanceof DirectoryError &&
				["lookup_failed", "rate_limited"].includes(error.code)
			)
				throw error;
			throw new DirectoryError(
				"lookup_failed",
				"Could not resolve a Speedrun.com profile URL",
			);
		}
	}
}
