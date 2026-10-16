/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The encrypted export file: a passphrase, scrypt, AES-256-GCM. No `vscode`,
 * no relative value imports — `npm test` loads this directly.
 *
 * The vault itself never needs this: SecretStorage already encrypts it with a
 * key the operating system keeps (Keychain, DPAPI, libsecret). An export leaves
 * that protection the moment it is written to a file, so it carries its own.
 */

import * as crypto from 'crypto';

export const sealFormat = 'ai-browser-vault-export';
const sealVersion = 1;

/**
 * scrypt cost. N = 2^17 with r = 8 takes 128 MiB and a few hundred
 * milliseconds — the OWASP floor for scrypt, paid once per export or import.
 */
const defaultCost = { N: 1 << 17, r: 8, p: 1 };

/**
 * Bounds on what an *imported* file may ask for. Its parameters are read from
 * the file before anything is authenticated, so without a ceiling a crafted
 * file is a request for gigabytes of memory in the extension host. At the
 * ceiling, scrypt takes 128 · N · r = 256 MiB.
 */
const maxN = 1 << 18;
const maxR = 8;
const maxP = 4;

export type SealFailure = 'notSealed' | 'unsupported' | 'wrongPassphrase';

/** Why a file could not be opened, as a reason the caller can word for the user. */
export class SealError extends Error {
	readonly reason: SealFailure;
	constructor(reason: SealFailure, message: string) {
		super(message);
		this.reason = reason;
	}
}

interface Envelope {
	readonly format: string;
	readonly version: number;
	readonly kdf: { readonly name: 'scrypt'; readonly N: number; readonly r: number; readonly p: number; readonly salt: string };
	readonly cipher: { readonly name: 'aes-256-gcm'; readonly iv: string; readonly tag: string };
	readonly data: string;
}

/**
 * The bytes the tag covers besides the ciphertext.
 *
 * Every parameter that decides how the file is read goes in, so a file whose
 * cost or salt was edited fails authentication rather than decrypting under
 * parameters nobody chose. Built field by field rather than from the parsed
 * object, so key order in the file cannot matter.
 */
function associatedData(envelope: Omit<Envelope, 'data' | 'cipher'> & { cipher: { name: string; iv: string } }): Buffer {
	const { kdf, cipher } = envelope;
	return Buffer.from(JSON.stringify([
		envelope.format, envelope.version, kdf.name, kdf.N, kdf.r, kdf.p, kdf.salt, cipher.name, cipher.iv,
	]), 'utf8');
}

/**
 * The same passphrase typed on two systems can arrive as two different code
 * point sequences (a composed `é` against `e` + combining accent), and a file
 * that will not open on the other machine looks like a wrong password.
 */
function passphraseBytes(passphrase: string): Buffer {
	return Buffer.from(passphrase.normalize('NFC'), 'utf8');
}

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		crypto.scrypt(passphraseBytes(passphrase), salt, 32, { N, r, p, maxmem: 256 * N * r + (1 << 20) },
			(err, key) => err ? reject(err) : resolve(key));
	});
}

/** Encrypts `plain` under `passphrase` and returns the file's text. */
export async function seal(plain: string, passphrase: string, cost = defaultCost): Promise<string> {
	const salt = crypto.randomBytes(16);
	const iv = crypto.randomBytes(12);
	const key = await deriveKey(passphrase, salt, cost.N, cost.r, cost.p);
	const header = {
		format: sealFormat,
		version: sealVersion,
		kdf: { name: 'scrypt' as const, N: cost.N, r: cost.r, p: cost.p, salt: salt.toString('base64') },
		cipher: { name: 'aes-256-gcm' as const, iv: iv.toString('base64') },
	};
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(associatedData(header));
	const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const envelope: Envelope = {
		...header,
		cipher: { ...header.cipher, tag: cipher.getAuthTag().toString('base64') },
		data: data.toString('base64'),
	};
	key.fill(0);
	return JSON.stringify(envelope, undefined, '\t') + '\n';
}

/** Whether `text` is one of our export files at all, before asking for a passphrase. */
export function isSealed(text: string): boolean {
	try {
		const raw = JSON.parse(text);
		return raw?.format === sealFormat;
	} catch {
		return false;
	}
}

const isBase64 = (value: unknown, bytes?: number): value is string =>
	typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
	&& (bytes === undefined || Buffer.from(value, 'base64').length === bytes);

const powerOfTwo = (value: number) => Number.isInteger(value) && value > 1 && (value & (value - 1)) === 0;

/**
 * Decrypts a file written by {@link seal}.
 *
 * Throws {@link SealError}: `notSealed` for text that is not an export,
 * `unsupported` for a newer version or parameters out of bounds, and
 * `wrongPassphrase` when authentication fails — which is also what a damaged
 * file gives, since GCM cannot tell the two apart and must not try.
 */
export async function unseal(text: string, passphrase: string): Promise<string> {
	let raw: any;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new SealError('notSealed', 'Not an AI Browser export file');
	}
	if (raw?.format !== sealFormat) {
		throw new SealError('notSealed', 'Not an AI Browser export file');
	}
	// The version is read from a file somebody handed the user, so it is never
	// echoed: the message reaches a notification, whose body renders links that
	// run commands, and `1 [Update](command:…)` would have been one.
	if (raw.version !== sealVersion) {
		throw new SealError('unsupported', typeof raw.version === 'number' && raw.version > sealVersion
			? 'The export was made by a newer version of AI Browser'
			: 'The export file has a version this build does not know');
	}
	const kdf = raw.kdf;
	const cipherInfo = raw.cipher;
	if (kdf?.name !== 'scrypt' || !powerOfTwo(kdf.N) || kdf.N > maxN
		|| !Number.isInteger(kdf.r) || kdf.r < 1 || kdf.r > maxR
		|| !Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > maxP
		|| !isBase64(kdf.salt) || Buffer.from(kdf.salt, 'base64').length < 16
		|| cipherInfo?.name !== 'aes-256-gcm' || !isBase64(cipherInfo.iv, 12) || !isBase64(cipherInfo.tag, 16)
		|| !isBase64(raw.data)) {
		throw new SealError('unsupported', 'The export file has parameters this build does not accept');
	}
	const key = await deriveKey(passphrase, Buffer.from(kdf.salt, 'base64'), kdf.N, kdf.r, kdf.p);
	try {
		const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(cipherInfo.iv, 'base64'));
		decipher.setAAD(associatedData({ format: raw.format, version: raw.version, kdf, cipher: cipherInfo }));
		decipher.setAuthTag(Buffer.from(cipherInfo.tag, 'base64'));
		return Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]).toString('utf8');
	} catch {
		throw new SealError('wrongPassphrase', 'Wrong passphrase, or the file is damaged');
	} finally {
		key.fill(0);
	}
}
