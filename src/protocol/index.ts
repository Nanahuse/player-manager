import type {
	Directory,
	FailureCode,
	IdentityResolutionInput,
	Player,
	PlayerInput,
	ProviderIdentity,
	Resolution,
} from "../domain/player.ts";

export type {
	AccountIdentity,
	StoredPlayerInput,
	Directory,
	IdentityInput,
	IdentityResolutionInput,
	Player,
	PlayerInput,
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
export type Operations = {
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
	create: {request: {input: PlayerInput}; response: Player};
	update: {
		request: {playerId: string; revision: number; input: PlayerInput};
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
