// Application-level field encryption (AES-256-GCM) and keyed lookups (HMAC-SHA-256), docs/domain.md section 0.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '$lib/server/config';
import { base32 } from './encoding';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/**
 * Where an encrypted value lives, `table.column`. It is bound to the ciphertext as associated data,
 * so a value copied into another column does not decrypt.
 */
export type FieldContext =
	| 'users.email'
	| 'candidates.last_name'
	| 'candidates.first_name'
	| 'candidates.middle_name'
	| 'candidates.phone'
	| 'candidates.telegram'
	| 'profile_suggestions.value'
	| 'legal_representatives.full_name'
	| 'legal_representatives.email'
	| 'legal_representatives.phone'
	| 'notification_channels.telegram_chat_id'
	| 'demo_letters.body';

/** Keyed lookup purposes; each has its own derived key, so values of different purposes never collide. */
export type LookupPurpose = 'email' | 'telegram_chat';

export class FieldDecryptionError extends Error {
	override name = 'FieldDecryptionError';
}

export interface FieldKeys {
	keys: ReadonlyMap<number, Buffer>;
	activeVersion: number;
	hmacSecret: Buffer;
}

const normalizers: Record<LookupPurpose, (value: string) => string> = {
	email: (value) => value.normalize('NFKC').trim().toLowerCase(),
	telegram_chat: (value) => value.trim()
};

export interface FieldCrypto {
	/** `[key version][iv][tag][ciphertext]`, AES-256-GCM with the context as associated data. */
	encrypt(plaintext: string, context: FieldContext): Uint8Array;
	decrypt(sealed: Uint8Array, context: FieldContext): string;
	/** HMAC of the normalized value, hex; the value stored next to an encrypted field for exact lookup. */
	lookupHmac(purpose: LookupPurpose, value: string): string;
	/**
	 * Candidate pseudonym for one company: HMAC(candidate_id, company_id), 128 bits in base32.
	 * Different companies see different pseudonyms of the same candidate (domain 14).
	 */
	pseudonym(candidateId: string, companyId: string): string;
}

function deriveKey(secret: Buffer, purpose: string): Buffer {
	return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `fsp-career:hmac:${purpose}`, 32));
}

export function createFieldCrypto({ keys, activeVersion, hmacSecret }: FieldKeys): FieldCrypto {
	const activeKey = keys.get(activeVersion);
	if (!activeKey) throw new Error(`active field key version ${activeVersion} is not in the key ring`);
	const lookupKeys = new Map<string, Buffer>();
	const lookupKey = (purpose: string): Buffer => {
		let key = lookupKeys.get(purpose);
		if (!key) {
			key = deriveKey(hmacSecret, purpose);
			lookupKeys.set(purpose, key);
		}
		return key;
	};

	return {
		encrypt(plaintext, context) {
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv('aes-256-gcm', activeKey, iv);
			cipher.setAAD(Buffer.from(context, 'utf8'));
			const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
			return new Uint8Array(Buffer.concat([Buffer.of(activeVersion), iv, cipher.getAuthTag(), ciphertext]));
		},

		decrypt(sealed, context) {
			const buffer = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
			if (buffer.length < HEADER_BYTES) throw new FieldDecryptionError(`ciphertext of ${context} is truncated`);
			const version = buffer.readUInt8(0);
			const key = keys.get(version);
			if (!key) throw new FieldDecryptionError(`key version ${version} of ${context} is not configured`);
			const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(1, 1 + IV_BYTES));
			decipher.setAAD(Buffer.from(context, 'utf8'));
			decipher.setAuthTag(buffer.subarray(1 + IV_BYTES, HEADER_BYTES));
			try {
				return Buffer.concat([decipher.update(buffer.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
			} catch (cause) {
				throw new FieldDecryptionError(`ciphertext of ${context} failed authentication`, { cause });
			}
		},

		lookupHmac(purpose, value) {
			return createHmac('sha256', lookupKey(purpose)).update(normalizers[purpose](value), 'utf8').digest('hex');
		},

		pseudonym(candidateId, companyId) {
			const digest = createHmac('sha256', lookupKey('candidate_pseudonym'))
				.update(`${candidateId}:${companyId}`, 'utf8')
				.digest();
			return base32(digest.subarray(0, 16));
		}
	};
}

let instance: FieldCrypto | undefined;

/** Field crypto over the configured keys, created on first use. */
export function fieldCrypto(): FieldCrypto {
	if (!instance) {
		const { fieldKeys, activeFieldKeyVersion, hmacSecret } = config().crypto;
		instance = createFieldCrypto({ keys: fieldKeys, activeVersion: activeFieldKeyVersion, hmacSecret });
	}
	return instance;
}
