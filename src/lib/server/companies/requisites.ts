// Company requisites checked locally (domain 5.1): taxpayer number (ИНН) with its check digits, primary state
// registration number (ОГРН / ОГРНИП) with its check digit, tax registration reason code (КПП) by format.
import { isValidInn } from '$lib/server/auth/inn';

export type InnKind = 'organization' | 'entrepreneur';

/** 10 digits — an organization, 12 — an individual entrepreneur; `null` for an invalid number. */
export function innKind(inn: string): InnKind | null {
	if (!isValidInn(inn)) return null;
	return inn.length === 10 ? 'organization' : 'entrepreneur';
}

/** ОГРН: 13 digits, the last is (first 12 mod 11) mod 10; ОГРНИП: 15 digits, (first 14 mod 13) mod 10. */
export function isValidOgrn(value: string): boolean {
	if (!/^(\d{13}|\d{15})$/.test(value)) return false;
	const body = BigInt(value.slice(0, -1));
	const divisor = value.length === 13 ? 11n : 13n;
	return Number((body % divisor) % 10n) === Number(value.at(-1));
}

/** КПП: 4 digits of the tax office, 2 characters of the reason, 3 digits of the serial number. */
export function isValidKpp(value: string): boolean {
	return /^\d{4}[\dA-Z]{2}\d{3}$/.test(value);
}
