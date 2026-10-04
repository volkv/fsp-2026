// Test doubles of the source HTTP client.
/** A `fetch` answering from a table of URLs; any other URL is a test error. */
export function tableFetch(
	table: Record<string, { status: number; body: string; headers?: Record<string, string> }>,
	requests: string[] = []
) {
	return (input: string): Promise<Response> => {
		requests.push(input);
		const entry = table[input];
		if (!entry) return Promise.reject(new Error(`unexpected request ${input}`));
		return Promise.resolve(new Response(entry.body, { status: entry.status, headers: entry.headers ?? {} }));
	};
}
