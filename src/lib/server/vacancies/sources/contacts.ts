// Contacts of people never reach storage (docs/domain.md, section 13.2; contracts 7.2): e-mail addresses, phone
// numbers, messenger handles and links to personal profiles are cut out of a stored description before it leaves
// the adapter.

const PATTERNS: readonly RegExp[] = [
	// E-mail.
	/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu,
	// Links to messengers and personal profiles.
	/(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|wa\.me|vk\.com|linkedin\.com\/in|instagram\.com|facebook\.com|ok\.ru)\/[^\s<>"',;)]+/giu,
	// Messenger handles: @name, not part of an e-mail (those are removed above).
	/(?<![\p{L}\p{N}._%+-])@[A-Za-z][A-Za-z0-9_]{3,}/gu,
	// Phone numbers: +7 / 8 and ten digits in any grouping, or an international number.
	/(?<![\p{N}])(?:\+7|8)[\s\-(]*\d{3}[\s\-)]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?![\p{N}])/gu,
	/(?<![\p{N}])\+\d{1,3}[\s\-(]*\d{2,4}[\s\-)]*\d{2,4}[\s-]*\d{2,4}(?:[\s-]*\d{2,4})?(?![\p{N}])/gu
];

const PLACEHOLDER = '[контакт удалён]';

/** The text without contacts, and whether anything was removed. */
export function removeContacts(text: string): { text: string; removed: boolean } {
	let result = text;
	let removed = false;
	for (const pattern of PATTERNS) {
		result = result.replace(pattern, () => {
			removed = true;
			return PLACEHOLDER;
		});
	}
	return { text: result, removed };
}
