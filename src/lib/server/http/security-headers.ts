/**
 * Response headers applied to every response. Script and style sources are a matter of the SvelteKit CSP
 * configuration (it adds nonces); this policy only carries directives independent of page content,
 * and yields to a policy the framework has already set.
 *
 * Imported by vite.config.ts as well, so this module has no imports and stays free of server-only code.
 */

/** A CSP keyword, written without quotes as in the SvelteKit `csp` option; the header quotes it. */
type CspKeyword = 'self' | 'none';

/**
 * Directives of every response: this header and the page policy of `kit.csp` (vite.config.ts), which replaces this
 * header on rendered pages. Fresh arrays on every call: the framework option takes mutable ones.
 */
export function coreCspDirectives(): {
	'frame-ancestors': CspKeyword[];
	'base-uri': CspKeyword[];
	'object-src': CspKeyword[];
} {
	return { 'frame-ancestors': ['none'], 'base-uri': ['self'], 'object-src': ['none'] };
}

export const CORE_CSP = Object.entries(coreCspDirectives())
	.map(([name, sources]) => `${name} ${sources.map((source) => `'${source}'`).join(' ')}`)
	.join('; ');

export function applySecurityHeaders(headers: Headers, options: { https: boolean; api: boolean }): void {
	headers.set('x-content-type-options', 'nosniff');
	headers.set('x-frame-options', 'DENY');
	// Pseudonyms and case identifiers appear in paths; they must not leak to other sites.
	headers.set('referrer-policy', 'same-origin');
	headers.set('cross-origin-opener-policy', 'same-origin');
	headers.set('cross-origin-resource-policy', 'same-origin');
	headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
	if (!headers.has('content-security-policy')) {
		headers.set('content-security-policy', CORE_CSP);
	}
	if (options.https) {
		headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
	}
	if (options.api && !headers.has('cache-control')) {
		headers.set('cache-control', 'no-store');
	}
}
