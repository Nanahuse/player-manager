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

export type AccountService = "racetime" | "speedrunCom" | "twitch" | "youtube";
export type AccountId = string;
export type Account = {
	id: AccountId;
	service: AccountService;
	keys: string[];
	profile?: Partial<ProviderIdentity>;
};
export type EvidenceSource = "user" | "input" | "racetime" | "src";
export type Warning = {operation: string; message: string};
export type EvidenceSet = {
	id: string;
	source: EvidenceSource;
	accounts: AccountId[];
};
export type Assignment = {
	accountId: AccountId;
	ownerId: string;
	source: "user" | "inferred" | "new";
};
export type Conflict = {
	id: string;
	evidenceId: string;
	ownerIds: string[];
	status: "conflict" | "resolved";
};
export type Candidate = {
	id: string;
	service: "racetime" | "speedrunCom";
	profile: ProviderIdentity;
	query: string;
	originAccountId: AccountId;
};
export type RequiredAccount = {service: AccountService; value: string};
export type MatchingInput = {
	racetime?: string | null;
	speedrunCom?: string | null;
	twitch?: {login: string; userId?: string | null} | null;
	youtube?: string | null;
	manualDisplayName?: string | null;
};
export type ResolutionPlayer =
	| {
			id: string;
			kind: "existing";
			player: Player;
			assignedAccountIds: AccountId[];
	  }
	| {id: string; kind: "new"; assignedAccountIds: AccountId[]};
export type MergeProposal = {
	playerIds: string[];
	accountIds: AccountId[];
	reason: string;
};
export type Resolution = {
	input: MatchingInput;
	discardedAccountIds: AccountId[];
	confirmedCandidateAccountIds: AccountId[];
	players: ResolutionPlayer[];
	accounts: Account[];
	evidence: EvidenceSet[];
	assignments: Assignment[];
	conflicts: Conflict[];
	candidates: Candidate[];
	warnings: Warning[];
	errors: string[];
	mergeProposal: MergeProposal | null;
	mergeAssessment: {
		survivorId: string;
		absorbedPlayerIds: string[];
		playersWithoutAccounts: string[];
		conflictsRemaining: number;
	} | null;
	requiredAccounts: RequiredAccount[];
	requiredStatus: {
		accountId: AccountId;
		satisfied: boolean;
		ownerId?: string;
	}[];
	newPlayerRequired: boolean;
	deletePlayerIds: string[];
	deletionCandidates: string[];
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
