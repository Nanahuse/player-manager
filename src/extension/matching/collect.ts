import {randomUUID} from "node:crypto";
import type {
	Directory,
	Player,
	ProviderIdentity,
} from "@nanahuse/player-manager-protocol";
import {login, speedrunReference, youtubeUrl} from "../../domain/player.ts";
import {
	components,
	dedupeAccounts,
	dedupeEvidence,
} from "../../matching/graph.ts";
import type {
	Account,
	AccountService,
	Candidate,
	Collection,
	EvidenceSet,
	MatchingInput,
	RequiredAccount,
	Warning,
} from "../../matching/model.ts";
import {type RaceTimeLookup, raceTimeId} from "../racetime.ts";
import type {UserLookup} from "../speedrun.ts";

export type MatchingCollectorOptions = {
	directory: Directory;
	input: MatchingInput;
	racetime: RaceTimeLookup;
	src: UserLookup;
	requiredAccounts?: RequiredAccount[];
};
type Builder = {
	accounts: Account[];
	evidence: EvidenceSet[];
	inputAccountIds: string[];
};
function put(
	builder: Builder,
	service: AccountService,
	keys: string[],
	input = false,
	profile?: Partial<ProviderIdentity>,
): string {
	const canonical = keys[0]!;
	const id = canonical;
	builder.accounts.push({id, service, keys, ...(profile ? {profile} : {})});
	if (input) builder.inputAccountIds.push(id);
	return id;
}
function playerEvidence(
	player: Player,
	builder: Builder,
	source: "user" | "input",
): string[] {
	const ids: string[] = [];
	if (player.racetime)
		ids.push(
			put(
				builder,
				"racetime",
				[`racetime:${raceTimeId(player.racetime.userId)}`],
				false,
				{
					userId: player.racetime.userId,
					name: player.racetime.name,
					twitchLogin: player.twitch?.login ?? null,
				},
			),
		);
	if (player.speedrunCom)
		ids.push(
			put(
				builder,
				"speedrunCom",
				[`speedrunCom:${speedrunReference(player.speedrunCom.userId)}`],
				false,
				{
					userId: player.speedrunCom.userId,
					name: player.speedrunCom.name,
					...(player.speedrunCom.weblink
						? {weblink: player.speedrunCom.weblink}
						: {}),
					twitchLogin: player.twitch?.login ?? null,
				},
			),
		);
	if (player.twitch) {
		const keys = [
			player.twitch.userId && `twitch-id:${player.twitch.userId}`,
			`twitch:${login(player.twitch.login)}`,
		].filter((key): key is string => Boolean(key));
		ids.push(
			put(builder, "twitch", keys, false, {
				userId: player.twitch.userId ?? undefined,
				name: player.twitch.displayName ?? player.twitch.login,
				twitchLogin: player.twitch.login,
				twitchDisplayName: player.twitch.displayName,
			}),
		);
	}
	if (player.youtube)
		ids.push(
			put(builder, "youtube", [`youtube:${youtubeUrl(player.youtube)}`]),
		);
	if (ids.length > 0) builder.evidence.push({id: "", source, accounts: ids});
	return ids;
}
function profileEvidence(
	profile: ProviderIdentity,
	service: "racetime" | "speedrunCom",
	builder: Builder,
	source: "racetime" | "src",
	inputIds: string[] = [],
): string[] {
	const ids = [
		put(
			builder,
			service,
			[
				service === "racetime"
					? `racetime:${raceTimeId(profile.userId)}`
					: `speedrunCom:${speedrunReference(profile.userId)}`,
			],
			false,
			profile,
		),
	];
	if (profile.twitchLogin)
		ids.push(put(builder, "twitch", [`twitch:${login(profile.twitchLogin)}`]));
	if (profile.youtube)
		ids.push(
			put(builder, "youtube", [`youtube:${youtubeUrl(profile.youtube)}`]),
		);
	builder.evidence.push({id: "", source, accounts: [...ids, ...inputIds]});
	return ids;
}
function addDirectory(directory: Directory, builder: Builder) {
	for (const player of directory.players)
		playerEvidence(player, builder, "user");
}

export async function collectMatching(
	options: MatchingCollectorOptions,
): Promise<Collection> {
	const {directory, input, racetime, src} = options;
	const builder: Builder = {accounts: [], evidence: [], inputAccountIds: []};
	const warnings: Warning[] = [],
		errors: string[] = [],
		candidates: Candidate[] = [],
		profiles: ProviderIdentity[] = [];
	addDirectory(directory, builder);
	const inputIds: string[] = [],
		seedKeys: string[] = [];
	try {
		const addSeed = (service: AccountService, keys: string[]) => {
			seedKeys.push(...keys);
			inputIds.push(put(builder, service, keys, true));
		};
		if (input.racetime)
			addSeed("racetime", [`racetime:${raceTimeId(input.racetime)}`]);
		if (input.speedrunCom)
			addSeed("speedrunCom", [
				`speedrunCom:${speedrunReference(input.speedrunCom)}`,
			]);
		if (input.twitch)
			addSeed(
				"twitch",
				[
					input.twitch.userId && `twitch-id:${input.twitch.userId}`,
					`twitch:${login(input.twitch.login)}`,
				].filter((key): key is string => Boolean(key)),
			);
		if (input.youtube)
			addSeed("youtube", [`youtube:${youtubeUrl(input.youtube)}`]);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	const requiredAccounts = options.requiredAccounts ?? [];
	for (const required of requiredAccounts) {
		try {
			const key =
				required.service === "racetime"
					? `racetime:${raceTimeId(required.value)}`
					: required.service === "speedrunCom"
						? `speedrunCom:${speedrunReference(required.value)}`
						: required.service === "twitch"
							? `twitch:${login(required.value)}`
							: `youtube:${youtubeUrl(required.value)}`;
			seedKeys.push(key);
			put(builder, required.service, [key], true);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (inputIds.length > 0)
		builder.evidence.push({id: "", source: "input", accounts: inputIds});
	const visitedProfiles = new Set<string>(),
		visitedSearches = new Set<string>();
	const candidateIds = new Set<string>();
	const canonicalize = () => {
		const accounts = dedupeAccounts(builder.accounts);
		const idByKey = new Map(
			accounts.flatMap((account) =>
				account.keys.map((key) => [key, account.id] as const),
			),
		);
		const idByOriginal = new Map(
			builder.accounts.map((account) => [
				account.id,
				idByKey.get(account.keys[0]!) ?? account.id,
			]),
		);
		const evidence = dedupeEvidence(
			builder.evidence.map((set) => ({
				...set,
				accounts: set.accounts.map((id) => idByOriginal.get(id) ?? id),
			})),
		);
		return {accounts, evidence, idByKey, idByOriginal};
	};
	const search = async (
		account: Account,
		mode: "twitch" | "lookup" | "racetime",
	) => {
		const queryKey = account.keys.find((key) =>
			mode === "twitch"
				? key.startsWith("twitch:")
				: mode === "lookup"
					? key.startsWith("youtube:")
					: key.startsWith("twitch:"),
		);
		if (!queryKey) return;
		const query = queryKey.slice(queryKey.indexOf(":") + 1);
		const source = mode === "racetime" ? "racetime" : "src";
		const visitKey = `${source}:${query}:${mode}`;
		if (visitedSearches.has(visitKey)) return;
		visitedSearches.add(visitKey);
		try {
			const found =
				mode === "racetime"
					? {users: await racetime.searchUsers(query), hasMore: false}
					: await src.searchUsers(query, mode);
			const key =
				mode === "twitch"
					? `twitch:${login(query)}`
					: mode === "lookup"
						? `youtube:${youtubeUrl(query)}`
						: `twitch:${login(query)}`;
			const matches = found.users.filter((profile) =>
				profileKeys(profile).includes(key),
			);
			const unique = matches.length === 1 && !found.hasMore;
			for (const profile of found.users) {
				const accepted = unique && matches[0] === profile;
				const candidateId = `${source}:${query}:${profile.userId}`;
				if (accepted) {
					profiles.push(profile);
					profileEvidence(
						profile,
						mode === "racetime" ? "racetime" : "speedrunCom",
						builder,
						source,
						[account.id],
					);
				} else if (!candidateIds.has(candidateId)) {
					candidateIds.add(candidateId);
					candidates.push({
						id: candidateId,
						service: mode === "racetime" ? "racetime" : "speedrunCom",
						profile,
						query,
					});
				}
			}
			if (found.hasMore)
				warnings.push({
					operation: `search ${source} ${query} (${mode})`,
					message:
						"More candidates are available than the search result limit.",
				});
		} catch (error) {
			warnings.push({
				operation: `search ${source} ${query} (${mode})`,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	};
	let changed = true;
	while (changed) {
		changed = false;
		const graph = canonicalize();
		const roots = graph.accounts.filter((account) =>
			account.keys.some((key) => seedKeys.includes(key)),
		);
		const reachableIds = new Set<string>();
		for (const group of components(graph.accounts, graph.evidence))
			if (group.some((id) => roots.some((root) => root.id === id)))
				for (const id of group) reachableIds.add(id);
		for (const account of graph.accounts.filter((item) =>
			reachableIds.has(item.id),
		)) {
			if (account.service === "racetime" || account.service === "speedrunCom") {
				const key = account.keys.find((item) =>
					item.startsWith(
						account.service === "racetime" ? "racetime:" : "speedrunCom:",
					),
				);
				if (key && !visitedProfiles.has(`${account.service}:${key}`)) {
					visitedProfiles.add(`${account.service}:${key}`);
					const explicit = account.keys.some((item) => seedKeys.includes(item));
					try {
						const value = key.slice(key.indexOf(":") + 1);
						const profile =
							account.service === "racetime"
								? await racetime.getUser(value)
								: await src.getUser(value);
						profiles.push(profile);
						profileEvidence(
							profile,
							account.service,
							builder,
							account.service === "racetime" ? "racetime" : "src",
							[account.id],
						);
					} catch (error) {
						const message = `${account.service} profile ${key}: ${error instanceof Error ? error.message : String(error)}`;
						if (explicit) errors.push(message);
						else
							warnings.push({
								operation: `get ${account.service} profile ${key}`,
								message,
							});
					}
				}
			} else if (account.service === "twitch") {
				await search(account, "twitch");
				await search(account, "racetime");
			} else if (account.service === "youtube") await search(account, "lookup");
		}
		const after = canonicalize();
		if (
			after.accounts.some(
				(account) =>
					!graph.accounts.some(
						(old) =>
							old.id === account.id && old.keys.length === account.keys.length,
					),
			) ||
			after.evidence.length !== graph.evidence.length
		)
			changed = true;
	}
	const finalGraph = canonicalize();
	const inputAccountIds = builder.inputAccountIds.map(
		(id) => finalGraph.idByOriginal.get(id) ?? finalGraph.idByKey.get(id) ?? id,
	);
	return {
		directory,
		input,
		accounts: finalGraph.accounts,
		evidence: finalGraph.evidence,
		profiles,
		candidates,
		warnings,
		errors,
		requiredAccounts,
		newPlayerId: `new:${randomUUID()}`,
		inputAccountIds,
	};
}
function profileKeys(profile: ProviderIdentity): string[] {
	return [
		...(profile.twitchLogin ? [`twitch:${login(profile.twitchLogin)}`] : []),
		...(profile.youtube ? [`youtube:${youtubeUrl(profile.youtube)}`] : []),
	];
}
