export type AccountIdentity = {
	weblink?: string;
	userId: string;
	name: string;
};

export type ProviderIdentity = AccountIdentity & {
	twitchLogin?: string | null;
	twitchDisplayName?: string;
	youtube?: string | null;
};

export type TwitchIdentity = {
	userId: string | null;
	login: string;
	displayName?: string;
};

export type IdentityInput = {
	youtube?: string | null;
	racetime: ProviderIdentity | null;
	speedrunCom: ProviderIdentity | null;
	twitch: TwitchIdentity | null;
};

export type PlayerInput = IdentityInput & {manualDisplayName: string | null};

export type StoredPlayerInput = Omit<
	PlayerInput,
	"racetime" | "speedrunCom"
> & {
	racetime: AccountIdentity | null;
	speedrunCom: AccountIdentity | null;
	youtube: string | null;
};

export type PlayerId = string;

export type Player = StoredPlayerInput & {playerId: PlayerId; revision: number};

export type Directory = {schemaVersion: 1; revision: number; players: Player[]};

export type FailureCode =
	| "invalid_input"
	| "identity_conflict"
	| "player_not_found"
	| "player_changed"
	| "directory_unavailable"
	| "persistence_failed"
	| "lookup_failed"
	| "rate_limited"
	| "unsupported_operation"
	| "registration_not_found"
	| "registration_expired";

export type Resolution = {
	status: "matched" | "unresolved" | "ambiguous" | "conflict";
	input: PlayerInput;
	playerId: string | null;
	candidates: ResolutionCandidate[];
	message: string;
	warnings: string[];
};

export type IdentityResolutionInput = {
	youtube?: string | null;
	manualDisplayName?: string | null;
	racetime?:
		| (Pick<ProviderIdentity, "userId"> & Partial<ProviderIdentity>)
		| null;
	speedrunCom?:
		| (Pick<ProviderIdentity, "userId"> & Partial<ProviderIdentity>)
		| null;
	twitch?: {login: string; userId?: string | null} | null;
};

export function resolveDisplayName(
	player: PlayerInput & {playerId?: string},
): string {
	const twLogin =
		player.twitch?.login ??
		player.racetime?.twitchLogin ??
		player.speedrunCom?.twitchLogin;
	const profileDisplayName =
		twLogin && player.racetime?.twitchLogin === twLogin
			? player.racetime.twitchDisplayName
			: undefined;
	return (
		[
			player.manualDisplayName,
			player.twitch?.displayName,
			profileDisplayName,
			twLogin,
			player.speedrunCom?.name,
			player.racetime?.name,
			player.playerId,
		]
			.find((v) => typeof v === "string" && v.trim().length > 0)
			?.trim() ?? "未設定"
	);
}

export type IdentityProvider =
	| "racetime"
	| "speedrunCom"
	| "twitch"
	| "twitch-id"
	| "youtube";

export type ResolutionCandidate =
	| {type: "player"; playerId: string}
	| {type: "identity"; provider: IdentityProvider; value: string};

export type Mutation =
	| {type: "create"; ref: string; input: IdentityResolutionInput}
	| {
			type: "update";
			ref: string;
			playerId: string;
			revision: number;
			input: IdentityResolutionInput;
	  }
	| {type: "delete"; ref: string; playerId: string; revision: number};

export type MutationResult =
	| {type: "create" | "update"; ref: string; player: Player}
	| {type: "delete"; ref: string; playerId: string};

export type MutationResponse = {
	directoryRevision: number;
	results: MutationResult[];
};
