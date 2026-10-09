import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-version.mjs", import.meta.url));

async function runVersionCheck(rootVersion, protocolVersion) {
	const directory = await mkdtemp(join(tmpdir(), "player-manager-version-"));
	try {
		await mkdir(join(directory, "packages", "player-manager-protocol"), { recursive: true });
		await writeFile(join(directory, "package.json"), JSON.stringify({ version: rootVersion }));
		await writeFile(
			join(directory, "packages", "player-manager-protocol", "package.json"),
			JSON.stringify({ version: protocolVersion }),
		);
		await writeFile(join(directory, "check-version.mjs"), await readFile(script));
		return spawnSync(process.execPath, ["check-version.mjs"], {
			cwd: directory,
			encoding: "utf8",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("matching MAJOR.MINOR.PATCH package versions pass", async () => {
	assert.equal((await runVersionCheck("2.0.1", "2.0.1")).status, 0);
});

test("different package versions fail", async () => {
	assert.notEqual((await runVersionCheck("2.0.1", "2.0.0")).status, 0);
});

test("non-release version formats fail", async () => {
	for (const version of ["2.0", "v2.0.1", "2.0.1-beta.1", "02.0.1"]) {
		assert.notEqual((await runVersionCheck(version, version)).status, 0, version);
	}
});
