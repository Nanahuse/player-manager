export * from "@nanahuse/player-manager-protocol";
import type {
	Operations as PublicOperations,
	IdentityResolutionInput,
	RegistrationSession,
	RegistrationResult,
	ProviderIdentity,
	Response,
} from "@nanahuse/player-manager-protocol";
export type CompleteRegistration =
	| {action: "existing"; playerId: string}
	| {action: "created"; input: IdentityResolutionInput}
	| {
			action: "updated";
			playerId: string;
			revision: number;
			input: IdentityResolutionInput;
	  };
export type Operations = PublicOperations & {
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
	searchUsers: {
		request: {query: string; mode: "name" | "lookup" | "twitch"};
		response: {users: ProviderIdentity[]; hasMore: boolean};
	};
	getUser: {request: {userId: string}; response: ProviderIdentity};
};
export type PlayerDirectoryAPI = {
	apiVersion: 1;
	ready: Promise<void>;
	request<K extends keyof Operations>(
		operation: K,
		request: Operations[K]["request"],
	): Promise<Response<Operations[K]["response"]>>;
};
