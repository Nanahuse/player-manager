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
	directoryAccountId,
	directoryAccountIdentityKeys,
	integer,
	knownProfileService,
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
			schemaVersion: 2,
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
			const deletedPlayerIds = plan.deletes.map((entry) => entry.playerId);
			const createdIds = new Map(
				plan.creates.map((create) => [create.ownerId, randomUUID()]),
			);
			const ownerId = (value: string) => createdIds.get(value) ?? value;
			const accountsByPlayer = new Map(
				current.players.map((player) => [
					player.playerId,
					[...(player.accounts ?? [])],
				]),
			);
			for (const id of createdIds.values()) accountsByPlayer.set(id, []);
			for (const move of plan.mergeMoves) {
				const source = accountsByPlayer.get(move.fromPlayerId);
				const target = accountsByPlayer.get(move.toPlayerId);
				if (!source || !target)
					throw new DirectoryError(
						"player_not_found",
						"Merge account owner is not part of this Directory",
					);
				accountsByPlayer.set(move.toPlayerId, [...target, ...source]);
				accountsByPlayer.set(move.fromPlayerId, []);
			}
			const removeAccount = (accountId: string) => {
				for (const [id, accounts] of accountsByPlayer)
					accountsByPlayer.set(
						id,
						accounts.filter((account) => account.id !== accountId),
					);
			};
			for (const accountId of plan.removeAccountIds) removeAccount(accountId);
			for (const change of plan.accountChanges) {
				const targetId = ownerId(change.ownerId);
				const target = accountsByPlayer.get(targetId);
				if (!target)
					throw new DirectoryError(
						"invalid_input",
						"Account assignment refers to an unknown Player",
					);
				const oldAccount = current.players
					.flatMap((player) => player.accounts ?? [])
					.find((account) => account.id === change.account.id);
				if (
					oldAccount &&
					directoryAccountIdentityKeys(oldAccount).sort().join("|") !==
						directoryAccountIdentityKeys(change.account).sort().join("|")
				)
					throw new DirectoryError(
						"identity_conflict",
						"Account identity cannot be replaced while retaining its Account ID",
					);
				removeAccount(change.account.id);
				accountsByPlayer.set(targetId, [
					...(accountsByPlayer.get(targetId) ?? []),
					change.account,
				]);
			}
			const updates = new Map(
				plan.updates.map((update) => [update.playerId, update]),
			);
			const next = new Map(
				current.players.map((player) => [player.playerId, player]),
			);
			for (const deletion of plan.deletes) next.delete(deletion.playerId);
			for (const [playerId, update] of updates) {
				const old = next.get(playerId);
				if (!old || old.revision !== update.revision)
					throw new DirectoryError(
						"player_changed",
						"Player changed after Resolution; resolve again before completing",
					);
				const prepared = compactPlayer({
					...old,
					manualDisplayName: update.input.manualDisplayName,
					accounts: accountsByPlayer.get(playerId) ?? [],
				});
				next.set(playerId, {
					...prepared,
					playerId,
					revision: old.revision + 1,
				});
			}
			for (const create of plan.creates) {
				const playerId = ownerId(create.ownerId);
				const prepared = compactPlayer({
					...create.input,
					accounts: accountsByPlayer.get(playerId) ?? [],
				});
				next.set(playerId, {...prepared, playerId, revision: 1});
			}
			const changed =
				plan.creates.length + plan.updates.length + plan.deletes.length > 0;
			if (changed) await this.commit([...next.values()]);
			const after = this.snapshot();
			const resultIds = new Set([
				...plan.expectedRevisions
					.map((entry) => entry.playerId)
					.filter((id) => !deletedPlayerIds.includes(id)),
				...createdIds.values(),
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
		alreadyKnown = false,
	): Promise<Record<string, unknown>> {
		const input = object(raw);
		if (alreadyKnown || input["racetime"] == null) return input;
		const account = object(input["racetime"]);
		const profile = await this.racetime.getUser(
			text(account["userId"], "RaceTime user ID or profile URL", 2048),
		);
		return {...input, racetime: profile};
	}

	private async prepare(raw: unknown, existing?: Player) {
		const supplied = object(raw);
		if (Object.hasOwn(supplied, "accounts"))
			throw new DirectoryError(
				"invalid_input",
				"accounts are managed through Registration; raw Account arrays are not accepted",
			);
		const lookupInput = {...supplied};
		let raceTimeAlreadyKnown = false;
		let speedrunAlreadyKnown = false;
		for (const service of ["racetime", "speedrunCom"] as const) {
			const field = supplied[service];
			if (field == null) continue;
			const requestedId =
				typeof field === "string" ? field : object(field)["userId"];
			const match = existing?.accounts?.find(
				(account) =>
					account.service === service &&
					typeof account.identity === "object" &&
					"userId" in account.identity &&
					account.identity.userId === requestedId,
			);
			if (match) {
				lookupInput[service] = match.identity;
				if (service === "racetime") raceTimeAlreadyKnown = true;
				else speedrunAlreadyKnown = true;
			}
		}
		const input = await this.hydrateRaceTime(lookupInput, raceTimeAlreadyKnown);
		if (input["speedrunCom"] != null && !speedrunAlreadyKnown)
			input["speedrunCom"] = await this.lookup.getUser(
				text(
					object(input["speedrunCom"])["userId"],
					"SRC user ID or URL",
					2048,
				),
			);
		let normalized = compactPlayer(input);
		const profileAccounts = supplied["profileAccounts"];
		if (profileAccounts !== undefined && !Array.isArray(profileAccounts))
			throw new DirectoryError(
				"invalid_input",
				"profileAccounts must be an array",
			);
		const customAccounts = (
			(profileAccounts as unknown[] | undefined) ?? []
		).map((value): DirectoryAccount => {
			const profileUrl = normalizeProfileUrl(value);
			const url = new URL(profileUrl);
			if (knownProfileService(url))
				throw new DirectoryError(
					"invalid_input",
					"既存サービスのプロフィールURLはRegistrationのMatchingを通してください",
				);
			return {
				id: directoryAccountId(url.hostname.toLowerCase(), profileUrl),
				service: url.hostname.toLowerCase(),
				role: "secondary",
				profileUrl,
				identity: profileUrl,
			};
		});
		const customGroups = new Map<string, DirectoryAccount[]>();
		for (const account of customAccounts)
			customGroups.set(account.service, [
				...(customGroups.get(account.service) ?? []),
				account,
			]);
		for (const group of customGroups.values())
			group.forEach((account, index) => {
				account.role = index === 0 ? "primary" : "secondary";
			});
		normalized = compactPlayer({
			...normalized,
			accounts: [...(normalized.accounts ?? []), ...customAccounts],
		});
		return normalized;
	}
	private requireRegistrationForKnownCreate(raw: unknown): void {
		const input = object(raw);
		if (
			(["racetime", "speedrunCom", "twitch", "youtube"] as const).some(
				(service) => input[service] != null,
			)
		)
			throw new DirectoryError(
				"invalid_input",
				"既存サービスAccountの新規登録にはRegistrationのMatchingを使用してください",
			);
	}
	private preserveAccounts(
		old: Player | null,
		raw: unknown,
		prepared: StoredPlayerInput,
	): StoredPlayerInput {
		const input = object(raw);
		const previous = old?.accounts ?? [];
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
				(id) => !previous.some((account) => account.id === id),
			)
		)
			throw new DirectoryError(
				"invalid_input",
				"Cannot remove an account that is not owned by this Player",
			);
		const removalIds = new Set(removedIds);
		for (const [field, service] of [
			["racetime", "racetime"],
			["speedrunCom", "speedrunCom"],
			["twitch", "twitch"],
			["youtube", "youtube"],
		] as const)
			if (Object.hasOwn(input, field) && input[field] === null) {
				const primary = previous.find(
					(account) =>
						account.service === service && account.role === "primary",
				);
				if (primary) removalIds.add(primary.id);
			}
		const merged = previous.filter((account) => !removalIds.has(account.id));
		const knownServices = new Set([
			"racetime",
			"speedrunCom",
			"twitch",
			"youtube",
		]);
		const legacyPrimaryIds = new Map<string, string>();
		for (const service of knownServices) {
			if (!Object.hasOwn(input, service) || input[service] == null) continue;
			const candidate = (prepared.accounts ?? []).find(
				(account) => account.service === service,
			);
			const matched = candidate
				? previous.find(
						(account) =>
							account.service === service &&
							directoryAccountIdentityKeys(account).some((key) =>
								directoryAccountIdentityKeys(candidate).includes(key),
							),
					)
				: undefined;
			if (!matched)
				throw new DirectoryError(
					"invalid_input",
					"新しい既存サービスAccountはRegistrationのMatchingを通してください",
				);
			if (!removalIds.has(matched.id))
				legacyPrimaryIds.set(service, matched.id);
		}
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
		for (const account of prepared.accounts ?? []) {
			if (knownServices.has(account.service)) continue;
			const keys = directoryAccountIdentityKeys(account);
			const originalIdentity = previous.find(
				(prior) =>
					prior.service === account.service &&
					directoryAccountIdentityKeys(prior).some((key) => keys.includes(key)),
			);
			if (originalIdentity && removalIds.has(originalIdentity.id))
				throw new DirectoryError(
					"invalid_input",
					"同じAccountの削除と再登録は同時に指定できません",
				);
			const sameIdentity = merged.find(
				(prior) =>
					prior.service === account.service &&
					directoryAccountIdentityKeys(prior).some((key) => keys.includes(key)),
			);
			if (sameIdentity) continue;
			const sameId = merged.find((prior) => prior.id === account.id);
			if (sameId)
				throw new DirectoryError(
					"identity_conflict",
					`Account ID ${account.id} already belongs to a different identity`,
				);
			merged.push({...account, role: "secondary"});
		}
		const requested = (requestedPrimaries ?? {}) as Record<string, unknown>;
		const services = new Set([
			...merged.map((account) => account.service),
			...Object.keys(requested),
		]);
		const accounts: DirectoryAccount[] = [];
		for (const service of services) {
			const group = merged.filter((account) => account.service === service);
			const requestedId = requested[service];
			const selectedPrimary =
				typeof requestedId === "string"
					? group.find((account) => account.id === requestedId)
					: undefined;
			if (requestedId !== undefined && !selectedPrimary)
				throw new DirectoryError(
					"invalid_input",
					`Primary for ${service} must identify an Account owned by this Player`,
				);
			const oldPrimary = previous.find(
				(account) =>
					account.service === service &&
					account.role === "primary" &&
					group.some((entry) => entry.id === account.id),
			);
			const legacyPrimary = group.find(
				(account) => account.id === legacyPrimaryIds.get(service),
			);
			const preparedPrimary = group.find(
				(account) =>
					(prepared.accounts ?? []).some(
						(candidate) =>
							candidate.id === account.id &&
							candidate.service === service &&
							candidate.role === "primary",
					) && !previous.some((prior) => prior.id === account.id),
			);
			if (group.length === 0) continue;
			const nextPrimary =
				selectedPrimary ?? legacyPrimary ?? oldPrimary ?? preparedPrimary;
			if (!nextPrimary && group.length > 0)
				throw new DirectoryError(
					"identity_conflict",
					`Choose a Primary account for ${service} after removing or moving its previous Primary`,
				);
			if (nextPrimary)
				accounts.push(
					{...nextPrimary, role: "primary"},
					...group
						.filter((account) => account.id !== nextPrimary.id)
						.map((account) => ({...account, role: "secondary" as const})),
				);
		}
		return compactPlayer({
			...(old ?? prepared),
			manualDisplayName: Object.hasOwn(input, "manualDisplayName")
				? prepared.manualDisplayName
				: (old?.manualDisplayName ?? prepared.manualDisplayName),
			accounts,
		});
	}
	async createPlayer(raw: unknown): Promise<Player> {
		if (Object.hasOwn(object(raw), "playerId"))
			throw new DirectoryError(
				"invalid_input",
				"playerId is generated by Player Manager",
			);
		this.requireRegistrationForKnownCreate(raw);
		const input = await this.prepare(raw);
		const accounts = this.preserveAccounts(null, raw, input);
		return this.serialized(async () => {
			const player = {...accounts, playerId: randomUUID(), revision: 1};
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
		const old = this.expected(id, revision);
		const input = await this.prepare(raw, old);
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
				this.requireRegistrationForKnownCreate(op["input"]);
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
			operations.map((op) => {
				if (op.type === "delete") return null;
				const existing =
					op.type === "update"
						? this.expected(op.playerId, op.revision)
						: undefined;
				return this.prepare(op.input, existing);
			}),
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
							: this.preserveAccounts(null, op.input, prepared[i]!);
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
