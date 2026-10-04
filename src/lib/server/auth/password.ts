// Passwords: Argon2id in PHC form with the parameters inside the string (domain 3.2, minimum m=19456, t=2, p=1).
import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** Parameters of new hashes; stored hashes below them are recomputed on the next sign-in. */
const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 10;
/** Upper bound keeps hashing cost bounded for a request body of any size. */
export const PASSWORD_MAX_LENGTH = 128;

export async function hashPassword(password: string): Promise<string> {
	// The library default algorithm is Argon2id; the parameters are stated explicitly.
	return hash(password, PARAMS);
}

/**
 * A hash of a password nobody has. Checking an unknown account costs as much as checking a known one,
 * so the response time does not tell which addresses are registered.
 */
let decoy: Promise<string> | undefined;

export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
	if (stored === null) {
		decoy ??= hashPassword(randomBytes(32).toString('base64url'));
		await verify(await decoy, password);
		return false;
	}
	return verify(stored, password);
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

/** Whether a stored hash uses another algorithm or weaker parameters than new hashes. */
export function needsRehash(stored: string): boolean {
	const match = PHC.exec(stored);
	if (!match) return true;
	const [memory, time, lanes] = [Number(match[1]), Number(match[2]), Number(match[3])];
	return memory < PARAMS.memoryCost || time < PARAMS.timeCost || lanes < PARAMS.parallelism;
}

/** Problems of a new password; an empty list means it is acceptable. */
export function passwordProblems(password: string, email: string | null): string[] {
	const problems: string[] = [];
	// Code points: a letter outside the basic plane counts once.
	const length = Array.from(password).length;
	if (length < PASSWORD_MIN_LENGTH) problems.push(`Пароль — не короче ${PASSWORD_MIN_LENGTH} символов`);
	if (length > PASSWORD_MAX_LENGTH) problems.push(`Пароль — не длиннее ${PASSWORD_MAX_LENGTH} символов`);
	if (new Set(password).size < 4) problems.push('В пароле должно быть хотя бы 4 разных символа');
	if (email !== null && password.trim().toLowerCase() === email.trim().toLowerCase()) {
		problems.push('Пароль не должен совпадать с адресом почты');
	}
	return problems;
}
