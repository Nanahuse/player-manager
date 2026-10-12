import {randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {copyFile, mkdir, open, readFile, rename, rm} from "node:fs/promises";
import {dirname} from "node:path";
import {type Directory} from "@nanahuse/player-manager-protocol";
import {validateDirectory} from "../domain/player.ts";
export interface Repository {
	load(): Promise<Directory>;
	save(value: Directory): Promise<void>;
	initializeEmpty(skipBackup?: boolean): Promise<Directory>;
	prepareInitialization?(): Promise<() => Promise<void>>;
}
export async function backupExistingFile(file: string, label: string) {
	const backup = `${file}.before-${label}-${randomUUID()}.bak`;
	try {
		await copyFile(file, backup, constants.COPYFILE_EXCL);
		return backup;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		if ((error as NodeJS.ErrnoException).code !== "EEXIST")
			await rm(backup, {force: true}).catch(() => {});
		throw error;
	}
}
export async function restoreExistingFile(file: string, backup: string | null) {
	if (!backup) {
		await rm(file, {force: true});
		return;
	}
	const temp = `${file}.${randomUUID()}.restore`;
	try {
		await copyFile(backup, temp, constants.COPYFILE_EXCL);
		await rename(temp, file);
	} finally {
		await rm(temp, {force: true});
	}
}
export async function fileMatchesBackup(file: string, backup: string | null) {
	const current = await readFile(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (!backup) return current === null;
	const original = await readFile(backup);
	return current?.equals(original) ?? false;
}
export class JsonRepository implements Repository {
	constructor(private readonly file: string) {}
	async load(): Promise<Directory> {
		try {
			const raw = JSON.parse(await readFile(this.file, "utf8"));
			const directory = validateDirectory(raw);
			if (JSON.stringify(raw) !== JSON.stringify(directory)) {
				// Preserve the exact pre-migration document before atomically replacing it.
				await copyFile(
					this.file,
					this.file + ".before-compact-" + randomUUID() + ".bak",
				);
				await this.save(directory);
			}
			return directory;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return {schemaVersion: 2, revision: 0, players: []};
			throw error;
		}
	}
	async save(value: Directory): Promise<void> {
		await mkdir(dirname(this.file), {recursive: true});
		const temp = `${this.file}.${randomUUID()}.tmp`;
		try {
			const handle = await open(temp, "wx");
			try {
				await handle.writeFile(
					`${JSON.stringify(validateDirectory(value), null, 2)}\n`,
					"utf8",
				);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temp, this.file);
		} finally {
			await rm(temp, {force: true});
		}
	}
	async prepareInitialization() {
		const backup = await backupExistingFile(this.file, "initialize");
		return () => restoreExistingFile(this.file, backup);
	}
	async initializeEmpty(skipBackup = false): Promise<Directory> {
		const empty = {schemaVersion: 2 as const, revision: 0, players: []};
		if (!skipBackup) await backupExistingFile(this.file, "initialize");
		await this.save(empty);
		return empty;
	}
}
