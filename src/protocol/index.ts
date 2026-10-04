import type {
	IdentityProvider,
	Mutation,
	MutationResponse,
	Directory,
	FailureCode,
	IdentityResolutionInput,
	Player,
	ProviderIdentity,
	Resolution,
} from "../domain/player.ts";

export type {
	FailureCode,
	PlayerInput,
	PlayerId,
	IdentityProvider,
	ResolutionCandidate,
	Mutation,
	MutationResult,
	MutationResponse,
	AccountIdentity,
	StoredPlayerInput,
	Directory,
	IdentityInput,
	IdentityResolutionInput,
	Player,
	ProviderIdentity,
	Resolution,
	TwitchIdentity,
} from "../domain/player.ts";
export const BUNDLE_NAME = "player-manager";
export const API_VERSION = 1;
export type StorageStatus = {
	destination: "local" | "spreadsheet";
	spreadsheetId: string;
	pending: boolean;
	message: string;
};
export type RegistrationResult = {
	registrationId: string;
	action: "existing" | "created" | "updated";
	player: Player;
};
export type RegistrationSession = {
	registrationId: string;
	state: "pending" | "completed" | "cancelled" | "expired";
	input: IdentityResolutionInput;
	resolution: Resolution | null;
	result: RegistrationResult | null;
};
export type CompleteRegistration =
	| {action: "existing"; playerId: string}
	| {action: "created"; input: IdentityResolutionInput}
	| {
			action: "updated";
			playerId: string;
			revision: number;
			input: IdentityResolutionInput;
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
		request: {input: IdentityResolutionInput};
		response: {registrationId: string; url: string};
	};
	getRegistration: {
		request: {registrationId: string};
		response: RegistrationSession | null;
	};
	resolveRegistration: {
		request: {registrationId: string; input: IdentityResolutionInput};
		response: RegistrationSession;
	};
	completeRegistration: {
		request: {registrationId: string} & CompleteRegistration;
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
	resolve: {request: {input: IdentityResolutionInput}; response: Resolution};
	reload: {request: undefined; response: Directory};
	searchUsers: {
		request: {query: string; mode: "name" | "lookup" | "twitch"};
		response: {users: ProviderIdentity[]; hasMore: boolean};
	};
	getUser: {request: {userId: string}; response: ProviderIdentity};
};
export type Response<T> =
	| {ok: true; data: T}
	| {ok: false; error: {code: FailureCode; message: string}};
export type PlayerDirectoryAPI = {
	apiVersion: 1;
	ready: Promise<void>;
	request<K extends keyof Operations>(
		operation: K,
		request: Operations[K]["request"],
	): Promise<Response<Operations[K]["response"]>>;
};

export {resolveDisplayName} from "../domain/player.ts";

export type PlayerManagerAPI = PlayerDirectoryAPI;
