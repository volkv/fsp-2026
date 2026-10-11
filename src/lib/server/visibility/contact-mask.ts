// Contacts inside the candidate's free text (docs/domain.md, sections 13.6, 14): a company learns how to reach the
// candidate only by the disclosure — the candidate's acceptance of its offer or their own application to it. Until then
// every text of the candidate the company reads (a solution of a call, the reason of a declined offer, the message of
// a withdrawn application) goes through `maskContacts`: addresses, phones, messengers, social and personal links and
// `@handles` become one neutral label. The candidate always reads their own text as written.
//
// Links to the profiles the card shows as sources (GitHub, Codeforces) are masked too: the card shows a verified
// profile only by the adult candidate's choice (`external_profiles`), and a link in a text would bypass both the choice
// and the age rule. Links to public references (documentation, encyclopedias) name no person and are kept.
//
// Technical text stays readable: versions (`C++17`, `3.12.1`), dates, numbers of solutions, decorators and
// annotations at the start of a line, `a @ b`, addresses of reserved test domains (`example.com`, `.test`). What is
// not recognized: a contact written without its form (`телеграм ivan_dev`), a bare personal domain outside
// `.ru/.рф/.su/.com` without a scheme (`ivanov.dev`) — in code such words are calls and fields (`self.net`, `log.info`).

export const CONTACT_MASK = '[контакт скрыт до принятия]';

/** Hosts of public references: a link to them names no person. */
const REFERENCE_HOSTS = [
	'cppreference.com',
	'developer.mozilla.org',
	'docs.python.org',
	'wikipedia.org',
	'cp-algorithms.com',
	'e-maxx.ru',
	'learn.microsoft.com',
	'doc.rust-lang.org',
	'go.dev',
	'docs.oracle.com',
	'kotlinlang.org',
	'typescriptlang.org',
	'postgresql.org'
];

/** Hosts of messengers, social networks and profile sites: a link to them names a person even without a scheme. */
const CONTACT_HOSTS = [
	't\\.me',
	'telegram\\.(?:me|dog)',
	'wa\\.me',
	'whatsapp\\.com',
	'vk\\.(?:com|me|ru)',
	'ok\\.ru',
	'instagram\\.com',
	'facebook\\.com',
	'fb\\.com',
	'linkedin\\.com',
	'twitter\\.com',
	'x\\.com',
	'discord\\.(?:gg|com)',
	'github\\.com',
	'gitlab\\.com',
	'codeforces\\.com',
	'leetcode\\.com',
	'habr\\.com',
	'hh\\.ru',
	'youtube\\.com',
	'tiktok\\.com',
	'dzen\\.ru'
].join('|');

/** Reserved for examples and tests (RFC 2606): an address there reaches nobody. */
const RESERVED_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/iu;

/** Punctuation that ends a sentence after a link rather than belonging to it. */
const TRAILING = /[.,;:!?)\]}»"']+$/u;

function hostOf(url: string): string {
	const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '').replace(/^www\./iu, '');
	return (withoutScheme.split(/[/?#:]/u)[0] ?? '').toLowerCase();
}

const isReference = (host: string) =>
	REFERENCE_HOSTS.some((reference) => host === reference || host.endsWith(`.${reference}`));

/** Replaces a matched link with the label and returns the sentence punctuation the match swallowed. */
function maskLink(match: string, keepReferences: boolean): string {
	const trailing = TRAILING.exec(match)?.[0] ?? '';
	const link = match.slice(0, match.length - trailing.length);
	if (keepReferences && isReference(hostOf(link))) return match;
	return CONTACT_MASK + trailing;
}

const digitCount = (value: string) => value.replace(/\D/gu, '').length;

/** The text of the line before `offset`: only indentation and comment marks — the `@` opens a decorator or a tag. */
function atCodeLineStart(text: string, offset: number): boolean {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	return /^[\s*/#]*$/u.test(text.slice(lineStart, offset));
}

interface Rule {
	pattern: RegExp;
	replace: (match: string, offset: number, text: string) => string;
}

const RULES: Rule[] = [
	// Links with a scheme or `www.`, and schemes of messengers.
	{
		pattern: /(?:\b(?:https?|ftp):\/\/|\bwww\.)[^\s<>"'`]+/giu,
		replace: (match) => maskLink(match, true)
	},
	{
		pattern: /\b(?:mailto|tg|viber|skype|whatsapp|callto|tel):[^\s<>"'`]+/giu,
		replace: (match) => maskLink(match, false)
	},
	// `git@github.com:owner/repo`: the account is in the path.
	{
		pattern: /(?<![\w.+-])[\w.-]+@[a-z0-9.-]+\.[a-z]{2,}:[\w./~-]+/giu,
		replace: (match) => maskLink(match, false)
	},
	// Email addresses, Cyrillic domains included; reserved test domains are kept.
	{
		pattern: /(?<![\w.+-])[\p{L}\d._%+-]+@(?:[\p{L}\d-]+\.)+\p{L}{2,24}(?![\p{L}\d-])/giu,
		replace: (match) => (RESERVED_EMAIL_DOMAIN.test(match.split('@')[1] ?? '') ? match : CONTACT_MASK)
	},
	// Profiles on known hosts without a scheme: `t.me/ivan`, `vk.com/id1`, `github.com/ivan`.
	{
		pattern: new RegExp(`(?<![\\w.@/-])(?:[a-z0-9-]+\\.)*(?:${CONTACT_HOSTS})\\/[^\\s<>"'\`]+`, 'giu'),
		replace: (match) => maskLink(match, false)
	},
	// A bare personal domain of the common zones: `ivanov.ru`, `иванов.рф`; not a call (`obj.com(`) nor a path.
	{
		pattern:
			/(?<![\p{L}\d_.@/-])(?:[\p{Ll}\d-]{2,}\.)+(?:ru|рф|su|com)(?:\/[^\s<>"'`]*)?(?![\p{L}\d_(-]|\.[\p{L}\d])/gu,
		replace: (match) => maskLink(match, true)
	},
	// International phones: `+7 (912) 345-67-89`, `+44 20 7946 0958`; 10–15 digits.
	{
		pattern: /(?<![\w+)\]])\+\d(?:[\s().-]{0,2}\d){9,14}(?!\d)/gu,
		replace: (match) => (digitCount(match) >= 10 ? CONTACT_MASK : match)
	},
	// Russian phones without `+`: `8 (912) 345-67-89`, `89123456789`, `7-912-345-67-89`.
	{
		pattern: /(?<![\w+.,/-])[78][\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?![\w-]|[.,/]\d)/gu,
		replace: () => CONTACT_MASK
	},
	// A ten-digit Russian number with its code marked: `(912) 345-67-89`, `912-345-67-89`.
	{
		pattern: /(?<![\w+.,/-])(?:\(\d{3}\)\s?\d{3}[\s-]?\d{2}[\s-]?\d{2}|\d{3}-\d{3}-\d{2}-\d{2})(?![\w-]|[.,/]\d)/gu,
		replace: () => CONTACT_MASK
	},
	// `@handle` of Telegram, VK, Instagram and the like; a decorator or a doc tag at the start of a line is code.
	{
		pattern: /(?<![\w@.`/])@[A-Za-z][A-Za-z0-9_]{3,31}(?![\w(]|\.\w)/gu,
		replace: (match, offset, text) => (atCodeLineStart(text, offset) ? match : CONTACT_MASK)
	}
];

/** The text with every recognized contact replaced by `CONTACT_MASK`; a text without contacts is returned as is. */
export function maskContacts(text: string): string {
	return RULES.reduce(
		(current, rule) =>
			current.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
				// The arguments after the groups are the offset and the whole text (no rule has named groups).
				const offset = rest.at(-2);
				const whole = rest.at(-1);
				if (typeof offset !== 'number' || typeof whole !== 'string') throw new Error('unexpected replace arguments');
				return rule.replace(match, offset, whole);
			}),
		text
	);
}

/** A text of the candidate as the company reads it: as written once it holds the contacts, masked before. */
export function candidateTextForCompany(text: string, holdsContacts: boolean): string {
	return holdsContacts ? text : maskContacts(text);
}
