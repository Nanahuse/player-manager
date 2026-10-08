import type {Directory} from "@nanahuse/player-manager-protocol";
import {analyze} from "../../matching/analyze.ts";
import type {
	MatchingInput,
	RequiredAccount,
	Resolution,
} from "../../matching/model.ts";
import type {RaceTimeLookup} from "../racetime.ts";
import type {UserLookup} from "../speedrun.ts";
import {collectMatching} from "./collect.ts";

export type MatchingEngineOptions = {
	directory: Directory;
	input: MatchingInput;
	racetime: RaceTimeLookup;
	src: UserLookup;
	requiredAccounts?: RequiredAccount[];
};
export async function resolveMatching(
	options: MatchingEngineOptions,
): Promise<Resolution> {
	const collection = await collectMatching(options);
	return analyze(collection);
}
