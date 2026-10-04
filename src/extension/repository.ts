import {randomUUID} from "node:crypto";
import {copyFile, mkdir, open, readFile, rename, rm} from "node:fs/promises";
import {dirname} from "node:path";
import {type Directory, validateDirectory} from "../domain/player.ts";
export interface Repository {
	load(): Promise<Directory>;
	save(value: Directory): Promise<void>;
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
				return {schemaVersion: 1, revision: 0, players: []};
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
}
