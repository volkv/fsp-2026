// Canonical JSON: the same content always gives the same text, so its hash can be stored and compared later, after
// the value has been read back from jsonb. Imported by plain Node (scripts/seed-taxonomy.ts through the taxonomy
// release): no imports, erasable syntax only.

/**
 * JSON with object keys sorted at every level; `undefined` object members are dropped as in `JSON.stringify`.
 * Anything jsonb would not keep as is — a non-finite number, a class instance, `undefined` outside an object — throws.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError(`non-finite number ${value}`);
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
	if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, member]) => member !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([name, member]) => `${JSON.stringify(name)}:${canonicalJson(member)}`).join(',')}}`;
	}
	throw new TypeError(`value of type ${typeof value} is not JSON`);
}
