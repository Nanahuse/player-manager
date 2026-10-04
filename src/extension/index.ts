import {resolve} from "node:path";
import type NodeCG from "@nodecg/types";
import {
	type Directory,
	DirectoryError,
	integer,
	login,
	youtubeUrl,
	object,
	text,
} from "../domain/player.ts";
import {
	API_VERSION,
	type Operations,
	type PlayerDirectoryAPI,
	type Response,
} from "../protocol/index.ts";
import {fileStorage} from "./storage.ts";
import {SheetsRepository, serviceAccountToken} from "./sheets.ts";
import type {StorageStatus} from "../protocol/index.ts";
import {PlayerDirectoryService} from "./service.ts";
import {type SearchMode, SpeedrunClient} from "./speedrun.ts";

export default function (nodecg: NodeCG.ServerAPI): PlayerDirectoryAPI {
	const directory = nodecg.Replicant<Directory>("player-directory", {
		persistent: false,
		defaultValue: {schemaVersion: 1, revision: 0, players: []},
	});
	const status = nodecg.Replicant<{ready: boolean; error: string | null}>(
		"player-directory-status",
		{persistent: false, defaultValue: {ready: false, error: null}},
	);
	const config = nodecg.bundleConfig as {
		directoryFile?: string;
		googleCredentialsFile?: string;
	};
	const file = config.directoryFile
		? resolve(config.directoryFile)
		: resolve(__dirname, "../data/player-directory.json");
	const storageStatus = nodecg.Replicant<StorageStatus>(
		"player-directory-storage",
		{
			persistent: false,
			defaultValue: {
				destination: "local",
				spreadsheetId: "",
				pending: false,
				message: "ローカル保存",
			},
		},
	);
	const token = serviceAccountToken(
		config.googleCredentialsFile
			? resolve(config.googleCredentialsFile)
			: process.env["GOOGLE_APPLICATION_CREDENTIALS"],
	);
	const repository = fileStorage(
		file,
		(id) => new SheetsRepository(id, token),
		(value) => {
			storageStatus.value = value;
		},
	);
	const lookup = new SpeedrunClient();
	const service = new PlayerDirectoryService(repository, lookup, (value) => {
		directory.value = value;
	});
	const ready = service.reload().then(
		() => {
			status.value = {ready: true, error: null};
		},
		(error) => {
			status.value = {ready: false, error: String(error)};
			nodecg.log.error("Player Directory could not load", error);
		},
	);
	async function request<K extends keyof Operations>(
		operation: K,
		raw: Operations[K]["request"],
	): Promise<Response<Operations[K]["response"]>> {
		await ready;
		try {
			const data = raw == null ? {} : object(raw);
			let value: unknown;
			switch (operation) {
				case "storage":
					value = repository.status();
					break;
				case "configureStorage":
					if (typeof data["spreadsheet"] !== "string")
						throw new DirectoryError(
							"invalid_input",
							"シートURLまたはIDを入力してください",
						);
					await service.configureStorage((current) =>
						repository.configure(data["spreadsheet"] as string, current),
					);
					value = repository.status();
					break;
				case "list":
					value = service.snapshot();
					break;
				case "get":
					value = service.getPlayer(text(data["playerId"], "playerId"));
					break;
				case "find": {
					const provider = text(data["provider"], "provider");
					if (
						![
							"racetime",
							"speedrunCom",
							"twitch",
							"twitch-id",
							"youtube",
						].includes(provider)
					)
						throw new DirectoryError("invalid_input", "Unknown provider");
					value = service.find(
						`${provider}:${provider === "youtube" ? youtubeUrl(data["value"]) : provider === "twitch" ? login(data["value"]) : text(data["value"], "value")}`,
					);
					break;
				}
				case "create":
					value = await service.createPlayer(data["input"]);
					break;
				case "update":
					value = await service.updatePlayer(
						text(data["playerId"], "playerId"),
						integer(data["revision"]),
						data["input"],
					);
					break;
				case "delete":
					value = await service.deletePlayer(
						text(data["playerId"], "playerId"),
						integer(data["revision"]),
					);
					break;
				case "resolve":
					value = await service.resolveIdentity(data["input"]);
					break;
				case "reload":
					value = await service.reload();
					status.value = {ready: true, error: null};
					break;
				case "searchUsers":
					value = await lookup.searchUsers(
						text(data["query"], "query"),
						text(data["mode"], "mode") as SearchMode,
					);
					break;
				case "getUser":
					value = await lookup.getUser(text(data["userId"], "userId"));
					break;
				default:
					throw new DirectoryError("invalid_input", "Unknown operation");
			}
			return {ok: true, data: value as Operations[K]["response"]};
		} catch (error) {
			const known =
				error instanceof DirectoryError
					? error
					: new DirectoryError("directory_unavailable", "Operation failed");
			nodecg.log.warn(`${operation}: ${known.message}`);
			return {ok: false, error: {code: known.code, message: known.message}};
		}
	}
	for (const operation of [
		"storage",
		"configureStorage",
		"list",
		"get",
		"find",
		"create",
		"update",
		"delete",
		"resolve",
		"reload",
		"searchUsers",
		"getUser",
	] as const) {
		nodecg.listenFor(`player-directory.v1.${operation}`, (data, ack) => {
			void request(operation, data).then((result) => {
				if (ack && !ack.handled) ack(null, result);
			});
		});
	}
	return {apiVersion: API_VERSION, ready, request};
}
