import {randomUUID} from "node:crypto";
import type {
	MatchingInput,
	RegistrationResult,
	RegistrationSession,
	RequiredAccount,
} from "@nanahuse/player-manager-protocol";
import {DirectoryError, object, text} from "../domain/player.ts";
import {
	analyze,
	approveConflict,
	assignAccount,
	assignMergeSurvivor,
	setAccountUsage,
	setPlayerDeletion,
} from "../matching/analyze.ts";
import {buildCommitPlan, publicResolution} from "../matching/commit.ts";
import type {Resolution} from "../matching/model.ts";
import {collectMatching} from "./matching/collect.ts";
import type {RaceTimeLookup} from "./racetime.ts";
import type {PlayerDirectoryService} from "./service.ts";
import type {UserLookup} from "./speedrun.ts";

export function matchingInput(raw: unknown): MatchingInput {
	const value = object(raw),
		result: MatchingInput = {};
	for (const service of ["racetime", "speedrunCom"] as const) {
		const item = value[service];
		if (item === null) result[service] = null;
		else if (item !== undefined)
			result[service] = text(
				typeof item === "string" ? item : object(item)["userId"],
				`${service} account`,
				2048,
			);
	}
	if (value["twitch"] === null) result.twitch = null;
	else if (value["twitch"] !== undefined) {
		const twitch =
			typeof value["twitch"] === "string"
				? {login: value["twitch"]}
				: object(value["twitch"]);
		result.twitch = {
			login: text(twitch["login"], "Twitch login", 2048),
			...(twitch["userId"]
				? {userId: text(twitch["userId"], "Twitch id")}
				: {}),
		};
	}
	if (value["youtube"] !== undefined)
		result.youtube =
			value["youtube"] === null
				? null
				: text(value["youtube"], "YouTube", 2048);
	if (value["manualDisplayName"] !== undefined)
		result.manualDisplayName =
			value["manualDisplayName"] === null
				? null
				: text(value["manualDisplayName"], "display name");
	return result;
}

export function requiredAccounts(raw: unknown): RequiredAccount[] {
	if (raw == null) return [];
	if (!Array.isArray(raw))
		throw new DirectoryError(
			"invalid_input",
			"requiredAccounts must be an array",
		);
	return raw.map((entry) => {
		const value = object(entry),
			service = value["service"];
		if (
			!["racetime", "speedrunCom", "twitch", "youtube"].includes(
				String(service),
			)
		)
			throw new DirectoryError(
				"invalid_input",
				"Unknown Required account service",
			);
		return {
			service: service as RequiredAccount["service"],
			value: text(value["value"], "Required account"),
		};
	});
}

type InternalSession = {
	value: RegistrationSession;
	resolution: Resolution | null;
	createPlayerOnEmpty: boolean;
	expires: number;
	busy: boolean;
};

export class RegistrationService {
	private sessions = new Map<string, InternalSession>();
	constructor(
		private readonly players: PlayerDirectoryService,
		private readonly racetime: RaceTimeLookup,
		private readonly src: UserLookup,
		private readonly notify: (
			event: "registrationCompleted" | "registrationCancelled",
			payload: RegistrationResult | {registrationId: string},
		) => void,
		private readonly now = Date.now,
		private readonly ttl = 30 * 60 * 1000,
	) {}
	private cleanup() {
		for (const [id, session] of this.sessions)
			if (!session.busy && this.now() > session.expires) {
				if (session.value.state === "pending") session.value.state = "expired";
				if (this.now() > session.expires + 60 * 60 * 1000)
					this.sessions.delete(id);
			}
	}
	private async match(
		input: MatchingInput,
		required: RequiredAccount[],
		createPlayerOnEmpty = false,
	): Promise<Resolution> {
		const collection = await collectMatching({
			directory: this.players.snapshot(),
			input,
			requiredAccounts: required,
			racetime: this.racetime,
			src: this.src,
		});
		collection.createPlayerOnEmpty = createPlayerOnEmpty;
		return analyze(collection, {createPlayerOnEmpty});
	}
	private updatePublic(session: InternalSession) {
		session.value.resolution = session.resolution
			? publicResolution(session.resolution)
			: null;
	}
	async begin(
		rawInput: unknown,
		rawRequired?: unknown,
		createPlayerOnEmpty = false,
	) {
		this.cleanup();
		if (this.sessions.size >= 1000)
			throw new DirectoryError(
				"invalid_input",
				"Too many registration sessions",
			);
		const input = matchingInput(rawInput),
			required = requiredAccounts(rawRequired),
			registrationId = randomUUID();
		const session: InternalSession = {
			value: {
				registrationId,
				state: "pending",
				input,
				requiredAccounts: required,
				resolution: null,
				result: null,
			},
			resolution: null,
			createPlayerOnEmpty,
			expires: this.now() + this.ttl,
			busy: true,
		};
		this.sessions.set(registrationId, session);
		try {
			session.resolution = await this.match(
				input,
				required,
				createPlayerOnEmpty,
			);
			this.updatePublic(session);
		} finally {
			session.busy = false;
		}
		return {
			registrationId,
			url: `/bundles/player-manager/dashboard/Registration.html?standalone=true&registrationId=${encodeURIComponent(registrationId)}`,
		};
	}
	get(id: string): RegistrationSession | null {
		this.cleanup();
		return structuredClone(this.sessions.get(id)?.value ?? null);
	}
	private pending(id: string) {
		this.cleanup();
		const session = this.sessions.get(id);
		if (!session)
			throw new DirectoryError(
				"registration_not_found",
				"Registration session not found",
			);
		if (session.value.state === "expired")
			throw new DirectoryError(
				"registration_expired",
				"Registration session expired",
			);
		if (session.value.state !== "pending" || session.busy)
			throw new DirectoryError(
				"invalid_input",
				"Registration session is not pending or is busy",
			);
		return session;
	}
	async resolve(id: string, rawInput: unknown) {
		const session = this.pending(id);
		session.busy = true;
		try {
			session.value.input = matchingInput(rawInput);
			session.resolution = await this.match(
				session.value.input,
				session.value.requiredAccounts,
				session.createPlayerOnEmpty,
			);
			this.updatePublic(session);
			return structuredClone(session.value);
		} finally {
			session.busy = false;
		}
	}
	private operate(
		id: string,
		operation: (resolution: Resolution) => Resolution,
	) {
		const session = this.pending(id);
		if (!session.resolution)
			throw new DirectoryError(
				"invalid_input",
				"Registration has no Resolution",
			);
		session.resolution = operation(session.resolution);
		this.updatePublic(session);
		return structuredClone(session.value);
	}
	assign(id: string, accountId: string, ownerId: string) {
		return this.operate(id, (resolution) =>
			assignAccount(resolution, accountId, ownerId),
		);
	}
	setAccountUsage(id: string, accountId: string, use: boolean) {
		return this.operate(id, (resolution) =>
			setAccountUsage(resolution, accountId, use),
		);
	}
	approve(id: string, conflictId: string) {
		return this.operate(id, (resolution) => {
			if (!resolution.conflicts.some((conflict) => conflict.id === conflictId))
				throw new DirectoryError("invalid_input", "Unknown conflict");
			return approveConflict(resolution, conflictId);
		});
	}
	merge(id: string, survivorId: string) {
		return this.operate(id, (resolution) =>
			assignMergeSurvivor(resolution, survivorId),
		);
	}
	setDelete(id: string, playerId: string, shouldDelete: boolean) {
		return this.operate(id, (resolution) =>
			setPlayerDeletion(resolution, playerId, shouldDelete),
		);
	}
	async complete(id: string): Promise<RegistrationResult> {
		const completed = this.get(id);
		if (completed?.state === "completed") return completed.result!;
		const session = this.pending(id);
		session.busy = true;
		try {
			if (!session.resolution)
				throw new DirectoryError(
					"invalid_input",
					"Resolve registration before completing",
				);
			const result = await this.players.commitResolution(
				buildCommitPlan(session.resolution),
			);
			const completedResult: RegistrationResult = {
				registrationId: id,
				...result,
			};
			session.value.result = completedResult;
			session.value.state = "completed";
			this.notify("registrationCompleted", structuredClone(completedResult));
			return structuredClone(completedResult);
		} finally {
			session.busy = false;
		}
	}
	cancel(id: string) {
		const current = this.get(id);
		if (current?.state === "cancelled") return current;
		const session = this.pending(id);
		session.value.state = "cancelled";
		this.notify("registrationCancelled", {registrationId: id});
		return structuredClone(session.value);
	}
}
