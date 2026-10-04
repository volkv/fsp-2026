// Handles of the external platforms as the candidate types them: the bare handle or the address of the profile page.
import { randomInt } from 'node:crypto';
import type { ExternalPlatform } from './types';

const PATTERNS: Record<ExternalPlatform, RegExp> = {
	// Letters, digits, underscore, dot and hyphen, 3–24 characters.
	codeforces: /^[A-Za-z0-9_.-]{3,24}$/,
	// Letters, digits and single inner hyphens, up to 39 characters.
	github: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
};

const PROFILE_URLS: Record<ExternalPlatform, RegExp> = {
	codeforces: /^(?:https?:\/\/)?(?:www\.|m\d?\.)?codeforces\.(?:com|ru)\/profile\/([^/?#\s]+)\/?(?:[?#].*)?$/i,
	github: /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/?(?:[?#].*)?$/i
};

/** The handle from what the candidate typed, or `null` when it is not a handle of the platform. */
export function parseHandle(platform: ExternalPlatform, input: string): string | null {
	const trimmed = input.trim().replace(/^@/, '');
	const handle = PROFILE_URLS[platform].exec(trimmed)?.[1] ?? trimmed;
	return PATTERNS[platform].test(handle) ? handle : null;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const CODE_LENGTH = 12;

/**
 * A one-time code: `fsp` and random lowercase Latin letters, about 56 bits. Letters only, so that it fits a name
 * field of Codeforces as well as a file name of a gist.
 */
export function challengeCode(): string {
	let code = 'fsp';
	for (let i = 0; i < CODE_LENGTH; i++) code += LETTERS.charAt(randomInt(LETTERS.length));
	return code;
}
