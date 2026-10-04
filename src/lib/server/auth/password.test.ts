import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, passwordProblems, verifyPassword } from './password';

describe('passwords', () => {
	it('hashes with Argon2id at the minimum parameters of the model and verifies', async () => {
		const stored = await hashPassword('correct horse battery');
		expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
		expect(needsRehash(stored)).toBe(false);
		expect(await verifyPassword(stored, 'correct horse battery')).toBe(true);
		expect(await verifyPassword(stored, 'correct horse battery!')).toBe(false);
		// An unknown account is checked against a decoy and never matches.
		expect(await verifyPassword(null, 'correct horse battery')).toBe(false);
	});

	it('asks to recompute weaker or foreign hashes', () => {
		expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA')).toBe(true);
		expect(needsRehash('$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
		expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
	});

	it('names the problems of a new password', () => {
		expect(passwordProblems('short', null)).toHaveLength(1);
		expect(passwordProblems('aaaaaaaaaaaa', null)).toEqual(['В пароле должно быть хотя бы 4 разных символа']);
		expect(passwordProblems('Me@Example.org', 'me@example.org')).toEqual([
			'Пароль не должен совпадать с адресом почты'
		]);
		expect(passwordProblems('correct horse battery', 'me@example.org')).toEqual([]);
	});
});
