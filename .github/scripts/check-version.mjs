import { readFile } from "node:fs/promises";

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function readVersion(path) {
	const manifest = JSON.parse(await readFile(path, "utf8"));
	if (typeof manifest.version !== "string" || !versionPattern.test(manifest.version)) {
		throw new Error(`${path}: version must use MAJOR.MINOR.PATCH format`);
	}
	return manifest.version;
}

const [rootVersion, protocolVersion] = await Promise.all([
	readVersion("package.json"),
	readVersion("packages/player-manager-protocol/package.json"),
]);

if (rootVersion !== protocolVersion) {
	throw new Error(`Version mismatch: root is ${rootVersion}, Protocol is ${protocolVersion}`);
}

console.log(`Validated package versions: ${rootVersion}`);
