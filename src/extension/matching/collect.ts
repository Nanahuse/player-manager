import {randomUUID} from "node:crypto";
import type {
	Directory,
	Player,
	ProviderIdentity,
} from "@nanahuse/player-manager-protocol";
import {login, speedrunReference, youtubeUrl} from "../../domain/player.ts";
import {dedupeAccounts, dedupeEvidence} from "../../matching/graph.ts";
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
): string {
	const canonical = keys[0]!;
	const id = canonical;
	builder.accounts.push({id, service, keys});
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
			put(builder, "racetime", [
				`racetime:${raceTimeId(player.racetime.userId)}`,
			]),
		);
	if (player.speedrunCom)
		ids.push(
			put(builder, "speedrunCom", [
				`speedrunCom:${speedrunReference(player.speedrunCom.userId)}`,
			]),
		);
	if (player.twitch) {
		const keys = [
			player.twitch.userId && `twitch-id:${player.twitch.userId}`,
			`twitch:${login(player.twitch.login)}`,
		].filter((key): key is string => Boolean(key));
		ids.push(put(builder, "twitch", keys));
	}
	if (player.youtube)
		ids.push(
			put(builder, "youtube", [`youtube:${youtubeUrl(player.youtube)}`]),
		);
	if (ids.length > 1) builder.evidence.push({id: "", source, accounts: ids});
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
		put(builder, service, [
			service === "racetime"
				? `racetime:${raceTimeId(profile.userId)}`
				: `speedrunCom:${speedrunReference(profile.userId)}`,
		]),
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
	const inputIds: string[] = [];
	try {
		if (input.racetime)
			inputIds.push(
				put(
					builder,
					"racetime",
					[`racetime:${raceTimeId(input.racetime)}`],
					true,
				),
			);
		if (input.speedrunCom)
			inputIds.push(
				put(
					builder,
					"speedrunCom",
					[`speedrunCom:${speedrunReference(input.speedrunCom)}`],
					true,
				),
			);
		if (input.twitch)
			inputIds.push(
				put(
					builder,
					"twitch",
					[
						input.twitch.userId && `twitch-id:${input.twitch.userId}`,
						`twitch:${login(input.twitch.login)}`,
					].filter((key): key is string => Boolean(key)),
					true,
				),
			);
		if (input.youtube)
			inputIds.push(
				put(builder, "youtube", [`youtube:${youtubeUrl(input.youtube)}`], true),
			);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	if (inputIds.length > 1)
		builder.evidence.push({id: "", source: "input", accounts: inputIds});
	const lookup = async (
		service: "racetime" | "speedrunCom",
		id: string,
		explicit: boolean,
	) => {
		try {
			const profile =
				service === "racetime"
					? await racetime.getUser(id)
					: await src.getUser(id);
			profiles.push(profile);
			profileEvidence(
				profile,
				service,
				builder,
				service === "racetime" ? "racetime" : "src",
				inputIds.filter((inputId) =>
					builder.accounts.some(
						(a) =>
							a.id === inputId &&
							profileKeys(profile).some((key) => a.keys.includes(key)),
					),
				),
			);
		} catch (error) {
			const message = `${service} profile ${id}: ${error instanceof Error ? error.message : String(error)}`;
			if (explicit) errors.push(message);
			else warnings.push({operation: `get ${service} profile ${id}`, message});
		}
	};
	if (input.racetime) await lookup("racetime", input.racetime, true);
	if (input.speedrunCom) await lookup("speedrunCom", input.speedrunCom, true);
	const attempted = new Set<string>();
	const searchLogins = [
		...new Set(
			[input.twitch?.login, ...profiles.map((profile) => profile.twitchLogin)]
				.filter((value): value is string => Boolean(value))
				.map(login),
		),
	];
	for (const twitch of searchLogins) {
		const key = `twitch:${twitch}:twitch`;
		if (attempted.has(key)) continue;
		attempted.add(key);
		try {
			const found = await src.searchUsers(twitch, "twitch");
			const matches = found.users.filter((profile) =>
				profileKeys(profile).some((candidateKey) =>
					builder.accounts.some((a) => a.keys.includes(candidateKey)),
				),
			);
			for (const profile of found.users) {
				if (matches.length === 1 && matches[0] === profile) {
					profiles.push(profile);
					profileEvidence(profile, "speedrunCom", builder, "src", inputIds);
				} else
					candidates.push({
						id: `candidate:${profile.userId}`,
						service: "speedrunCom",
						profile,
						query: twitch,
					});
			}
			if (found.hasMore)
				warnings.push({
					operation: `search SRC Twitch ${twitch}`,
					message:
						"More candidates are available than the search result limit.",
				});
		} catch (error) {
			warnings.push({
				operation: `search SRC Twitch ${twitch}`,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const accounts = dedupeAccounts(builder.accounts);
	const alias = new Map<string, string>();
	for (const account of accounts)
		for (const key of account.keys) alias.set(key, account.id);
	const remap = (id: string) => {
		const account = builder.accounts.find((candidate) => candidate.id === id);
		return account ? (alias.get(account.keys[0]!) ?? id) : id;
	};
	const evidence = builder.evidence.map((set) => ({
		...set,
		accounts: set.accounts.map(remap),
	}));
	const inputAccountIds = builder.inputAccountIds.map(remap);
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
			const id = put(builder, required.service, [key]);
			inputAccountIds.push(id);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	const finalAccounts = dedupeAccounts(builder.accounts);
	const finalAlias = new Map(
		finalAccounts.flatMap((account) =>
			account.keys.map((key) => [key, account.id] as const),
		),
	);
	const finalIds = new Map(
		builder.accounts.map((account) => [
			account.id,
			finalAlias.get(account.keys[0]!) ?? account.id,
		]),
	);
	return {
		directory,
		input,
		accounts: finalAccounts,
		evidence: dedupeEvidence(
			evidence.map((set) => ({
				...set,
				accounts: set.accounts.map((id) => alias.get(id) ?? id),
			})),
		),
		profiles,
		candidates,
		warnings,
		errors,
		requiredAccounts,
		newPlayerId: `new:${randomUUID()}`,
		inputAccountIds: inputAccountIds.map((id) => finalIds.get(id) ?? id),
	};
}
function profileKeys(profile: ProviderIdentity): string[] {
	return [
		...(profile.twitchLogin ? [`twitch:${login(profile.twitchLogin)}`] : []),
		...(profile.youtube ? [`youtube:${youtubeUrl(profile.youtube)}`] : []),
	];
}
