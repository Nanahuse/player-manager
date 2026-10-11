import {randomUUID} from "node:crypto";
import type {
	DirectoryAccount,
	StoredPlayerInput,
} from "@nanahuse/player-manager-protocol";
import {
	type Directory,
	type Mutation,
	type MutationResponse,
	type MutationResult,
	type Player,
} from "@nanahuse/player-manager-protocol";
import {
	compactPlayer,
	DirectoryError,
	integer,
	normalizeProfileUrl,
	object,
	primaryIdentityKeys,
	text,
	validateDirectory,
} from "../domain/player.ts";
import type {CommitPlan, ResolutionCommitResult} from "../matching/commit.ts";
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
		private readonly directoryChanged: (
			directoryRevision: number,
		) => void = () => {},
	) {}
	private publishDirectory(next: Directory): void {
		const changed =
			this.state !== null &&
			JSON.stringify(this.state) !== JSON.stringify(next);
		this.state = next;
		this.publish(structuredClone(next));
		if (changed) this.directoryChanged(next.revision);
	}
	private serialized<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => {});
		return result;
	}
	reload(): Promise<Directory> {
		return this.serialized(async () => {
			try {
				const next = validateDirectory(await this.repository.load());
				this.publishDirectory(next);
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
			this.publishDirectory(next);
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
			this.snapshot().players.find((p) =>
				primaryIdentityKeys(p).includes(key),
			) ?? null
		);
	}
	findAccount(
		accountId: string,
	): {player: Player; account: DirectoryAccount} | null {
		for (const player of this.snapshot().players) {
			const account = player.accounts?.find((entry) => entry.id === accountId);
			if (account) return {player, account};
		}
		return null;
	}
	private async commit(players: Player[]): Promise<void> {
		const next = validateDirectory({
			schemaVersion: 1,
			revision: this.snapshot().revision + 1,
			players,
		});
		try {
			await this.repository.save(next);
		} catch {
			throw new DirectoryError(
				"persistence_failed",
				"Could not save directory; no changes committed",
			);
		}
		this.publishDirectory(next);
	}
	commitResolution(plan: CommitPlan): Promise<ResolutionCommitResult> {
		return this.serialized(async () => {
			const current = this.snapshot();
			for (const expected of plan.expectedRevisions) {
				const player = current.players.find(
					(entry) => entry.playerId === expected.playerId,
				);
				if (!player || player.revision !== expected.revision)
					throw new DirectoryError(
						"player_changed",
						"Player changed after Resolution; resolve again before completing",
					);
			}
			const next = new Map(
				current.players.map((player) => [player.playerId, player]),
			);
			const deletedPlayerIds = plan.deletes.map((entry) => entry.playerId);
			for (const deletion of plan.deletes) next.delete(deletion.playerId);
			for (const update of plan.updates) {
				const old = next.get(update.playerId);
				if (!old || old.revision !== update.revision)
					throw new DirectoryError(
						"player_changed",
						"Player changed after Resolution; resolve again before completing",
					);
				next.set(update.playerId, {
					...update.input,
					playerId: old.playerId,
					revision: old.revision + 1,
				});
			}
			const createdIds: string[] = [];
			for (const create of plan.creates) {
				const playerId = randomUUID();
				createdIds.push(playerId);
				next.set(playerId, {...create.input, playerId, revision: 1});
			}
			const changed =
				plan.creates.length + plan.updates.length + plan.deletes.length > 0;
			if (changed) await this.commit([...next.values()]);
			const after = this.snapshot();
			const resultIds = new Set([
				...plan.expectedRevisions
					.map((entry) => entry.playerId)
					.filter((id) => !deletedPlayerIds.includes(id)),
				...createdIds,
			]);
			return {
				directoryRevision: after.revision,
				players: after.players.filter((player) =>
					resultIds.has(player.playerId),
				),
				deletedPlayerIds,
			};
		});
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

	private async prepare(raw: unknown) {
		const supplied = object(raw);
		const input = await this.hydrateRaceTime(raw);
		if (input["speedrunCom"] != null)
			input["speedrunCom"] = await this.lookup.getUser(
				text(
					object(input["speedrunCom"])["userId"],
					"SRC user ID or URL",
					2048,
				),
			);
		let normalized = compactPlayer(input);
		if (Array.isArray(supplied["accounts"])) return normalized;
		for (const [field, service] of [
			["racetime", "racetime"],
			["speedrunCom", "speedrunCom"],
			["twitch", "twitch"],
			["youtube", "youtube"],
		] as const) {
			if (Object.hasOwn(supplied, field) && supplied[field] === null) {
				const remaining = (normalized.accounts ?? []).filter(
					(account) =>
						account.service === service && account.role === "secondary",
				);
				const accounts = (normalized.accounts ?? []).filter(
					(account) => account.service !== service,
				);
				if (remaining.length)
					accounts.push(
						{...remaining[0]!, role: "primary"},
						...remaining.slice(1),
					);
				normalized = compactPlayer({...normalized, [field]: null, accounts});
			}
		}
		return normalized;
	}
	private preserveAccounts(
		old: Player,
		raw: unknown,
		prepared: StoredPlayerInput,
	): StoredPlayerInput {
		const input = object(raw);
		if (Array.isArray(input["accounts"])) return prepared;
		const removals = input["removeAccountIds"];
		if (
			removals !== undefined &&
			(!Array.isArray(removals) ||
				removals.some((id) => typeof id !== "string"))
		)
			throw new DirectoryError(
				"invalid_input",
				"removeAccountIds must be an array of account IDs",
			);
		const removedIds = new Set((removals as string[] | undefined) ?? []);
		if (
			[...removedIds].some(
				(id) => !(old.accounts ?? []).some((account) => account.id === id),
			)
		)
			throw new DirectoryError(
				"invalid_input",
				"Cannot remove an account that is not owned by this Player",
			);
		const existing = (old.accounts ?? []).filter(
			(account) => !removedIds.has(account.id),
		);
		const incoming = (prepared.accounts ?? []).filter(
			(account) => !removedIds.has(account.id),
		);
		const customUrls = input["profileAccounts"];
		if (customUrls !== undefined && !Array.isArray(customUrls))
			throw new DirectoryError(
				"invalid_input",
				"profileAccounts must be an array",
			);
		const customAccounts: DirectoryAccount[] = (
			(customUrls as unknown[] | undefined) ?? []
		).map((value) => {
			const profileUrl = normalizeProfileUrl(value);
			const host = new URL(profileUrl).hostname.toLowerCase();
			if (
				[
					"racetime.gg",
					"www.racetime.gg",
					"speedrun.com",
					"www.speedrun.com",
					"twitch.tv",
					"www.twitch.tv",
					"youtube.com",
					"www.youtube.com",
					"m.youtube.com",
				].includes(host)
			)
				throw new DirectoryError(
					"invalid_input",
					"このURLは対応サービスのMatching Engineから登録してください",
				);
			return {
				id: profileUrl,
				service: host,
				role: "secondary",
				profileUrl,
				identity: profileUrl,
			};
		});
		const requestedPrimaries = input["profilePrimaryByService"];
		if (
			requestedPrimaries !== undefined &&
			(!requestedPrimaries ||
				typeof requestedPrimaries !== "object" ||
				Array.isArray(requestedPrimaries))
		)
			throw new DirectoryError(
				"invalid_input",
				"profilePrimaryByService must be an object",
			);
		for (const service of new Set(
			customAccounts.map((account) => account.service),
		)) {
			const group = customAccounts.filter(
				(account) => account.service === service,
			);
			const previousPrimary = existing.find(
				(account) => account.service === service && account.role === "primary",
			);
			const requested = (
				requestedPrimaries as Record<string, unknown> | undefined
			)?.[service];
			const primary = requested
				? group.find((account) => account.id === requested)
				: (group.find((account) => account.id === previousPrimary?.id) ??
					group[0]);
			if (requested && !primary)
				throw new DirectoryError(
					"invalid_input",
					`Primary for ${service} must be one of its registered URLs`,
				);
			for (const account of group)
				account.role = account === primary ? "primary" : "secondary";
		}
		const knownServices = ["racetime", "speedrunCom", "twitch", "youtube"];
		const services = new Set([
			...existing.map((account) => account.service),
			...incoming.map((account) => account.service),
			...customAccounts.map((account) => account.service),
		]);
		const accounts: DirectoryAccount[] = [];
		for (const service of services) {
			if (!knownServices.includes(service) && customUrls !== undefined) {
				accounts.push(
					...customAccounts.filter((account) => account.service === service),
				);
				continue;
			}
			const oldGroup = existing.filter(
				(account) => account.service === service,
			);
			const newGroup = incoming.filter(
				(account) => account.service === service,
			);
			const replacingPrimary =
				knownServices.includes(service) &&
				Object.hasOwn(input, service) &&
				input[service] != null &&
				newGroup.some(
					(account) =>
						account.role === "primary" &&
						!oldGroup.some((prior) => prior.id === account.id),
				);
			const removingPrimary =
				knownServices.includes(service) &&
				Object.hasOwn(input, service) &&
				input[service] === null;
			const oldRetained = oldGroup.filter(
				(account) =>
					!newGroup.some((next) => next.id === account.id) &&
					!(
						(replacingPrimary || removingPrimary) &&
						account.role === "primary"
					),
			);
			const combined = [...newGroup, ...oldRetained];
			const requested = (
				requestedPrimaries as Record<string, unknown> | undefined
			)?.[service];
			const selectedPrimary =
				typeof requested === "string"
					? combined.find((account) => account.id === requested)
					: undefined;
			const cleared =
				knownServices.includes(service) &&
				Object.hasOwn(input, service) &&
				input[service] === null;
			const nextPrimary =
				selectedPrimary ??
				(cleared
					? combined.find((account) => account.role === "secondary")
					: undefined) ??
				combined.find((account) => account.role === "primary") ??
				combined[0];
			if (
				selectedPrimary &&
				!knownServices.includes(service) &&
				!customAccounts.some((account) => account.id === selectedPrimary.id)
			)
				throw new DirectoryError(
					"invalid_input",
					`Primary for ${service} must be a registered URL`,
				);
			if (nextPrimary)
				accounts.push(
					{...nextPrimary, role: "primary"},
					...combined
						.filter((account) => account.id !== nextPrimary.id)
						.map((account) => ({...account, role: "secondary" as const})),
				);
		}
		return compactPlayer({...prepared, accounts});
	}
	async createPlayer(raw: unknown): Promise<Player> {
		if (Object.hasOwn(object(raw), "playerId"))
			throw new DirectoryError(
				"invalid_input",
				"playerId is generated by Player Manager",
			);
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
			const preserved = this.preserveAccounts(old, raw, input);
			const player = {
				...preserved,
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
	async mutate(raw: unknown): Promise<MutationResponse> {
		if (!Array.isArray(raw) || raw.length > 100)
			throw new DirectoryError(
				"invalid_input",
				"operations must be an array of at most 100 mutations",
			);
		const refs = new Set<string>(),
			targets = new Set<string>();
		const operations = raw.map((v) => {
			const op = object(v);
			const ref = text(op["ref"], "ref");
			if (refs.has(ref))
				throw new DirectoryError("invalid_input", "Duplicate mutation ref");
			refs.add(ref);
			const type = op["type"];
			if (type !== "create" && type !== "update" && type !== "delete")
				throw new DirectoryError("invalid_input", "Unknown mutation type");
			if (type !== "delete") object(op["input"]);
			if (type === "create") {
				if (
					Object.hasOwn(op, "playerId") ||
					Object.hasOwn(object(op["input"]), "playerId")
				)
					throw new DirectoryError(
						"invalid_input",
						"playerId is generated by Player Manager",
					);
				return {type, ref, input: op["input"]} as Mutation;
			}
			const playerId = text(op["playerId"], "playerId"),
				revision = integer(op["revision"]);
			if (targets.has(playerId))
				throw new DirectoryError(
					"invalid_input",
					"A player may be mutated only once per request",
				);
			targets.add(playerId);
			return {...op, type, ref, playerId, revision} as Mutation;
		});
		const prepared = await Promise.all(
			operations.map((op) =>
				op.type === "delete" ? null : this.prepare(op.input),
			),
		);
		return this.serialized(async () => {
			const next = new Map(this.snapshot().players.map((p) => [p.playerId, p]));
			const results: MutationResult[] = [];
			for (const [i, op] of operations.entries()) {
				if (op.type !== "create") this.expected(op.playerId, op.revision);
				if (op.type === "delete") {
					next.delete(op.playerId);
					results.push({type: op.type, ref: op.ref, playerId: op.playerId});
				} else {
					const input =
						op.type === "update"
							? this.preserveAccounts(
									next.get(op.playerId)!,
									op.input,
									prepared[i]!,
								)
							: prepared[i]!;
					const player: Player = {
						...input,
						playerId: op.type === "create" ? randomUUID() : op.playerId,
						revision: op.type === "create" ? 1 : op.revision + 1,
					};
					next.set(player.playerId, player);
					results.push({type: op.type, ref: op.ref, player});
				}
			}
			if (operations.length) {
				const checked = validateDirectory({
					...this.snapshot(),
					players: [...next.values()],
				});
				await this.commit(checked.players);
			}
			return structuredClone({
				directoryRevision: this.snapshot().revision,
				results,
			});
		});
	}
}
