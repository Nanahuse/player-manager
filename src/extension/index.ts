import {resolve} from "node:path";
import type {StorageStatus} from "@nanahuse/player-manager-protocol";
import {
	API_VERSION,
	type Directory,
	eventMessageName,
	type Response,
} from "@nanahuse/player-manager-protocol";
import type NodeCG from "@nodecg/types";
import {
	DirectoryError,
	integer,
	login,
	object,
	text,
	youtubeUrl,
} from "../domain/player.ts";
import {publicResolution} from "../matching/commit.ts";
import {type Operations, type PlayerDirectoryAPI} from "../protocol/index.ts";
import {resolveMatching} from "./matching/engine.ts";
import {RaceTimeClient} from "./racetime.ts";
import {
	matchingInput,
	RegistrationService,
	requiredAccounts,
} from "./registration.ts";
import {PlayerDirectoryService} from "./service.ts";
import {applicationDefaultToken, SheetsRepository} from "./sheets.ts";
import {type SearchMode, SpeedrunClient} from "./speedrun.ts";
import {fileStorage} from "./storage.ts";

export default function (nodecg: NodeCG.ServerAPI): PlayerDirectoryAPI {
	const directory = nodecg.Replicant<Directory>("player-directory", {
		persistent: false,
		defaultValue: {schemaVersion: 2, revision: 0, players: []},
	});
	const status = nodecg.Replicant<{ready: boolean; error: string | null}>(
		"player-directory-status",
		{persistent: false, defaultValue: {ready: false, error: null}},
	);
	const config = nodecg.bundleConfig as {
		directoryFile?: string;
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
	const token = applicationDefaultToken();
	const repository = fileStorage(
		file,
		(id) => new SheetsRepository(id, token),
		(value) => {
			storageStatus.value = value;
		},
		(error) => nodecg.log.error("Player Directory storage error", error),
	);
	const lookup = new SpeedrunClient(fetch, (message, error) =>
		nodecg.log.error(message, error),
	);
	const service = new PlayerDirectoryService(
		repository,
		lookup,
		(value) => {
			directory.value = value;
		},
		undefined,
		(directoryRevision) => {
			try {
				nodecg.sendMessage(eventMessageName("directoryChanged"), {
					directoryRevision,
				});
			} catch (error) {
				nodecg.log.warn("Directory notification failed", error);
			}
		},
		(error) => nodecg.log.error("Player Directory read failed", error),
	);
	const racetime = new RaceTimeClient();
	const registrations = new RegistrationService(
		service,
		racetime,
		lookup,
		(event, payload) => {
			try {
				nodecg.sendMessage("player-manager.v3." + event, payload);
			} catch {
				nodecg.log.warn(
					"Registration notification failed; query getRegistration",
				);
			}
		},
	);
	const ready = service.reload().then(
		() => {
			status.value = {ready: true, error: null};
		},
		(error) => {
			status.value = {
				ready: false,
				error: error instanceof Error ? error.message : String(error),
			};
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
				case "initializeDirectory":
					value = await service.initializeDirectory(data["confirm"]);
					status.value = {ready: true, error: null};
					break;
				case "status":
					value = status.value;
					break;
				case "mutate":
					value = await service.mutate(data["operations"]);
					break;
				case "beginRegistration":
					value = await registrations.begin(
						data["input"],
						data["requiredAccounts"],
						data["createPlayerOnEmpty"] === true,
						data["target"],
					);
					break;
				case "getRegistration":
					value = registrations.get(
						text(data["registrationId"], "registrationId"),
					);
					break;
				case "resolveRegistration":
					value = await registrations.resolve(
						text(data["registrationId"], "registrationId"),
						data["input"],
					);
					break;
				case "assignRegistrationAccount":
					value = registrations.assign(
						text(data["registrationId"], "registrationId"),
						text(data["accountId"], "accountId"),
						text(data["ownerId"], "ownerId"),
					);
					break;
				case "setRegistrationAccountUsage":
					if (typeof data["use"] !== "boolean")
						throw new DirectoryError("invalid_input", "use must be a boolean");
					value = registrations.setAccountUsage(
						text(data["registrationId"], "registrationId"),
						text(data["accountId"], "accountId"),
						data["use"],
					);
					break;
				case "setRegistrationAccountPrimary":
					value = registrations.setAccountPrimary(
						text(data["registrationId"], "registrationId"),
						text(data["accountId"], "accountId"),
					);
					break;
				case "approveRegistrationConflict":
					value = registrations.approve(
						text(data["registrationId"], "registrationId"),
						text(data["conflictId"], "conflictId"),
					);
					break;
				case "selectRegistrationMergeSurvivor":
					value = registrations.merge(
						text(data["registrationId"], "registrationId"),
						text(data["survivorId"], "survivorId"),
					);
					break;
				case "setRegistrationMergeDecision":
					if (
						data["decision"] !== "keepSeparate" &&
						data["decision"] !== "undecided"
					)
						throw new DirectoryError("invalid_input", "Invalid merge decision");
					value = registrations.setMergeDecision(
						text(data["registrationId"], "registrationId"),
						data["decision"],
					);
					break;
				case "setRegistrationPlayerDeletion":
					value = registrations.setDelete(
						text(data["registrationId"], "registrationId"),
						text(data["playerId"], "playerId"),
						data["delete"] === true,
					);
					break;
				case "setRegistrationDisplayName":
					if (data["value"] !== null && typeof data["value"] !== "string")
						throw new DirectoryError(
							"invalid_input",
							"value must be a string or null",
						);
					value = registrations.setDisplayName(
						text(data["registrationId"], "registrationId"),
						data["value"] as string | null,
					);
					break;
				case "completeRegistration":
					value = await registrations.complete(
						text(data["registrationId"], "registrationId"),
					);
					break;
				case "cancelRegistration":
					value = registrations.cancel(
						text(data["registrationId"], "registrationId"),
					);
					break;
				case "searchIdentities": {
					const provider = text(data["provider"], "provider"),
						query = text(data["query"], "query", 2048);
					if (provider === "speedrunCom") {
						const found = await lookup.searchUsers(
							query,
							(data["mode"] ?? "name") as SearchMode,
						);
						value = {identities: found.users, hasMore: found.hasMore};
					} else if (provider === "racetime") {
						if (data["mode"] != null && data["mode"] !== "name")
							throw new DirectoryError(
								"unsupported_operation",
								"RaceTime supports name search only",
							);
						value = {
							identities: await racetime.searchUsers(query),
							hasMore: false,
						};
					} else
						throw new DirectoryError(
							"unsupported_operation",
							"Direct search is not available for this provider",
						);
					break;
				}
				case "getIdentity": {
					const provider = text(data["provider"], "provider"),
						reference = text(data["value"], "value", 2048);
					if (provider === "speedrunCom")
						value = await lookup.getUser(reference);
					else if (provider === "racetime")
						value = await racetime.getUser(reference);
					else
						throw new DirectoryError(
							"unsupported_operation",
							"Direct profile lookup is not available for this provider",
						);
					break;
				}
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
						!["racetime", "speedrunCom", "twitch", "youtube"].includes(provider)
					)
						throw new DirectoryError("invalid_input", "Unknown provider");
					value = service.find(
						`${provider}:${provider === "youtube" ? youtubeUrl(data["value"]) : provider === "twitch" ? login(data["value"]) : text(data["value"], "value")}`,
					);
					break;
				}
				case "findAccount":
					value = service.findAccount(text(data["accountId"], "accountId"));
					break;
				case "getAccountProfileUrl":
					value = await service.getAccountProfileUrl(
						text(data["accountId"], "accountId", 2048),
					);
					break;
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
					value = publicResolution(
						await resolveMatching({
							directory: service.snapshot(),
							input: matchingInput(data["input"]),
							requiredAccounts: requiredAccounts(data["requiredAccounts"]),
							racetime,
							src: lookup,
						}),
					);
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
					throw new DirectoryError(
						"unsupported_operation",
						"Unknown operation",
					);
			}
			return {ok: true, data: value as Operations[K]["response"]};
		} catch (error) {
			const known =
				error instanceof DirectoryError
					? error
					: new DirectoryError("directory_unavailable", "Operation failed");
			if (
				operation === "reload" ||
				(operation === "initializeDirectory" && !service.isLoaded())
			)
				status.value = {
					ready: service.isLoaded(),
					error: known.message,
				};
			nodecg.log.warn(`${operation}: ${known.message}`, error);
			return {ok: false, error: {code: known.code, message: known.message}};
		}
	}
	for (const operation of [
		"initializeDirectory",
		"status",
		"mutate",
		"searchIdentities",
		"getIdentity",
		"beginRegistration",
		"getRegistration",
		"resolveRegistration",
		"assignRegistrationAccount",
		"setRegistrationAccountUsage",
		"setRegistrationAccountPrimary",
		"approveRegistrationConflict",
		"selectRegistrationMergeSurvivor",
		"setRegistrationMergeDecision",
		"setRegistrationPlayerDeletion",
		"setRegistrationDisplayName",
		"completeRegistration",
		"cancelRegistration",
		"storage",
		"configureStorage",
		"list",
		"get",
		"find",
		"findAccount",
		"getAccountProfileUrl",
		"create",
		"update",
		"delete",
		"resolve",
		"reload",
		"searchUsers",
		"getUser",
	] as const) {
		nodecg.listenFor(`player-manager.v3.${operation}`, (data, ack) => {
			void request(operation, data).then((result) => {
				if (ack && !ack.handled) ack(null, result);
			});
		});
	}
	return {apiVersion: API_VERSION, ready, request};
}
