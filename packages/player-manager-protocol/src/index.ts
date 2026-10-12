import type {
	Directory,
	FailureCode,
	IdentityProvider,
	IdentityResolutionInput,
	MatchingInput,
	Mutation,
	MutationResponse,
	Player,
	ProviderIdentity,
	RegistrationTarget,
	RequiredAccount,
	Resolution,
} from "./player.js";

export type {
	Account,
	AccountId,
	AccountIdentity,
	AccountRequest,
	AccountRole,
	AccountService,
	Assignment,
	Candidate,
	Conflict,
	Directory,
	DirectoryAccount,
	EvidenceSet,
	EvidenceSource,
	FailureCode,
	IdentityInput,
	IdentityProvider,
	IdentityResolutionInput,
	MatchingInput,
	MergeProposal,
	Mutation,
	MutationResponse,
	MutationResult,
	Player,
	PlayerId,
	PlayerInput,
	ProviderIdentity,
	RegistrationTarget,
	RequiredAccount,
	Resolution,
	ResolutionPlayer,
	RoleConflict,
	StoredPlayerInput,
	TwitchIdentity,
	Warning,
} from "./player.js";
export const BUNDLE_NAME = "player-manager";
export const API_VERSION = 3;
export type StorageStatus = {
	destination: "local" | "spreadsheet";
	spreadsheetId: string;
	pending: boolean;
	message: string;
};
export type RegistrationResult = {
	registrationId: string;
	directoryRevision: number;
	players: Player[];
	deletedPlayerIds: string[];
};
export type RegistrationSession = {
	registrationId: string;
	state: "pending" | "completed" | "cancelled" | "expired";
	input: MatchingInput;
	target?: RegistrationTarget;
	displayNameChange?: {playerId: string; value: string | null};
	requiredAccounts: RequiredAccount[];
	resolution: Resolution | null;
	result: RegistrationResult | null;
};

export type Operations = {
	status: {
		request: undefined;
		response: {ready: boolean; error: string | null};
	};
	mutate: {request: {operations: Mutation[]}; response: MutationResponse};
	searchIdentities: {
		request: {provider: IdentityProvider; query: string; mode?: string};
		response: {identities: ProviderIdentity[]; hasMore: boolean};
	};
	getIdentity: {
		request: {provider: IdentityProvider; value: string};
		response: ProviderIdentity;
	};
	beginRegistration: {
		request: {
			input: MatchingInput;
			target?: RegistrationTarget;
			requiredAccounts?: RequiredAccount[];
			createPlayerOnEmpty?: boolean;
		};
		response: {registrationId: string; url: string};
	};
	getRegistration: {
		request: {registrationId: string};
		response: RegistrationSession | null;
	};
	resolveRegistration: {
		request: {registrationId: string; input: MatchingInput};
		response: RegistrationSession;
	};
	assignRegistrationAccount: {
		request: {registrationId: string; accountId: string; ownerId: string};
		response: RegistrationSession;
	};
	setRegistrationAccountUsage: {
		request: {registrationId: string; accountId: string; use: boolean};
		response: RegistrationSession;
	};
	setRegistrationAccountPrimary: {
		request: {registrationId: string; accountId: string};
		response: RegistrationSession;
	};
	approveRegistrationConflict: {
		request: {registrationId: string; conflictId: string};
		response: RegistrationSession;
	};
	selectRegistrationMergeSurvivor: {
		request: {registrationId: string; survivorId: string};
		response: RegistrationSession;
	};
	setRegistrationMergeDecision: {
		request: {
			registrationId: string;
			decision: "keepSeparate" | "undecided";
		};
		response: RegistrationSession;
	};
	setRegistrationPlayerDeletion: {
		request: {registrationId: string; playerId: string; delete: boolean};
		response: RegistrationSession;
	};
	setRegistrationDisplayName: {
		request: {registrationId: string; value: string | null};
		response: RegistrationSession;
	};
	completeRegistration: {
		request: {registrationId: string};
		response: RegistrationResult;
	};
	cancelRegistration: {
		request: {registrationId: string};
		response: RegistrationSession;
	};

	storage: {request: undefined; response: StorageStatus};
	configureStorage: {request: {spreadsheet: string}; response: StorageStatus};
	list: {request: undefined; response: Directory};
	get: {request: {playerId: string}; response: Player | null};
	find: {
		request: {
			provider: "racetime" | "speedrunCom" | "twitch" | "youtube";
			value: string;
		};
		response: Player | null;
	};
	findAccount: {
		request: {accountId: string};
		response: {
			player: Player;
			account: import("./player.js").DirectoryAccount;
		} | null;
	};
	create: {request: {input: IdentityResolutionInput}; response: Player};
	update: {
		request: {
			playerId: string;
			revision: number;
			input: IdentityResolutionInput;
		};
		response: Player;
	};
	delete: {
		request: {playerId: string; revision: number};
		response: {playerId: string};
	};
	resolve: {
		request: {input: MatchingInput; requiredAccounts?: RequiredAccount[]};
		response: Resolution;
	};
	reload: {request: undefined; response: Directory};
};
export type Response<T> =
	| {ok: true; data: T}
	| {ok: false; error: {code: FailureCode; message: string}};
export type PlayerDirectoryAPI = {
	apiVersion: 3;
	ready: Promise<void>;
	request<K extends keyof Operations>(
		operation: K,
		request: Operations[K]["request"],
	): Promise<Response<Operations[K]["response"]>>;
};

export {resolveDisplayName} from "./player.js";
export {playerEditUrl} from "./player-edit-url.js";

export type PlayerManagerAPI = PlayerDirectoryAPI;

export const MESSAGE_PREFIX = "player-manager.v3";
export type PlayerManagerEvents = {
	directoryChanged: {directoryRevision: number};
	registrationCompleted: RegistrationResult;
	registrationCancelled: {registrationId: string};
};
export const operationMessageName = <K extends keyof Operations>(
	operation: K,
): `player-manager.v3.${K}` => `${MESSAGE_PREFIX}.${operation}`;
export const eventMessageName = <K extends keyof PlayerManagerEvents>(
	event: K,
): `player-manager.v3.${K}` => `${MESSAGE_PREFIX}.${event}`;
