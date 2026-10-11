import type {
	Account,
	AccountId,
	AccountService,
	Assignment,
	Candidate,
	Conflict,
	Directory,
	EvidenceSet,
	EvidenceSource,
	MatchingInput,
	Resolution as ProtocolResolution,
	ProviderIdentity,
	RequiredAccount,
	ResolutionPlayer,
	Warning,
} from "@nanahuse/player-manager-protocol";

export type {
	Account,
	AccountId,
	AccountService,
	Assignment,
	Candidate,
	Conflict,
	EvidenceSet,
	EvidenceSource,
	MatchingInput,
	RequiredAccount,
	ResolutionPlayer,
	Warning,
};
export type ResolutionChoices = {
	assignments: Assignment[];
	merge:
		| {
				decision: "merge";
				survivorId: string;
				playerIds: string[];
				accountIds: string[];
		  }
		| {
				decision: "keepSeparate";
				playerIds: string[];
				accountIds: string[];
		  }
		| null;
	deletePlayerIds: string[];
};
export type Resolution = ProtocolResolution & {
	context: Collection;
	choices: ResolutionChoices;
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
	createPlayerOnEmpty?: boolean;
	inputAccountIds: AccountId[];
	seedAccountIds: AccountId[];
};
