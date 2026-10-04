// Where to send the person after sign-in. The value comes from the request, so only a path inside the application is
// accepted: `https://evil.example`, `//evil.example` and `/\evil.example` would all leave the origin.

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** A relative path of the application, or `null` when the value cannot be trusted. */
export function safeReturnTo(raw: string | null | undefined): string | null {
	if (raw === null || raw === undefined || raw === '' || raw.length > 512) return null;
	if (hasControlCharacter(raw) || !raw.startsWith('/')) return null;
	if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
	return raw;
}
