import type {
	Player,
	StoredPlayerInput,
} from "@nanahuse/player-manager-protocol";
import {DirectoryError} from "../domain/player.ts";
import type {Resolution} from "./model.ts";

export type CommitPlan = {
	expectedRevisions: {playerId: string; revision: number}[];
	creates: {input: StoredPlayerInput}[];
	updates: {playerId: string; revision: number; input: StoredPlayerInput}[];
	deletes: {playerId: string; revision: number}[];
};

export function buildCommitPlan(resolution: Resolution): CommitPlan {
	if (resolution.conflicts.some((conflict) => conflict.status !== "resolved"))
		throw new DirectoryError(
			"identity_conflict",
			"Unresolved conflicts remain",
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
	if (resolution.mergeProposal)
		throw new DirectoryError(
			"invalid_input",
			"Choose a merge survivor before completing",
		);
	const owners = new Set(resolution.players.map((player) => player.id));
	const assignmentByAccount = new Map(
		resolution.assignments.map((assignment) => [
			assignment.accountId,
			assignment.ownerId,
		]),
	);
	const unresolvedCandidates = resolution.candidates.filter((candidate) => {
		const assignment = resolution.assignments.find(
			(entry) => entry.accountId === candidate.originAccountId,
		);
		return Boolean(assignment && assignment.source !== "user");
	});
	if (unresolvedCandidates.length)
		throw new DirectoryError(
			"invalid_input",
			"Assign the related account explicitly to resolve search candidates",
		);
	if (
		resolution.accounts.some((account) => !assignmentByAccount.has(account.id))
	)
		throw new DirectoryError(
			"invalid_input",
			"Every account must have an assignment",
		);
	for (const ownerId of assignmentByAccount.values())
		if (!owners.has(ownerId))
			throw new DirectoryError(
				"invalid_input",
				"Account assignment refers to an unknown player",
			);
	const assigned = (ownerId: string) =>
		resolution.accounts.filter(
			(account) => assignmentByAccount.get(account.id) === ownerId,
		);
	for (const ownerId of owners)
		for (const service of [
			"racetime",
			"speedrunCom",
			"twitch",
			"youtube",
		] as const)
			if (
				assigned(ownerId).filter((account) => account.service === service)
					.length > 1
			)
				throw new DirectoryError(
					"identity_conflict",
					`${service} supports one account per player in Directory`,
				);
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
	const inputFor = (ownerId: string): StoredPlayerInput => {
		const player = existingById.get(ownerId);
		const accounts = assigned(ownerId);
		const account = (service: (typeof accounts)[number]["service"]) =>
			accounts.find((item) => item.service === service);
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
		const manualDisplayName = player
			? player.manualDisplayName
			: (resolution.input.manualDisplayName ?? null);
		return {
			manualDisplayName,
			racetime: provider(rt, "racetime"),
			speedrunCom: provider(src, "speedrunCom"),
			twitch: twitch
				? {
						userId:
							twitch.keys
								.find((key) => key.startsWith("twitch-id:"))
								?.slice("twitch-id:".length) ?? null,
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
		if (
			!assigned(player.playerId).length &&
			!player.racetime &&
			!player.speedrunCom &&
			!player.twitch &&
			!player.youtube
		)
			continue;
		const input = inputFor(player.playerId);
		const previous: StoredPlayerInput = {
			manualDisplayName: player.manualDisplayName,
			racetime: player.racetime,
			speedrunCom: player.speedrunCom,
			twitch: player.twitch,
			youtube: player.youtube,
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
		creates.push({input: inputFor(newPlayer.id)});
	return {expectedRevisions, creates, updates, deletes};
}

export function publicResolution(
	resolution: Resolution,
): Omit<Resolution, "context"> {
	const {context: _context, ...result} = resolution;
	return structuredClone(result);
}

export type ResolutionCommitResult = {
	directoryRevision: number;
	players: Player[];
	deletedPlayerIds: string[];
};
