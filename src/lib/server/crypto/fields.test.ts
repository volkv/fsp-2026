import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { createFieldCrypto, FieldDecryptionError } = await import('./fields');

const keyA = Buffer.alloc(32, 7);
const keyB = Buffer.alloc(32, 9);
const hmacSecret = Buffer.alloc(32, 3);

const cryptoV1 = createFieldCrypto({ keys: new Map([[1, keyA]]), activeVersion: 1, hmacSecret });
const cryptoV2 = createFieldCrypto({
	keys: new Map([
		[1, keyA],
		[2, keyB]
	]),
	activeVersion: 2,
	hmacSecret
});

describe('field encryption', () => {
	it('round-trips a value and never stores it in the clear', () => {
		const sealed = cryptoV1.encrypt('Иванова Мария', 'candidates.last_name');
		expect(Buffer.from(sealed).includes(Buffer.from('Иванова'))).toBe(false);
		expect(cryptoV1.decrypt(sealed, 'candidates.last_name')).toBe('Иванова Мария');
	});

	it('uses a fresh IV, so equal values give different ciphertexts', () => {
		const a = cryptoV1.encrypt('a@example.org', 'users.email');
		const b = cryptoV1.encrypt('a@example.org', 'users.email');
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
	});

	it('binds the ciphertext to its column', () => {
		const sealed = cryptoV1.encrypt('+79990000000', 'candidates.phone');
		expect(() => cryptoV1.decrypt(sealed, 'users.email')).toThrow(FieldDecryptionError);
	});

	it('detects tampering', () => {
		const sealed = cryptoV1.encrypt('secret', 'users.email');
		const last = sealed.length - 1;
		sealed.set([(sealed.at(-1) ?? 0) ^ 1], last);
		expect(() => cryptoV1.decrypt(sealed, 'users.email')).toThrow(/failed authentication/);
	});

	it('decrypts values of a previous key after rotation', () => {
		const old = cryptoV1.encrypt('old value', 'users.email');
		const fresh = cryptoV2.encrypt('new value', 'users.email');
		expect(fresh[0]).toBe(2);
		expect(cryptoV2.decrypt(old, 'users.email')).toBe('old value');
		expect(() => cryptoV1.decrypt(fresh, 'users.email')).toThrow(/key version 2/);
	});
});

describe('keyed lookups', () => {
	it('normalizes email before hashing', () => {
		expect(cryptoV1.lookupHmac('email', '  Anna@Example.ORG ')).toBe(cryptoV1.lookupHmac('email', 'anna@example.org'));
		expect(cryptoV1.lookupHmac('email', 'anna@example.org')).toMatch(/^[0-9a-f]{64}$/);
	});

	it('separates purposes, so equal inputs of different purposes do not collide', () => {
		expect(cryptoV1.lookupHmac('email', '12345')).not.toBe(cryptoV1.lookupHmac('telegram_chat', '12345'));
	});

	it('is independent of the encryption key and stable across rotation', () => {
		expect(cryptoV2.lookupHmac('email', 'a@b.c')).toBe(cryptoV1.lookupHmac('email', 'a@b.c'));
	});
});

describe('pseudonyms', () => {
	it('differ between companies and are stable for one company', () => {
		const a = cryptoV1.pseudonym('candidate-1', 'company-a');
		expect(a).toBe(cryptoV1.pseudonym('candidate-1', 'company-a'));
		expect(a).not.toBe(cryptoV1.pseudonym('candidate-1', 'company-b'));
		expect(a).toMatch(/^[a-z2-7]{26}$/);
	});
});
