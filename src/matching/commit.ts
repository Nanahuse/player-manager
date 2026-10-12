import type {
	DirectoryAccount,
	Player,
	StoredPlayerInput,
} from "@nanahuse/player-manager-protocol";
import {DirectoryError, directoryAccountId} from "../domain/player.ts";
import type {Resolution} from "./model.ts";

export type CommitPlan = {
	expectedRevisions: {playerId: string; revision: number}[];
	creates: {ownerId: string; input: StoredPlayerInput}[];
	updates: {playerId: string; revision: number; input: StoredPlayerInput}[];
	deletes: {playerId: string; revision: number}[];
	accountChanges: {ownerId: string; account: DirectoryAccount}[];
	removeAccountIds: string[];
	mergeMoves: {fromPlayerId: string; toPlayerId: string}[];
};

export function buildCommitPlan(resolution: Resolution): CommitPlan {
	if (resolution.conflicts.some((conflict) => conflict.status !== "resolved"))
		throw new DirectoryError(
			"identity_conflict",
			"Unresolved conflicts remain",
		);
	if (resolution.roleConflicts?.length)
		throw new DirectoryError(
			"identity_conflict",
			"Account Primary roles must be resolved",
		);
	if (resolution.requiredStatus.some((required) => !required.satisfied))
		throw new DirectoryError(
			"invalid_input",
			"Required accounts are not satisfied",
		);
	if (resolution.errors.length)
		throw new DirectoryError(
			"lookup_failed",
			"Explicit account lookups failed",
		);
	if (resolution.mergeProposal && resolution.mergeDecision !== "keepSeparate")
		throw new DirectoryError(
			"invalid_input",
			"Choose a merge survivor before completing",
		);
	const activeAccounts = resolution.accounts.filter(
		(account) => !resolution.discardedAccountIds.includes(account.id),
	);
	const activeAccountIds = new Set(activeAccounts.map((account) => account.id));
	const activeAssignments = resolution.assignments.filter((assignment) =>
		activeAccountIds.has(assignment.accountId),
	);
	const owners = new Set(resolution.players.map((player) => player.id));
	const assignmentByAccount = new Map(
		activeAssignments.map((assignment) => [assignment.accountId, assignment]),
	);
	const unresolvedCandidates = resolution.candidates.filter((candidate) => {
		return !resolution.confirmedCandidateAccountIds.includes(
			candidate.originAccountId,
		);
	});
	if (unresolvedCandidates.length)
		throw new DirectoryError(
			"invalid_input",
			"Assign the related account explicitly to resolve search candidates",
		);
	if (activeAccounts.some((account) => !assignmentByAccount.has(account.id)))
		throw new DirectoryError(
			"invalid_input",
			"Every account must have an assignment",
		);
	for (const assignment of assignmentByAccount.values())
		if (!owners.has(assignment.ownerId))
			throw new DirectoryError(
				"invalid_input",
				"Account assignment refers to an unknown player",
			);
	const assigned = (ownerId: string) =>
		activeAccounts.filter(
			(account) => assignmentByAccount.get(account.id)?.ownerId === ownerId,
		);
	for (const ownerId of owners)
		for (const service of new Set(
			activeAccounts.map((account) => account.service),
		)) {
			const accounts = assigned(ownerId).filter(
				(account) => account.service === service,
			);
			if (
				accounts.length &&
				accounts.filter(
					(account) => assignmentByAccount.get(account.id)?.role === "primary",
				).length !== 1
			)
				throw new DirectoryError(
					"identity_conflict",
					`${service} must have exactly one Primary account`,
				);
		}
	const existingPlayers = resolution.players.flatMap((player) =>
		player.kind === "existing" ? [player.player] : [],
	);
	const existingById = new Map(
		existingPlayers.map((player) => [player.playerId, player]),
	);
	const deleteIds = new Set([
		...resolution.deletePlayerIds,
		...(resolution.mergeAssessment?.absorbedPlayerIds ?? []),
	]);
	if (
		resolution.choices.displayNameChange &&
		resolution.mergeAssessment?.absorbedPlayerIds.includes(
			resolution.choices.displayNameChange.playerId,
		)
	)
		throw new DirectoryError(
			"identity_conflict",
			"The edited Player is absorbed by a merge; confirm the display name on the survivor.",
		);
	for (const id of deleteIds) {
		if (!existingById.has(id))
			throw new DirectoryError(
				"player_not_found",
				"Delete target is not part of this Resolution",
			);
		if (assigned(id).length)
			throw new DirectoryError(
				"invalid_input",
				"Reassign or remove accounts before deleting a Player",
			);
	}
	const accountChanges: CommitPlan["accountChanges"] = [];
	const inputFor = (ownerId: string): StoredPlayerInput => {
		const player = existingById.get(ownerId);
		const accounts = assigned(ownerId);
		const account = (service: (typeof accounts)[number]["service"]) =>
			accounts.find(
				(item) =>
					item.service === service &&
					assignmentByAccount.get(item.id)?.role === "primary",
			);
		const rt = account("racetime"),
			src = account("speedrunCom"),
			twitch = account("twitch"),
			youtube = account("youtube");
		const provider = (item: typeof rt, service: "racetime" | "speedrunCom") => {
			if (!item) return null;
			const userId =
				item.profile?.userId ??
				item.keys
					.find((key) => key.startsWith(`${service}:`))
					?.slice(service.length + 1);
			const name = item.profile?.name;
			if (!userId || !name)
				throw new DirectoryError(
					"invalid_input",
					`Missing ${service} profile metadata`,
				);
			return {
				userId,
				name,
				...(service === "speedrunCom" && item.profile?.weblink
					? {weblink: item.profile.weblink}
					: {}),
			};
		};
		const twitchLogin =
			twitch?.keys
				.find((key) => key.startsWith("twitch:"))
				?.slice("twitch:".length) ?? twitch?.profile?.twitchLogin;
		if (twitch && !twitchLogin)
			throw new DirectoryError("invalid_input", "Twitch account needs a login");
		const displayNameChange = resolution.choices.displayNameChange;
		const manualDisplayName =
			displayNameChange?.playerId === ownerId
				? displayNameChange.value
				: player
					? player.manualDisplayName
					: (resolution.input.manualDisplayName ?? null);
		const storedAccounts: DirectoryAccount[] = accounts.map((item) => {
			const role = assignmentByAccount.get(item.id)?.role ?? "primary";
			const existingRecord = resolution.context.directory.players
				.flatMap((entry) => entry.accounts ?? [])
				.find((entry) => entry.id === item.id);
			const id =
				existingRecord?.id ??
				directoryAccountId(item.service, item.keys[0] ?? item.id);
			const relatedEvidence = [
				item.profile?.twitchLogin ? `twitch:${item.profile.twitchLogin}` : null,
				item.profile?.youtube ? `youtube:${item.profile.youtube}` : null,
			].filter((key): key is string => Boolean(key));
			const evidenceKeys = [
				...new Set([
					...(existingRecord?.evidenceKeys ?? []),
					...relatedEvidence,
				]),
			];
			const withEvidence = <T extends DirectoryAccount>(account: T): T =>
				evidenceKeys.length ? {...account, evidenceKeys} : account;
			if (item.service === "racetime" || item.service === "speedrunCom") {
				const userId =
					item.profile?.userId ??
					item.keys
						.find((key) => key.startsWith(`${item.service}:`))
						?.slice(item.service.length + 1);
				if (!userId || !item.profile?.name)
					throw new DirectoryError(
						"invalid_input",
						`Missing ${item.service} profile metadata`,
					);
				return withEvidence({
					id,
					service: item.service,
					role,
					identity: {
						userId,
						name: item.profile.name,
						...(item.service === "speedrunCom" && item.profile.weblink
							? {weblink: item.profile.weblink}
							: {}),
					},
				});
			}
			if (item.service === "twitch") {
				const twitchLogin =
					item.keys
						.find((key) => key.startsWith("twitch:"))
						?.slice("twitch:".length) ?? item.profile?.twitchLogin;
				if (!twitchLogin)
					throw new DirectoryError(
						"invalid_input",
						"Twitch account needs a login",
					);
				return withEvidence({
					id,
					service: item.service,
					role,
					identity: {
						login: twitchLogin,
						...(item.profile?.twitchDisplayName
							? {displayName: item.profile.twitchDisplayName}
							: {}),
					},
				});
			}
			if (item.service === "youtube") {
				const url = item.keys
					.find((key) => key.startsWith("youtube:"))
					?.slice("youtube:".length);
				if (!url)
					throw new DirectoryError(
						"invalid_input",
						"YouTube account needs a URL",
					);
				return withEvidence({id, service: item.service, role, identity: url});
			}
			const prefix = `url:${item.service}:`;
			const profileUrl = item.keys
				.find((key) => key.startsWith(prefix))
				?.slice(prefix.length);
			if (!profileUrl)
				throw new DirectoryError(
					"invalid_input",
					`Missing ${item.service} profile URL`,
				);
			return withEvidence({
				id,
				service: item.service,
				role,
				profileUrl,
				identity: profileUrl,
			});
		});
		accountChanges.push(
			...storedAccounts.map((account) => ({ownerId, account})),
		);
		return {
			manualDisplayName,
			racetime: provider(rt, "racetime"),
			speedrunCom: provider(src, "speedrunCom"),
			twitch: twitch
				? {
						login: twitchLogin!,
						...(twitch.profile?.twitchDisplayName
							? {displayName: twitch.profile.twitchDisplayName}
							: {}),
					}
				: null,
			youtube:
				youtube?.keys
					.find((key) => key.startsWith("youtube:"))
					?.slice("youtube:".length) ?? null,
			accounts: storedAccounts,
		};
	};
	const creates: CommitPlan["creates"] = [],
		updates: CommitPlan["updates"] = [],
		deletes: CommitPlan["deletes"] = [];
	const expectedRevisions = existingPlayers.map(({playerId, revision}) => ({
		playerId,
		revision,
	}));
	for (const player of existingPlayers) {
		if (deleteIds.has(player.playerId)) {
			deletes.push({playerId: player.playerId, revision: player.revision});
			continue;
		}
		const input = inputFor(player.playerId);
		const previous: StoredPlayerInput = {
			manualDisplayName: player.manualDisplayName,
			racetime: player.racetime,
			speedrunCom: player.speedrunCom,
			twitch: player.twitch,
			youtube: player.youtube,
			accounts: player.accounts ?? [],
		};
		if (JSON.stringify(input) !== JSON.stringify(previous))
			updates.push({
				playerId: player.playerId,
				revision: player.revision,
				input,
			});
	}
	const newPlayer = resolution.players.find((player) => player.kind === "new");
	if (newPlayer && resolution.newPlayerRequired)
		creates.push({ownerId: newPlayer.id, input: inputFor(newPlayer.id)});
	return {
		expectedRevisions,
		creates,
		updates,
		deletes,
		accountChanges,
		removeAccountIds: resolution.discardedAccountIds.filter((accountId) =>
			resolution.context.directory.players.some((player) =>
				player.accounts?.some((account) => account.id === accountId),
			),
		),
		mergeMoves: (resolution.mergeAssessment?.absorbedPlayerIds ?? []).map(
			(fromPlayerId) => ({
				fromPlayerId,
				toPlayerId: resolution.mergeAssessment!.survivorId,
			}),
		),
	};
}

export function publicResolution(
	resolution: Resolution,
): Omit<Resolution, "context" | "choices"> {
	const {context: _context, choices: _choices, ...result} = resolution;
	return structuredClone(result);
}

export type ResolutionCommitResult = {
	directoryRevision: number;
	players: Player[];
	deletedPlayerIds: string[];
};
