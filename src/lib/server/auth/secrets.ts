// Random bearer secrets (session ids, email tokens, OIDC state) and their stored form.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes in base64url: the value handed to the browser or put into a link. */
export function newSecret(): string {
	return randomBytes(32).toString('base64url');
}

/** SHA-256 in lowercase hex: only this form is stored, so a leaked store does not reveal usable secrets. */
export function sha256Hex(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two strings. */
export function secretsEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');
	return left.length === right.length && timingSafeEqual(left, right);
}
