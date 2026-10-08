export * from "@nanahuse/player-manager-protocol";

import type {
	ProviderIdentity,
	Operations as PublicOperations,
	Response,
} from "@nanahuse/player-manager-protocol";
import type {SearchMode} from "../extension/speedrun.ts";

export type Operations = PublicOperations & {
	searchUsers: {
		request: {query: string; mode: SearchMode};
		response: {users: ProviderIdentity[]; hasMore: boolean};
	};
	getUser: {request: {userId: string}; response: ProviderIdentity};
};
export type PlayerDirectoryAPI = {
	apiVersion: 2;
	ready: Promise<void>;
	request<K extends keyof Operations>(
		operation: K,
		request: Operations[K]["request"],
	): Promise<Response<Operations[K]["response"]>>;
};
