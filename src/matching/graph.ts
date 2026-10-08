import type {Account, EvidenceSet} from "./model.ts";

export function dedupeAccounts(accounts: Account[]): Account[] {
	const groups: Account[] = [];
	for (const account of accounts) {
		const matches = groups.filter(
			(candidate) =>
				candidate.service === account.service &&
				(candidate.id === account.id ||
					candidate.keys.some((key) => account.keys.includes(key))),
		);
		if (!matches.length) {
			groups.push({...account, keys: [...new Set(account.keys)]});
			continue;
		}
		const first = matches[0]!;
		first.keys = [...new Set([...first.keys, ...account.keys])];
		first.profile ??= account.profile;
		for (const duplicate of matches.slice(1)) {
			first.keys = [...new Set([...first.keys, ...duplicate.keys])];
			groups.splice(groups.indexOf(duplicate), 1);
		}
	}
	return groups;
}
export function dedupeEvidence(evidence: EvidenceSet[]): EvidenceSet[] {
	const seen = new Set<string>();
	return evidence.flatMap((item) => {
		const accounts = [...new Set(item.accounts)].sort();
		if (accounts.length < 1) return [];
		const id = `${item.source}:${accounts.join("|")}`;
		if (seen.has(id)) return [];
		seen.add(id);
		return [{id, source: item.source, accounts}];
	});
}
export function components(
	accounts: Account[],
	evidence: EvidenceSet[],
): AccountIdGroups {
	const parent = new Map(accounts.map(({id}) => [id, id]));
	const find = (id: string): string => {
		const root = parent.get(id) ?? id;
		if (root !== id) parent.set(id, find(root));
		return parent.get(id) ?? id;
	};
	for (const set of evidence) {
		const first = set.accounts[0];
		if (!first) continue;
		for (const id of set.accounts.slice(1)) {
			const a = find(first),
				b = find(id);
			if (a !== b) parent.set(b, a);
		}
	}
	const groups = new Map<string, string[]>();
	for (const id of parent.keys()) {
		const root = find(id);
		groups.set(root, [...(groups.get(root) ?? []), id]);
	}
	return [...groups.values()];
}
export type AccountIdGroups = string[][];
