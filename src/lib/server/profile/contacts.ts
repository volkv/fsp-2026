// The name and the contacts of the profile (docs/domain.md, section 7.1): one normal form for what the candidate types
// and for what the reading of a resume suggests (`resume-extract/v3`), so that an accepted suggestion and a typed value
// are compared and stored alike. Everything here is personal data: it is stored encrypted (crypto/fields.ts) and never
// enters the journal.

export interface FullName {
	last: string;
	first: string;
	middle: string | null;
}

/** Longest part of a name. */
export const NAME_PART_MAX = 100;

const NAME_WORD = /^\p{L}+(?:[-'’]\p{L}+)*$/u;

/** A part of a name as typed: letters with inner hyphens or apostrophes, or `null` when it is not such a word. */
export function namePart(written: string): string | null {
	const part = written.trim().replace(/\s+/gu, ' ');
	if (part.length === 0 || part.length > NAME_PART_MAX) return null;
	return part.split(' ').every((word) => NAME_WORD.test(word)) ? part : null;
}

/** «ИВАНОВ» and «иванов» as «Иванов»; a hyphenated name keeps each part capitalized. */
function capitalized(word: string): string {
	return word
		.split(/([-'’])/u)
		.map((piece) => {
			const [head = '', ...tail] = Array.from(piece);
			return `${head.toLocaleUpperCase('ru')}${tail.join('').toLocaleLowerCase('ru')}`;
		})
		.join('');
}

const PATRONYMIC = /(?:вич|вна|чна|ична|ич|оглы|кызы)$/iu;
const SURNAME = /(?:ов|ова|ев|ева|ёв|ёва|ин|ина|ын|ына|ский|ская|цкий|цкая|ской|ко|ук|юк|чук|енко|швили|дзе|ян|янц)$/iu;
const CYRILLIC = /\p{Script=Cyrillic}/u;

/**
 * The parts of a full name as a resume writes it at the top: two or three words of letters. A Russian name is read as
 * «Фамилия Имя [Отчество]» unless the patronymic or the surname shows another order («Иван Иванович Иванов», «Иван
 * Петров»); a Latin one as «First [Middle] Last». `null` — not a name. The candidate checks the reading anyway.
 */
export function parseFullName(written: string): FullName | null {
	const words = written.trim().split(/\s+/u);
	if (words.length < 2 || words.length > 3 || !words.every((word) => NAME_WORD.test(word))) return null;
	if (words.some((word) => word.length > NAME_PART_MAX)) return null;
	const [a, b, c] = words.map(capitalized);
	if (a === undefined || b === undefined) return null;
	if (!CYRILLIC.test(written)) {
		return c === undefined ? { first: a, last: b, middle: null } : { first: a, middle: b, last: c };
	}
	if (c !== undefined) {
		if (PATRONYMIC.test(b) && !PATRONYMIC.test(c)) return { first: a, middle: b, last: c };
		return { last: a, first: b, middle: c };
	}
	if (SURNAME.test(b) && !SURNAME.test(a)) return { first: a, last: b, middle: null };
	return { last: a, first: b, middle: null };
}

/** «Фамилия Имя Отчество». */
export function fullNameText(name: FullName): string {
	return [name.last, name.first, name.middle].filter((part) => part !== null).join(' ');
}

/**
 * A name as the holder commitment of a confirmation takes it (domain 12.9): one space between the words, lower case,
 * «ё» as «е» — so the holder may write it as they like, in the order «Фамилия Имя Отчество».
 */
export function normalizeNameText(written: string): string {
	return written.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/gu, ' ').trim();
}

export const normalizedFullName = (name: FullName): string => normalizeNameText(fullNameText(name));

/** A phone as `+<digits>`: a Russian number in any common spelling becomes `+7XXXXXXXXXX`; `null` — not a phone. */
export function normalizePhone(written: string): string | null {
	const trimmed = written.trim();
	if (!/^\+?[\d\s()‐-]+$/u.test(trimmed)) return null;
	const digits = trimmed.replace(/\D/gu, '');
	if (!trimmed.startsWith('+')) {
		if (digits.length === 11 && (digits.startsWith('8') || digits.startsWith('7'))) return `+7${digits.slice(1)}`;
		if (digits.length === 10 && digits.startsWith('9')) return `+7${digits}`;
		return null;
	}
	return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]{2,}$/u;

/** An e-mail address in lower case; `null` — not an address. */
export function normalizeEmail(written: string): string | null {
	const address = written.trim().toLowerCase();
	return address.length <= 254 && EMAIL.test(address) ? address : null;
}

const TELEGRAM = /^(?:(?:https?:\/\/)?(?:t\.me|telegram\.me)\/|@)?([A-Za-z][A-Za-z0-9_]{4,31})$/u;

/** A Telegram username as `@name` from `@name`, `t.me/name` or the bare name; `null` — not a username. */
export function normalizeTelegram(written: string): string | null {
	const match = TELEGRAM.exec(written.trim());
	return match?.[1] ? `@${match[1]}` : null;
}
