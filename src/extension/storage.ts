import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import type {StorageStatus} from "@nanahuse/player-manager-protocol";
import {type Directory} from "@nanahuse/player-manager-protocol";
import {DirectoryError, validateDirectory} from "../domain/player.ts";
import {
	backupExistingFile,
	fileMatchesBackup,
	JsonRepository,
	type Repository,
	restoreExistingFile,
} from "./repository.ts";
import {type SharedDirectory, spreadsheetId} from "./sheets.ts";
export const fingerprint = (d: Directory | null) =>
	d
		? createHash("sha256")
				.update(JSON.stringify(validateDirectory(d)))
				.digest("hex")
		: null;
type Settings = {spreadsheetId: string; pending: boolean; base: string | null};
export class StorageRepository implements Repository {
	private settings: Settings = {spreadsheetId: "", pending: false, base: null};
	private initialized = false;
	private remote: SharedDirectory | null = null;
	private current: StorageStatus = {
		destination: "local",
		spreadsheetId: "",
		pending: false,
		message: "ローカル保存",
	};
	constructor(
		private readonly local: Repository,
		private readonly settingsFile: string,
		private readonly makeRemote: (id: string) => SharedDirectory,
		private readonly publish: (s: StorageStatus) => void = () => {},
		private readonly backup: (d: Directory) => Promise<void> = async () => {},
		private readonly logReadError: (error: unknown) => void = () => {},
	) {}
	status(): StorageStatus {
		return {...this.current};
	}
	private report(destination: "local" | "spreadsheet", message: string) {
		this.current = {
			destination,
			spreadsheetId: this.settings.spreadsheetId,
			pending: this.settings.pending,
			message,
		};
		this.publish(this.status());
	}
	private async persist() {
		await mkdir(dirname(this.settingsFile), {recursive: true});
		const temp = this.settingsFile + "." + randomUUID() + ".tmp";
		try {
			await writeFile(temp, JSON.stringify(this.settings), {flag: "wx"});
			await rename(temp, this.settingsFile);
		} finally {
			await rm(temp, {force: true});
		}
	}
	private async initialize() {
		if (this.initialized) return;
		try {
			const raw = JSON.parse(await readFile(this.settingsFile, "utf8"));
			if (
				typeof raw.spreadsheetId !== "string" ||
				typeof raw.pending !== "boolean" ||
				(raw.base !== null && typeof raw.base !== "string")
			)
				throw new Error("保存先設定が不正です");
			this.settings = {
				spreadsheetId: spreadsheetId(raw.spreadsheetId),
				pending: raw.pending,
				base: raw.base,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.initialized = true;
	}
	async load(): Promise<Directory> {
		await this.initialize();
		const local = await this.local.load();
		if (!this.settings.spreadsheetId) {
			this.report("local", "ローカル保存");
			return local;
		}
		if (this.settings.pending) {
			this.report(
				"local",
				"未同期の変更があります。「接続・再試行」でシートとの差分を確認します",
			);
			return local;
		}
		return this.connect(local);
	}
	async initializeEmpty(): Promise<Directory> {
		const settingsBackup = await backupExistingFile(
			this.settingsFile,
			"initialize",
		);
		const restoreDirectory = await this.local.prepareInitialization?.();
		if (!restoreDirectory)
			throw new Error("Local repository cannot safely initialize Directory");
		const previousSettings = this.settings;
		const previousInitialized = this.initialized;
		const previousRemote = this.remote;
		const previousStatus = this.current;
		this.settings = {spreadsheetId: "", pending: false, base: null};
		let directoryUpdateStarted = false;
		try {
			await this.persist();
			directoryUpdateStarted = true;
			const empty = await this.local.initializeEmpty(true);
			this.initialized = true;
			this.remote = null;
			this.report(
				"local",
				"空のDirectoryを初期化しました。Google Sheetsは変更していません",
			);
			return empty;
		} catch (error) {
			this.settings = previousSettings;
			this.initialized = previousInitialized;
			this.remote = previousRemote;
			this.current = previousStatus;
			const rollbackErrors: unknown[] = [];
			try {
				const unchanged = await fileMatchesBackup(
					this.settingsFile,
					settingsBackup,
				).catch(() => false);
				if (!unchanged)
					await restoreExistingFile(this.settingsFile, settingsBackup);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			if (directoryUpdateStarted) {
				try {
					await restoreDirectory();
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			if (rollbackErrors.length) {
				this.logReadError(
					new Error("Directory initialization rollback was incomplete", {
						cause: new AggregateError(rollbackErrors),
					}),
				);
				throw new Error(
					"Could not initialize Directory; recovery backups were retained and rollback was incomplete",
					{cause: error},
				);
			}
			throw error;
		}
	}
	async configure(value: string, local: Directory): Promise<Directory> {
		await this.initialize();
		const id = spreadsheetId(value);
		if (this.settings.pending && id && id !== this.settings.spreadsheetId)
			throw new DirectoryError(
				"invalid_input",
				"未同期の変更があります。現在のシートに再接続するか、空欄でローカル保存に切り替えてください",
			);
		if (id !== this.settings.spreadsheetId) {
			const next = {spreadsheetId: id, pending: false, base: null};
			const old = this.settings;
			this.settings = next;
			try {
				await this.persist();
			} catch (error) {
				this.settings = old;
				throw error;
			}
		}
		this.remote = null;
		if (!id) {
			await this.local.save(local);
			this.report("local", "ローカル保存に切り替えました");
			return local;
		}
		return this.connect(local);
	}
	private async connect(local: Directory): Promise<Directory> {
		this.remote = this.makeRemote(this.settings.spreadsheetId);
		try {
			const remote = await this.remote.load();
			const remoteHash = fingerprint(remote);
			if (this.settings.pending) {
				if (
					remoteHash !== this.settings.base &&
					remoteHash !== fingerprint(local)
				)
					throw new Error(
						"シート側にも変更があります。ローカルの未同期データを保持しました。自動上書きは行いません",
					);
				if (remoteHash !== fingerprint(local)) await this.remote.save(local);
				else await this.remote.checkWritable();
			} else if (remote) {
				await this.remote.checkWritable();
				if (fingerprint(local) !== remoteHash) {
					await this.backup(local);
					await this.local.save(remote);
				}
				local = remote;
			} else {
				// Mark the seed as pending before a request that might succeed despite a lost response.
				this.settings.pending = true;
				this.settings.base = null;
				await this.persist();
				await this.remote.save(local);
			}
			this.settings = {
				...this.settings,
				pending: false,
				base: fingerprint(local),
			};
			await this.persist();
			this.report(
				"spreadsheet",
				"Googleスプレッドシートに保存します（ローカルにも控えを保存）",
			);
			return local;
		} catch (error) {
			this.remote = null;
			this.logReadError(error);
			this.report(
				"local",
				(error instanceof Error
					? error.message
					: "シートに接続できませんでした") + "。現在はローカル保存です",
			);
			return local;
		}
	}
	async save(value: Directory): Promise<void> {
		await this.initialize();
		if (!this.settings.spreadsheetId) {
			await this.local.save(value);
			this.report("local", "ローカルに保存しました");
			return;
		}
		this.settings.pending = true;
		await this.persist();
		await this.local.save(value);
		if (this.current.destination !== "spreadsheet" || !this.remote) {
			this.report(
				"local",
				"ローカルに保存しました。シートには未同期です。接続・再試行してください",
			);
			return;
		}
		try {
			const remote = await this.remote.load();
			if (fingerprint(remote) !== this.settings.base)
				throw new Error(
					"シートが別の場所で更新されています。今回の変更はローカルに保持しました",
				);
			await this.remote.save(value);
			this.settings = {
				...this.settings,
				pending: false,
				base: fingerprint(value),
			};
			await this.persist();
			this.report(
				"spreadsheet",
				"Googleスプレッドシートに保存しました（ローカルにも控えを保存）",
			);
		} catch (error) {
			this.settings.pending = true;
			this.remote = null;
			this.report(
				"local",
				(error instanceof Error
					? error.message
					: "シートへの保存に失敗しました") +
					"。ローカル保存・シート未同期です",
			);
		}
	}
}
export function fileStorage(
	file: string,
	makeRemote: (id: string) => SharedDirectory,
	publish: (s: StorageStatus) => void,
	logReadError?: (error: unknown) => void,
) {
	return new StorageRepository(
		new JsonRepository(file),
		file + ".storage.json",
		makeRemote,
		publish,
		async (d) => {
			await new JsonRepository(
				file + ".before-sheet-" + randomUUID() + ".bak",
			).save(d);
		},
		logReadError,
	);
}
