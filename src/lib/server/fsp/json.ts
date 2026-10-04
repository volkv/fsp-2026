/** JSON of a text, or `undefined` when the text is not JSON: answers of other services are data, not code. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}
