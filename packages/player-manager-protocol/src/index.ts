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
	RequiredAccount,
	Resolution,
} from "./player.js";

export type {
	Account,
	AccountId,
	AccountIdentity,
	AccountService,
	Assignment,
	Candidate,
	Conflict,
	Directory,
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
	RequiredAccount,
	Resolution,
	ResolutionPlayer,
	StoredPlayerInput,
	TwitchIdentity,
	Warning,
} from "./player.js";
export const BUNDLE_NAME = "player-manager";
export const API_VERSION = 2;
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
	approveRegistrationConflict: {
		request: {registrationId: string; conflictId: string};
		response: RegistrationSession;
	};
	selectRegistrationMergeSurvivor: {
		request: {registrationId: string; survivorId: string};
		response: RegistrationSession;
	};
	setRegistrationPlayerDeletion: {
		request: {registrationId: string; playerId: string; delete: boolean};
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
			provider: "racetime" | "speedrunCom" | "twitch" | "twitch-id" | "youtube";
			value: string;
		};
		response: Player | null;
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
	apiVersion: 2;
	ready: Promise<void>;
	request<K extends keyof Operations>(
		operation: K,
		request: Operations[K]["request"],
	): Promise<Response<Operations[K]["response"]>>;
};

export {resolveDisplayName} from "./player.js";

export type PlayerManagerAPI = PlayerDirectoryAPI;

export const MESSAGE_PREFIX = "player-manager.v2";
export type PlayerManagerEvents = {
	registrationCompleted: RegistrationResult;
	registrationCancelled: {registrationId: string};
};
export const operationMessageName = <K extends keyof Operations>(
	operation: K,
): `player-manager.v2.${K}` => `${MESSAGE_PREFIX}.${operation}`;
export const eventMessageName = <K extends keyof PlayerManagerEvents>(
	event: K,
): `player-manager.v2.${K}` => `${MESSAGE_PREFIX}.${event}`;
