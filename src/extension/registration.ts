import {randomUUID} from "node:crypto";
import type {
	RegistrationResult,
	RegistrationSession,
	RequiredIdentity,
} from "@nanahuse/player-manager-protocol";
import {
	type IdentityResolutionInput,
	type Player,
} from "@nanahuse/player-manager-protocol";
import {DirectoryError, object, text} from "../domain/player.ts";
import type {CompleteRegistration} from "../protocol/index.ts";
import type {PlayerDirectoryService} from "./service.ts";
import {raceTimeId} from "./racetime.ts";
export function registrationInput(raw: unknown): IdentityResolutionInput {
	const v = object(raw);
	const result: IdentityResolutionInput = {};
	for (const provider of ["racetime", "speedrunCom"] as const) {
		if (v[provider] === null) result[provider] = null;
		else if (v[provider] !== undefined)
			result[provider] = {
				userId: text(object(v[provider])["userId"], provider + " userId", 2048),
			};
	}
	if (v["twitch"] === null) result.twitch = null;
	else if (v["twitch"] !== undefined) {
		const tw = object(v["twitch"]);
		result.twitch = {
			login: text(tw["login"], "Twitch login", 2048),
			...(tw["userId"] ? {userId: text(tw["userId"], "Twitch id")} : {}),
		};
	}
	if (v["youtube"] !== undefined)
		result.youtube =
			v["youtube"] === null ? null : text(v["youtube"], "YouTube", 2048);
	if (v["manualDisplayName"] !== undefined)
		result.manualDisplayName =
			v["manualDisplayName"] === null
				? null
				: text(v["manualDisplayName"], "display name");
	return result;
}
export class RegistrationService {
	private sessions = new Map<
		string,
		{value: RegistrationSession; expires: number; busy: boolean}
	>();
	constructor(
		private readonly players: PlayerDirectoryService,
		private readonly notify: (
			event: "registrationCompleted" | "registrationCancelled",
			payload: RegistrationResult | {registrationId: string},
		) => void,
		private readonly now = Date.now,
		private readonly ttl = 30 * 60 * 1000,
	) {}
	private cleanup() {
		for (const [id, s] of this.sessions) {
			if (!s.busy && this.now() > s.expires) {
				if (s.value.state === "pending") s.value.state = "expired";
				if (this.now() > s.expires + 60 * 60 * 1000) this.sessions.delete(id);
			}
		}
	}
	begin(raw: unknown, requiredRaw?: unknown) {
		this.cleanup();
		if (this.sessions.size >= 1000)
			throw new DirectoryError(
				"invalid_input",
				"Too many registration sessions",
			);
		const input = registrationInput(raw);
		let requiredIdentity: RequiredIdentity | undefined;
		if (requiredRaw !== undefined) {
			const required = object(requiredRaw);
			if (required["provider"] !== "racetime")
				throw new DirectoryError(
					"invalid_input",
					"Unsupported required identity provider",
				);
			requiredIdentity = {
				provider: "racetime",
				value: raceTimeId(required["value"]),
			};
			input.racetime = {userId: requiredIdentity.value};
		}
		const registrationId = randomUUID();
		this.sessions.set(registrationId, {
			value: {
				registrationId,
				state: "pending",
				input,
				...(requiredIdentity ? {requiredIdentity} : {}),
				resolution: null,
				result: null,
			},
			expires: this.now() + this.ttl,
			busy: false,
		});
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
		const s = this.sessions.get(id);
		if (!s)
			throw new DirectoryError(
				"registration_not_found",
				"Registration session not found",
			);
		if (s.value.state === "expired")
			throw new DirectoryError(
				"registration_expired",
				"Registration session expired",
			);
		if (s.value.state !== "pending" || s.busy)
			throw new DirectoryError(
				"invalid_input",
				"Registration session is not pending or is busy",
			);
		return s;
	}
	async resolve(id: string, raw: unknown) {
		const s = this.pending(id);
		s.busy = true;
		try {
			s.value.input = registrationInput(raw);
			if (s.value.requiredIdentity?.provider === "racetime")
				s.value.input.racetime = {
					userId: s.value.requiredIdentity.value,
				};
			s.value.resolution = null;
			s.value.resolution = await this.players.resolveIdentity(s.value.input);
			return structuredClone(s.value);
		} finally {
			s.busy = false;
		}
	}
	async complete(
		id: string,
		request: CompleteRegistration,
	): Promise<RegistrationResult> {
		const existing = this.get(id);
		if (existing?.state === "completed") return existing.result!;
		const s = this.pending(id);
		s.busy = true;
		try {
			if (s.value.resolution?.status === "conflict")
				throw new DirectoryError(
					"identity_conflict",
					"Correct conflicting identities and resolve again before completing",
				);
			if (
				s.value.resolution?.status === "ambiguous" &&
				request.action !== "existing"
			)
				throw new DirectoryError(
					"invalid_input",
					"Select an identity candidate or correct the input and resolve again before creating or updating",
				);
			let player: Player | null;
			const requiredIdentity = s.value.requiredIdentity;
			if (request.action === "existing") {
				const found = this.players.getPlayer(
					text(request.playerId, "playerId"),
				);
				if (!found)
					throw new DirectoryError("player_not_found", "Player not found");
				if (
					requiredIdentity &&
					request.revision !== undefined &&
					found.revision !== request.revision
				)
					throw new DirectoryError(
						"player_changed",
						"Player changed; select it again before editing",
					);
				player = found;
			} else if (request.action === "created") {
				if (requiredIdentity) player = null;
				else player = await this.players.createPlayer(request.input);
			} else if (request.action === "updated") {
				if (requiredIdentity) {
					player = this.players.getPlayer(request.playerId)!;
					if (!player)
						throw new DirectoryError("player_not_found", "Player not found");
				} else
					player = await this.players.updatePlayer(
						request.playerId,
						request.revision,
						request.input,
					);
			} else
				throw new DirectoryError(
					"invalid_input",
					"Unknown registration action",
				);
			if (requiredIdentity?.provider === "racetime") {
				player = await this.completeRequiredRaceTime(
					requiredIdentity.value,
					request,
					request.action === "created" ? null : player,
				);
				if (player.racetime?.userId !== requiredIdentity.value)
					throw new DirectoryError(
						"identity_conflict",
						"The required RaceTime identity is not linked to this player",
					);
			}
			if (!player)
				throw new DirectoryError(
					"lookup_failed",
					"Registration did not produce a player",
				);
			const result: RegistrationResult = {
				registrationId: id,
				action: request.action,
				player,
			};
			s.value.result = result;
			s.value.state = "completed";
			this.notify("registrationCompleted", structuredClone(result));
			return structuredClone(result);
		} finally {
			s.busy = false;
		}
	}
	private async completeRequiredRaceTime(
		value: string,
		request: CompleteRegistration,
		target: Player | null,
	): Promise<Player> {
		const owner = this.players
			.snapshot()
			.players.find((player) => player.racetime?.userId === value);
		if (
			request.action === "existing" &&
			target &&
			target.racetime?.userId === value
		)
			return target;
		const toInput = (player: Player) => ({
			manualDisplayName: player.manualDisplayName,
			youtube: player.youtube,
			racetime: player.racetime ? {userId: player.racetime.userId} : null,
			speedrunCom: player.speedrunCom
				? {userId: player.speedrunCom.userId}
				: null,
			twitch: player.twitch ? {...player.twitch} : null,
		});
		const operations = [];
		if (owner && owner.playerId !== target?.playerId) {
			operations.push({
				type: "update" as const,
				ref: "required-identity-owner",
				playerId: owner.playerId,
				revision: owner.revision,
				input: {...toInput(owner), racetime: null},
			});
		}
		if (request.action === "created") {
			operations.push({
				type: "create" as const,
				ref: "registration-target",
				input: {...request.input, racetime: {userId: value}},
			});
		} else {
			if (!target)
				throw new DirectoryError("player_not_found", "Player not found");
			const input =
				request.action === "updated" ? request.input : toInput(target);
			operations.push({
				type: "update" as const,
				ref: "registration-target",
				playerId: target.playerId,
				revision:
					request.action === "updated" ? request.revision : target.revision,
				input: {...input, racetime: {userId: value}},
			});
		}
		const committed = await this.players.mutate(operations, {
			ref: "registration-target",
			value,
		});
		const result = committed.results.find(
			(item) => item.ref === "registration-target" && "player" in item,
		);
		if (!result || !("player" in result))
			throw new DirectoryError(
				"persistence_failed",
				"Could not link the required RaceTime identity",
			);
		return result.player;
	}
	cancel(id: string) {
		const current = this.get(id);
		if (current?.state === "cancelled") return current;
		const s = this.pending(id);
		s.value.state = "cancelled";
		this.notify("registrationCancelled", {registrationId: id});
		return structuredClone(s.value);
	}
}
