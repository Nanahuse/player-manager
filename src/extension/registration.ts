import {randomUUID} from "node:crypto";
import {
	type IdentityResolutionInput,
	type Player,
} from "@nanahuse/player-manager-protocol";
import {DirectoryError, object, text} from "../domain/player.ts";
import type {
	RegistrationSession,
	RegistrationResult,
} from "@nanahuse/player-manager-protocol";
import type {CompleteRegistration} from "../protocol/index.ts";
import type {PlayerDirectoryService} from "./service.ts";
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
	begin(raw: unknown) {
		this.cleanup();
		if (this.sessions.size >= 1000)
			throw new DirectoryError(
				"invalid_input",
				"Too many registration sessions",
			);
		const input = registrationInput(raw);
		const registrationId = randomUUID();
		this.sessions.set(registrationId, {
			value: {
				registrationId,
				state: "pending",
				input,
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
			let player: Player;
			if (request.action === "existing") {
				const found = this.players.getPlayer(
					text(request.playerId, "playerId"),
				);
				if (!found)
					throw new DirectoryError("player_not_found", "Player not found");
				player = found;
			} else if (request.action === "created")
				player = await this.players.createPlayer(request.input);
			else if (request.action === "updated")
				player = await this.players.updatePlayer(
					request.playerId,
					request.revision,
					request.input,
				);
			else
				throw new DirectoryError(
					"invalid_input",
					"Unknown registration action",
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
	cancel(id: string) {
		const current = this.get(id);
		if (current?.state === "cancelled") return current;
		const s = this.pending(id);
		s.value.state = "cancelled";
		this.notify("registrationCancelled", {registrationId: id});
		return structuredClone(s.value);
	}
}
