import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const version = JSON.parse(await readFile("package.json", "utf8")).version;
if (typeof version !== "string" || !versionPattern.test(version)) {
	throw new Error("Root package version must use MAJOR.MINOR.PATCH format");
}

const tag = `v${version}`;
const commit = process.env.GITHUB_SHA;
if (!commit) {
	throw new Error("GITHUB_SHA is required");
}

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function compareVersions(left, right) {
	const a = left.split(".").map(BigInt);
	const b = right.split(".").map(BigInt);
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
	}
	return 0;
}

function remoteState() {
	const main = git("ls-remote", "origin", "refs/heads/main").split("\t")[0];
	const refs = git("ls-remote", "--tags", "--refs", "origin");
	const tags = refs
		? refs.split("\n").map((line) => line.split("\t")[1].replace("refs/tags/", ""))
		: [];
	return { main, tags };
}

function highestRelease(tags) {
	return tags
		.map((name) => name.match(/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/)?.[1])
		.filter(Boolean)
		.reduce((highest, candidate) =>
			!highest || compareVersions(candidate, highest) > 0 ? candidate : highest,
			undefined,
		);
}

function removeTagIfCreated() {
	try {
		if (git("rev-parse", "-q", "--verify", `refs/tags/${tag}`)) git("tag", "-d", tag);
	} catch {
		// No local tag was created.
	}
}

let state = remoteState();
if (state.tags.includes(tag)) {
	console.log(`${tag} already exists; skipping`);
	process.exit(0);
}
if (state.main !== commit) {
	console.log("main has advanced since this workflow started; skipping this run");
	process.exit(0);
}

let highest = highestRelease(state.tags);
if (highest && compareVersions(version, highest) <= 0) {
	throw new Error(`${tag} must be newer than the latest release tag v${highest}`);
}
execFileSync(
	"git",
	[
		"-c",
		"user.name=github-actions[bot]",
		"-c",
		"user.email=41898282+github-actions[bot]@users.noreply.github.com",
		"tag",
		"-a",
		tag,
		commit,
		"-m",
		`Release ${tag}`,
	],
	{ encoding: "utf8" },
);
state = remoteState();
if (state.tags.includes(tag)) {
	removeTagIfCreated();
	console.log(`${tag} was created by another run; skipping`);
	process.exit(0);
}
if (state.main !== commit) {
	removeTagIfCreated();
	console.log("main advanced before tag publication; skipping this run");
	process.exit(0);
}

highest = highestRelease(state.tags);
if (highest && compareVersions(version, highest) <= 0) {
	removeTagIfCreated();
	throw new Error(`${tag} is no longer newer than the latest release tag v${highest}`);
}

git("push", "origin", `refs/tags/${tag}`);
console.log(`Published annotated tag ${tag} for ${commit}`);
