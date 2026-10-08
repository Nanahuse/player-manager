import type {
	Directory,
	Player,
	ProviderIdentity,
} from "@nanahuse/player-manager-protocol";

export type AccountService = "racetime" | "speedrunCom" | "twitch" | "youtube";
export type EvidenceSource = "user" | "input" | "racetime" | "src";
export type AccountId = string;
export type Account = {id: AccountId; service: AccountService; keys: string[]};
export type EvidenceSet = {
	id: string;
	source: EvidenceSource;
	accounts: AccountId[];
};
export type ResolutionPlayer =
	| {
			id: string;
			kind: "existing";
			player: Player;
			assignedAccountIds: AccountId[];
	  }
	| {id: string; kind: "new"; assignedAccountIds: AccountId[]};
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
};
export type RequiredAccount = {service: AccountService; value: string};
export type Warning = {operation: string; message: string};
export type Resolution = {
	players: ResolutionPlayer[];
	accounts: Account[];
	evidence: EvidenceSet[];
	assignments: Assignment[];
	conflicts: Conflict[];
	candidates: Candidate[];
	warnings: Warning[];
	errors: string[];
	mergeProposal: {
		playerIds: string[];
		accountIds: AccountId[];
		reason: string;
	} | null;
	requiredAccounts: RequiredAccount[];
	newPlayerRequired: boolean;
	requiredStatus: {
		accountId: AccountId;
		satisfied: boolean;
		ownerId?: string;
	}[];
	mergeAssessment: {
		survivorId: string;
		absorbedPlayerIds: string[];
		playersWithoutAccounts: string[];
		conflictsRemaining: number;
	} | null;
	context: Collection;
};
export type MatchingInput = {
	racetime?: string | null;
	speedrunCom?: string | null;
	twitch?: {login: string; userId?: string | null} | null;
	youtube?: string | null;
	manualDisplayName?: string | null;
};
export type Collection = {
	directory: Directory;
	input: MatchingInput;
	accounts: Account[];
	evidence: EvidenceSet[];
	profiles: ProviderIdentity[];
	candidates: Candidate[];
	warnings: Warning[];
	errors: string[];
	requiredAccounts: RequiredAccount[];
	newPlayerId: string;
	inputAccountIds: string[];
};
