import {randomUUID} from "node:crypto";
import type {
	Directory,
	Player,
	ProviderIdentity,
	RegistrationTarget,
} from "@nanahuse/player-manager-protocol";
import {
	directoryAccountIdentityKeys,
	knownProfileService,
	login,
	normalizeProfileUrl,
	speedrunReference,
	youtubeUrl,
} from "../../domain/player.ts";
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
	target?: RegistrationTarget;
	newPlayerId?: string;
};
type Builder = {
	accounts: Account[];
	evidence: EvidenceSet[];
	inputAccountIds: string[];
	seedAccountIds: string[];
	accountRoles: Record<string, "primary" | "secondary">;
};
function put(
	builder: Builder,
	service: AccountService,
	keys: string[],
	input = false,
	profile?: Partial<ProviderIdentity>,
	role?: "primary" | "secondary",
	accountId?: string,
): string {
	const canonical = keys[0]!;
	const id = accountId ?? canonical;
	builder.accounts.push({id, service, keys, ...(profile ? {profile} : {})});
	if (role) builder.accountRoles[id] = role;
	if (input) builder.inputAccountIds.push(id);
	return id;
}
function playerEvidence(
	player: Player,
	builder: Builder,
	source: "user" | "input",
): string[] {
	const ids: string[] = [];
	if (player.accounts?.length) {
		for (const stored of player.accounts) {
			let keys: string[] = [];
			let profile: Partial<ProviderIdentity> | undefined;
			if (stored.service === "racetime" || stored.service === "speedrunCom") {
				const identity = stored.identity as {
					userId: string;
					name: string;
					weblink?: string;
				};
				keys = [
					stored.service === "racetime"
						? `racetime:${raceTimeId(identity.userId)}`
						: `speedrunCom:${speedrunReference(identity.userId)}`,
				];
				profile = {
					userId: identity.userId,
					name: identity.name,
					...(identity.weblink ? {weblink: identity.weblink} : {}),
				};
			} else if (stored.service === "twitch") {
				const identity = stored.identity as {
					login?: string;
					displayName?: string;
				};
				keys = identity.login ? [`twitch:${login(identity.login)}`] : [];
				profile = {
					name: identity.login ?? "",
					twitchLogin: identity.login ?? null,
					twitchDisplayName: identity.displayName,
				};
			} else if (stored.service === "youtube") {
				keys = [`youtube:${youtubeUrl(String(stored.identity))}`];
			} else if (stored.profileUrl) {
				keys = [`url:${stored.service}:${stored.profileUrl}`];
			}
			if (keys.length) {
				const accountId = put(
					builder,
					stored.service,
					keys,
					false,
					profile,
					stored.role,
					stored.id,
				);
				ids.push(accountId);
				for (const link of stored.evidenceKeys ?? []) {
					const separator = link.indexOf(":");
					const service = link.slice(0, separator);
					if (service === "twitch") {
						const linkedAccount = player.accounts?.find(
							(account) =>
								account.service === service &&
								directoryAccountIdentityKeys(account).includes(link),
						);
						const linkedId = put(
							builder,
							"twitch",
							[link],
							false,
							undefined,
							linkedAccount?.role,
							linkedAccount?.id,
						);
						builder.evidence.push({
							id: "",
							source,
							accounts: [accountId, linkedId],
						});
					} else if (service === "youtube") {
						const linkedAccount = player.accounts?.find(
							(account) =>
								account.service === service &&
								directoryAccountIdentityKeys(account).includes(link),
						);
						const linkedId = put(
							builder,
							"youtube",
							[link],
							false,
							undefined,
							linkedAccount?.role,
							linkedAccount?.id,
						);
						builder.evidence.push({
							id: "",
							source,
							accounts: [accountId, linkedId],
						});
					}
				}
			}
		}
		return ids;
	}
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
		const keys = [`twitch:${login(player.twitch.login)}`];
		ids.push(
			put(builder, "twitch", keys, false, {
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
		ids.push(
			put(builder, "twitch", [`twitch:${login(profile.twitchLogin)}`], false, {
				name: profile.twitchDisplayName ?? profile.twitchLogin,
				twitchLogin: profile.twitchLogin,
				twitchDisplayName: profile.twitchDisplayName,
			}),
		);
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
	const builder: Builder = {
		accounts: [],
		evidence: [],
		inputAccountIds: [],
		seedAccountIds: [],
		accountRoles: {},
	};
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
			const id = put(builder, service, keys, true);
			inputIds.push(id);
			builder.seedAccountIds.push(id);
		};
		const addRequestSeed = (service: AccountService, keys: string[]) => {
			seedKeys.push(...keys);
			builder.seedAccountIds.push(put(builder, service, keys));
		};
		const addProfileUrl = (rawUrl: string, legacyInput: boolean) => {
			const add = legacyInput ? addSeed : addRequestSeed;
			const profileUrl = normalizeProfileUrl(rawUrl);
			const parsed = new URL(profileUrl);
			const service = knownProfileService(parsed);
			if (service === "racetime") {
				const match = /^\/user\/([a-zA-Z0-9]{1,100})\/?$/.exec(parsed.pathname);
				if (!match) throw new Error("Invalid RaceTime profile URL");
				add("racetime", [`racetime:${raceTimeId(match[1]!)}`]);
			} else if (service === "speedrunCom") {
				const match = /^\/users?\/([^/]+)\/?$/.exec(parsed.pathname);
				if (!match) throw new Error("Invalid Speedrun.com profile URL");
				add("speedrunCom", [
					`speedrunCom:${speedrunReference(decodeURIComponent(match[1]!))}`,
				]);
			} else if (service === "twitch") {
				const match = /^\/([a-zA-Z0-9_]+)\/?$/.exec(parsed.pathname);
				if (!match) throw new Error("Invalid Twitch profile URL");
				add("twitch", [`twitch:${login(match[1]!)}`]);
			} else if (service === "youtube") {
				add("youtube", [`youtube:${youtubeUrl(profileUrl)}`]);
			} else {
				const host = parsed.hostname.toLowerCase();
				const key = `url:${host}:${profileUrl}`;
				if (legacyInput) {
					const id = put(builder, host, [key]);
					seedKeys.push(key);
					builder.seedAccountIds.push(id);
				} else addRequestSeed(host, [key]);
			}
		};
		if (input.racetime)
			addSeed("racetime", [`racetime:${raceTimeId(input.racetime)}`]);
		if (input.speedrunCom)
			addSeed("speedrunCom", [
				`speedrunCom:${speedrunReference(input.speedrunCom)}`,
			]);
		if (input.twitch)
			addSeed("twitch", [`twitch:${login(input.twitch.login)}`]);
		if (input.youtube)
			addSeed("youtube", [`youtube:${youtubeUrl(input.youtube)}`]);
		for (const rawUrl of input.profileAccounts ?? [])
			addProfileUrl(rawUrl, true);
		for (const request of input.accountRequests ?? []) {
			const add = (service: AccountService, value: string) =>
				addRequestSeed(service, [value]);
			switch (request.service) {
				case "racetime":
					add("racetime", `racetime:${raceTimeId(request.value)}`);
					break;
				case "speedrunCom":
					add("speedrunCom", `speedrunCom:${speedrunReference(request.value)}`);
					break;
				case "twitch":
					add("twitch", `twitch:${login(request.value)}`);
					break;
				case "youtube":
					add("youtube", `youtube:${youtubeUrl(request.value)}`);
					break;
				case "profileUrl":
					addProfileUrl(request.value, false);
					break;
			}
		}
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
			builder.seedAccountIds.push(put(builder, required.service, [key]));
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
						originAccountId: account.id,
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
							account.service === "racetime" ? "racetime" : "speedrunCom",
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
	const seedAccountIds = builder.seedAccountIds.map(
		(id) => finalGraph.idByOriginal.get(id) ?? finalGraph.idByKey.get(id) ?? id,
	);
	const accountRoles = Object.fromEntries(
		builder.accounts.flatMap((account) => {
			const role = builder.accountRoles[account.id];
			const id =
				finalGraph.idByOriginal.get(account.id) ??
				finalGraph.idByKey.get(account.id) ??
				account.id;
			return role ? [[id, role]] : [];
		}),
	);
	const finalAccountIds = new Set(
		finalGraph.accounts.map((account) => account.id),
	);
	const finalCandidates = candidates
		.map((candidate) => ({
			...candidate,
			originAccountId:
				finalGraph.idByOriginal.get(candidate.originAccountId) ??
				finalGraph.idByKey.get(candidate.originAccountId) ??
				candidate.originAccountId,
		}))
		.filter((candidate) => finalAccountIds.has(candidate.originAccountId));
	return {
		directory,
		input,
		accounts: finalGraph.accounts,
		evidence: finalGraph.evidence,
		profiles,
		candidates: finalCandidates,
		warnings,
		errors,
		requiredAccounts,
		newPlayerId: options.newPlayerId ?? `new:${randomUUID()}`,
		inputAccountIds,
		seedAccountIds,
		accountRoles,
		...(options.target ? {targetPlayerId: options.target.playerId} : {}),
	};
}
function profileKeys(profile: ProviderIdentity): string[] {
	return [
		...(profile.twitchLogin ? [`twitch:${login(profile.twitchLogin)}`] : []),
		...(profile.youtube ? [`youtube:${youtubeUrl(profile.youtube)}`] : []),
	];
}
