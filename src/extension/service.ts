import {randomUUID} from "node:crypto";
import {
	assertUnique,
	compactPlayer,
	type Directory,
	DirectoryError,
	identityKeys,
	integer,
	object,
	normalize,
	type Player,
	type PlayerInput,
	type Resolution,
	text,
	validateDirectory,
} from "../domain/player.ts";
import {RaceTimeClient, type RaceTimeLookup} from "./racetime.ts";
import type {Repository} from "./repository.ts";
import type {UserLookup} from "./speedrun.ts";

export class PlayerDirectoryService {
	private state: Directory | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly repository: Repository,
		private readonly lookup: UserLookup,
		private readonly publish: (state: Directory) => void = () => {},
		private readonly racetime: RaceTimeLookup = new RaceTimeClient(),
	) {}
	private serialized<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => {});
		return result;
	}
	reload(): Promise<Directory> {
		return this.serialized(async () => {
			try {
				const next = validateDirectory(await this.repository.load());
				this.state = next;
				this.publish(structuredClone(next));
				return this.snapshot();
			} catch {
				throw new DirectoryError(
					"directory_unavailable",
					"Directory could not be read; existing data was preserved",
				);
			}
		});
	}
	configureStorage(
		action: (current: Directory) => Promise<Directory>,
	): Promise<void> {
		return this.serialized(async () => {
			const next = validateDirectory(await action(this.snapshot()));
			this.state = next;
			this.publish(structuredClone(next));
		});
	}
	snapshot(): Directory {
		if (!this.state)
			throw new DirectoryError(
				"directory_unavailable",
				"Directory has not loaded",
			);
		return structuredClone(this.state);
	}
	getPlayer(id: string): Player | null {
		return (
			this.snapshot().players.find(
				(p) => p.playerId === text(id, "playerId"),
			) ?? null
		);
	}
	find(key: string): Player | null {
		return (
			this.snapshot().players.find((p) => identityKeys(p).includes(key)) ?? null
		);
	}
	private async commit(players: Player[]): Promise<void> {
		assertUnique(players);
		const next: Directory = {
			schemaVersion: 1,
			revision: this.snapshot().revision + 1,
			players,
		};
		try {
			await this.repository.save(next);
		} catch {
			throw new DirectoryError(
				"persistence_failed",
				"Could not save directory; no changes committed",
			);
		}
		this.state = next;
		this.publish(structuredClone(next));
	}
	private async hydrateRaceTime(
		raw: unknown,
	): Promise<Record<string, unknown>> {
		const input = object(raw);
		if (input["racetime"] == null) return input;
		const account = object(input["racetime"]);
		const profile = await this.racetime.getUser(
			text(account["userId"], "RaceTime user ID or profile URL", 2048),
		);
		return {...input, racetime: profile};
	}

	private async prepare(raw: unknown): Promise<PlayerInput> {
		const input = await this.hydrateRaceTime(raw);
		if (input["speedrunCom"] != null)
			input["speedrunCom"] = await this.lookup.getUser(
				text(
					object(input["speedrunCom"])["userId"],
					"SRC user ID or URL",
					2048,
				),
			);
		const normalized = compactPlayer(input);
		return normalized;
	}
	async createPlayer(raw: unknown): Promise<Player> {
		const input = await this.prepare(raw);
		return this.serialized(async () => {
			const player = {...input, playerId: randomUUID(), revision: 1};
			await this.commit([...this.snapshot().players, player]);
			return structuredClone(player);
		});
	}
	private expected(id: string, revision: number): Player {
		const p = this.getPlayer(id);
		if (!p) throw new DirectoryError("player_not_found", "Player not found");
		if (p.revision !== integer(revision))
			throw new DirectoryError(
				"player_changed",
				"Player changed; select it again before editing",
			);
		return p;
	}
	async updatePlayer(
		id: string,
		revision: number,
		raw: unknown,
	): Promise<Player> {
		this.expected(id, revision);
		const input = await this.prepare(raw);
		return this.serialized(async () => {
			const old = this.expected(id, revision);
			const player = {
				...input,
				playerId: old.playerId,
				revision: old.revision + 1,
			};
			await this.commit(
				this.snapshot().players.map((p) => (p.playerId === id ? player : p)),
			);
			return structuredClone(player);
		});
	}
	deletePlayer(id: string, revision: number): Promise<{playerId: string}> {
		return this.serialized(async () => {
			this.expected(id, revision);
			await this.commit(
				this.snapshot().players.filter((p) => p.playerId !== id),
			);
			return {playerId: id};
		});
	}
	async resolveIdentity(raw: unknown): Promise<Resolution> {
		const source = object(raw);
		let hydrated = await this.hydrateRaceTime(source);
		if (source["speedrunCom"] != null) {
			hydrated = {
				...hydrated,
				speedrunCom: await this.lookup.getUser(
					text(object(source["speedrunCom"])["userId"], "SRC userId", 2048),
				),
			};
		}
		let input: PlayerInput;
		try {
			input = normalize(hydrated);
		} catch (error) {
			if (
				!(error instanceof DirectoryError) ||
				error.code !== "identity_conflict"
			)
				throw error;
			return {
				status: "conflict",
				input: {
					manualDisplayName: null,
					racetime: null,
					speedrunCom: null,
					twitch: null,
				},
				playerId: null,
				candidates: [],
				message: error.message,
				warnings: [],
			};
		}
		const warnings: string[] = [];
		const candidates: string[] = [];
		let ambiguous = false;
		let playerId: string | null = null;
		const result = (
			status: Resolution["status"],
			message: string,
		): Resolution => ({status, input, playerId, candidates, warnings, message});
		const enrichDirectory = (): string | null => {
			const keys = identityKeys(input);
			const matches = this.snapshot().players.filter((p) =>
				identityKeys(p).some((key) => keys.includes(key)),
			);
			if (matches.length > 1) {
				candidates.push(...matches.map((p) => p.playerId));
				return "Identities belong to different players";
			}
			const match = matches[0];
			if (!match) return null;
			for (const provider of ["racetime", "speedrunCom", "twitch"] as const) {
				const old = match[provider],
					incoming = input[provider];
				if (old?.userId && incoming?.userId && old.userId !== incoming.userId)
					return `${provider} account disagrees with existing player`;
			}
			try {
				input = normalize({
					...match,
					...input,
					racetime: input.racetime ?? match.racetime,
					speedrunCom: input.speedrunCom ?? match.speedrunCom,
					twitch: input.twitch ?? match.twitch,
					youtube: input.youtube ?? match.youtube,
				});
			} catch (error) {
				return error instanceof Error ? error.message : "Identity conflict";
			}
			playerId = match.playerId;
			return null;
		};
		let conflict = enrichDirectory();
		if (conflict) return result("conflict", conflict);

		if (input.youtube && !input.speedrunCom) {
			try {
				const found = await this.lookup.searchUsers(input.youtube, "lookup");
				const exact = [
					...new Map(
						found.users
							.filter((u) => u.youtube === input.youtube)
							.map((u) => [u.userId, u]),
					).values(),
				];
				if (found.hasMore || exact.length > 1) {
					ambiguous = true;
					candidates.push(...exact.map((u) => "speedrunCom:" + u.userId));
					warnings.push(
						"YouTube matches multiple or incomplete Speedrun.com candidates",
					);
				} else if (exact[0]) {
					input.speedrunCom = exact[0];
					try {
						input = normalize(input);
					} catch (error) {
						return result(
							"conflict",
							error instanceof Error ? error.message : "Identity conflict",
						);
					}
				}
			} catch (error) {
				warnings.push(
					"YouTube lookup: " +
						(error instanceof Error ? error.message : "lookup failed"),
				);
			}
		}
		const twitchLogin =
			input.twitch?.login ??
			input.racetime?.twitchLogin ??
			input.speedrunCom?.twitchLogin;
		if (twitchLogin && !input.twitch)
			input.twitch = {userId: null, login: twitchLogin};
		if (twitchLogin) {
			if (!input.speedrunCom) {
				try {
					const found = await this.lookup.searchUsers(twitchLogin, "twitch");
					const exact = [
						...new Map(
							found.users
								.filter(
									(u) => u.twitchLogin?.trim().toLowerCase() === twitchLogin,
								)
								.map((u) => [u.userId, u]),
						).values(),
					];
					if (found.hasMore || exact.length > 1) {
						ambiguous = true;
						candidates.push(...exact.map((u) => `speedrunCom:${u.userId}`));
						warnings.push(
							"Speedrun.com candidates are ambiguous or incomplete",
						);
					} else if (exact[0]) input.speedrunCom = exact[0];
				} catch (error) {
					warnings.push(
						`Speedrun.com: ${error instanceof Error ? error.message : "lookup failed"}`,
					);
				}
			}
			if (!input.racetime) {
				const hints = [
					...new Set(
						[twitchLogin, input.speedrunCom?.name].filter((v): v is string =>
							Boolean(v),
						),
					),
				];
				const found = await Promise.allSettled(
					hints.map((hint) => this.racetime.searchUsers(hint)),
				);
				const users = found.flatMap((outcome) =>
					outcome.status === "fulfilled" ? outcome.value : [],
				);
				const exact = [
					...new Map(
						users
							.filter(
								(u) => u.twitchLogin?.trim().toLowerCase() === twitchLogin,
							)
							.map((u) => [u.userId, u]),
					).values(),
				];
				const failed = found.some((outcome) => outcome.status === "rejected");
				if (failed)
					warnings.push(
						"RaceTime search failed; other resolved accounts are retained",
					);
				if (exact.length > 1 || (failed && exact.length > 0)) {
					ambiguous = true;
					candidates.push(...exact.map((u) => `racetime:${u.userId}`));
				} else if (exact[0]) input.racetime = exact[0];
				else
					warnings.push(
						"RaceTime uses name search; an account with a different name may require its profile URL",
					);
			}
		}
		try {
			input = normalize(input);
		} catch (error) {
			return result(
				"conflict",
				error instanceof Error ? error.message : "Identity conflict",
			);
		}
		conflict = enrichDirectory();
		if (conflict) return result("conflict", conflict);
		if (
			input.twitch &&
			input.racetime?.twitchLogin === input.twitch.login &&
			input.racetime.twitchDisplayName
		)
			input.twitch = {
				...input.twitch,
				displayName: input.racetime.twitchDisplayName,
			};
		const count = [
			input.racetime,
			input.speedrunCom,
			input.twitch,
			input.youtube,
		].filter(Boolean).length;
		if (ambiguous)
			return result(
				"ambiguous",
				"Some candidates need manual selection; resolved accounts can be applied",
			);
		if (playerId || count > 1)
			return result(
				"matched",
				count === 4
					? "All available accounts resolved; review before saving"
					: "Available accounts resolved; review before saving",
			);
		return result(
			"unresolved",
			"No additional account could be resolved; the starting account is retained",
		);
	}
}
