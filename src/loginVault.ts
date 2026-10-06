/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { withLock } from './fileLock';
import { writeFileAtomic } from './safeFiles';
import { emptyVault, newRevision, parseVault, revisionTime, serializeVault, type Vault } from './vaultData';

/** How long a writer waits for the last write, from whichever window made it, to reach its own read. */
const catchUpMs = 3_000;

/**
 * A recorded write this old that has still not arrived never will: its window
 * stored it and was gone before the change was flushed to the other windows.
 * Waiting for it any longer would lock the vault for good.
 */
const abandonedAfterMs = 30_000;

/** How long an absent vault is given to arrive before it is called lost. */
const absentRecheckMs = 1_000;

/**
 * The saved logins and passkeys, in VS Code's SecretStorage.
 *
 * **SecretStorage is the encryption, and it is the right one.** On desktop it is
 * Electron's `safeStorage`: the value is encrypted with a key the operating
 * system keeps — the login Keychain on macOS, DPAPI on Windows, the Secret
 * Service on Linux — so a copy of the profile directory is ciphertext without
 * the user's OS session. Nothing here adds a second layer of its own: a key the
 * extension held would have to be stored somewhere, and every place an
 * extension can store one is weaker than the one SecretStorage already uses.
 * The export file is the one place that leaves this protection, and it carries
 * its own (`vaultSeal.ts`).
 *
 * One key holds the whole vault, as one JSON document. SecretStorage cannot
 * list its keys on the `engines` floor, so one entry per login would need an
 * index — a second key to keep in step with the first, across windows.
 *
 * **Writes are read-modify-write under a cross-process lock, and the lock alone
 * is not enough.** SecretStorage is shared by every window, but each window
 * reads it through its own renderer's cache, and a write reaches the others
 * only after that renderer flushes (100 ms in VS Code 1.140) and the main
 * process passes it on. Each write therefore stamps a `revision` that carries
 * its time, recorded in a file beside the lock, and the next writer waits until
 * its own read is at least that new — and **refuses** when it cannot get there,
 * rather than writing back a vault it knows is stale. Falling back to the stale
 * read was the first version, and it deleted the other window's entry in
 * exactly the case the wait exists for.
 *
 * The lock and the revision file live in the extension's global storage. The
 * extension host is given the *default* profile's `globalStorageHome` whatever
 * the window's profile (checked in VS Code 1.140), which matches SecretStorage
 * being application-wide — so every profile takes the same lock.
 */
export class LoginVault implements vscode.Disposable {

	private static readonly key = 'aiBrowser.vault';
	/**
	 * How many entries the vault held after the last write. Not a secret —
	 * only a count — and kept outside SecretStorage on purpose: it is how a
	 * vault VS Code could not decrypt is told apart from one never written.
	 */
	private static readonly countKey = 'aiBrowser.vault.entries';

	private _cache: Vault | undefined;
	/** Bumped by every change notice; a read that started before one is not cached. */
	private _generation = 0;
	private _lossReported = false;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	/** Fires after any window changed the vault, this one included. */
	public readonly onDidChange = this._onDidChange.event;
	private readonly _onDidLose = new vscode.EventEmitter<void>();
	/**
	 * Fires once when the vault turned out to be gone. The caller decides how
	 * to say so: a toast over a visible browser tab would pause it (#10).
	 */
	public readonly onDidLose = this._onDidLose.event;
	private readonly _subscription: vscode.Disposable;

	constructor(
		private readonly _secrets: vscode.SecretStorage,
		private readonly _storage: vscode.Uri,
		private readonly _state: vscode.Memento,
	) {
		this._subscription = _secrets.onDidChange(e => {
			if (e.key === LoginVault.key) {
				this._generation++;
				this._cache = undefined;
				this._onDidChange.fire();
			}
		});
	}

	private get _lockFile(): string {
		return path.join(this._storage.fsPath, 'login-vault.lock');
	}

	private get _revisionFile(): string {
		return path.join(this._storage.fsPath, 'login-vault.revision');
	}

	/**
	 * The vault as stored now.
	 *
	 * Throws when the stored value is not a vault this build can read — a
	 * newer format, or text that does not parse. That is never answered with an
	 * empty vault: an empty vault is a valid thing to write back, and writing it
	 * would delete every saved password.
	 */
	public async read(): Promise<Vault> {
		if (this._cache) {
			return this._cache;
		}
		const generation = this._generation;
		const vault = await this._readFresh();
		// A change notice that arrived while this read was in flight means the
		// answer may already be superseded: return it, do not keep it. Caching
		// it held a deleted login in the picker until the next change.
		if (generation === this._generation) {
			this._cache = vault;
		}
		return vault;
	}

	private async _readText(): Promise<string | undefined> {
		const text = await this._secrets.get(LoginVault.key);
		return text === '' ? undefined : text;
	}

	private _parse(text: string | undefined): Vault {
		if (text === undefined) {
			return emptyVault();
		}
		const parsed = parseVault(text);
		if (!parsed) {
			throw new Error(vscode.l10n.t(
				"The saved logins could not be read — they were written by a newer version of AI Browser, or are damaged. Nothing was changed."));
		}
		return parsed.vault;
	}

	private async _readFresh(): Promise<Vault> {
		let text = await this._readText();
		if (text === undefined && this._state.get<number>(LoginVault.countKey, 0) > 0) {
			// Something was saved and nothing is there. Either another window's
			// first write has not reached this one yet — given a moment — or
			// VS Code could not decrypt the vault and **deleted it**, which is
			// what its secret storage does after a reset keychain or a changed
			// Linux keyring.
			await new Promise(resolve => setTimeout(resolve, absentRecheckMs));
			text = await this._readText();
			if (text === undefined) {
				this._reportLoss();
			}
		}
		return this._parse(text);
	}

	private _reportLoss(): void {
		if (this._lossReported) {
			return;
		}
		this._lossReported = true;
		void Promise.resolve(this._state.update(LoginVault.countKey, 0)).then(undefined, () => { /* reported once per window anyway */ });
		this._onDidLose.fire();
	}

	/**
	 * Applies `change` to the current vault and stores the result.
	 *
	 * `change` returns `undefined` to write nothing. Throws when the lock could
	 * not be taken or the latest write could not be seen: the caller reports
	 * it, since a save the user asked for that silently did not happen is worse
	 * than a refusal.
	 */
	public async update<T>(change: (vault: Vault) => { vault: Vault; result: T } | undefined): Promise<T | undefined> {
		let outcome: T | undefined;
		await fs.mkdir(this._storage.fsPath, { recursive: true });
		const locked = await withLock(this._lockFile, async () => {
			const current = await this._readCaughtUp();
			const next = change(current);
			if (!next) {
				return;
			}
			const revision = newRevision();
			const stored: Vault = { ...next.vault, revision };
			await this._secrets.store(LoginVault.key, serializeVault(stored));
			// **From here the vault is written**, whatever follows. The revision
			// file and the count are bookkeeping; a failure in them — a rename
			// an antivirus is holding on Windows — used to throw out of an update
			// that had succeeded, and the user was told a passkey was lost that
			// was in fact saved.
			this._cache = stored;
			outcome = next.result;
			await writeFileAtomic(this._revisionFile, revision, 0o600, false).catch(() => { /* the next writer waits a moment longer */ });
			await Promise.resolve(this._state.update(LoginVault.countKey, stored.logins.length + stored.passkeys.length))
				.catch(() => { /* only loss detection reads it */ });
		});
		if (!locked) {
			throw new Error(vscode.l10n.t("The saved logins are busy with another change — try again."));
		}
		return outcome;
	}

	/**
	 * The vault, once this window's read is at least as new as the last write
	 * any window recorded.
	 *
	 * Throws when that cannot be had within a few seconds — unless the recorded
	 * write is old enough that it never will arrive (its window died before
	 * flushing it), in which case the read as it stands is all there is.
	 */
	private async _readCaughtUp(): Promise<Vault> {
		let expected: string | undefined;
		let recordedAt: number | undefined;
		try {
			expected = (await fs.readFile(this._revisionFile, 'utf8')).trim() || undefined;
			recordedAt = revisionTime(expected) ?? (await fs.stat(this._revisionFile)).mtimeMs;
		} catch {
			expected = undefined;
		}
		const deadline = Date.now() + catchUpMs;
		for (;;) {
			const text = await this._readText();
			const vault = this._parse(text);
			const seen = revisionTime(vault.revision);
			const caughtUp = !expected || vault.revision === expected
				|| (seen !== undefined && recordedAt !== undefined && seen >= recordedAt);
			if (caughtUp) {
				return vault;
			}
			if (Date.now() >= deadline) {
				if (recordedAt !== undefined && Date.now() - recordedAt > abandonedAfterMs) {
					if (text === undefined && this._state.get<number>(LoginVault.countKey, 0) > 0) {
						this._reportLoss();
					}
					return vault;
				}
				throw new Error(vscode.l10n.t(
					"Another window has just changed the saved logins and the change has not reached this one yet — try again in a moment."));
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}

	public dispose(): void {
		this._subscription.dispose();
		this._onDidChange.dispose();
		this._onDidLose.dispose();
	}
}
