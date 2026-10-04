// Public API of Codeforces (https://codeforces.com/apiHelp), anonymous methods only: `user.info` for the fields a
// person edits in the settings (first and last name, organization) and the rating, `user.rating` for rated contests,
// `user.status` for solved problems. The API allows one call per two seconds from an address, so calls of one reading
// are spaced.
import { z } from 'zod';
import { jsonOf, retryAfterOf, sourceGet, SourceUnavailable, type PlatformHttp, type SourceAnswer } from './http';

export interface CodeforcesClient {
	http: PlatformHttp;
	baseUrl: string;
	/** Pause between two calls of one reading (the API's call limit). */
	callIntervalMs: number;
	now: () => Date;
}

const envelope = z.discriminatedUnion('status', [
	z.object({ status: z.literal('OK'), result: z.unknown() }),
	z.object({ status: z.literal('FAILED'), comment: z.string() })
]);

const userSchema = z.object({
	handle: z.string().min(1),
	firstName: z.string().optional(),
	lastName: z.string().optional(),
	organization: z.string().optional(),
	rating: z.int().optional(),
	maxRating: z.int().optional(),
	rank: z.string().optional(),
	maxRank: z.string().optional(),
	registrationTimeSeconds: z.int()
});
export type CodeforcesUser = z.output<typeof userSchema>;

const ratingChange = z.object({ contestId: z.int(), ratingUpdateTimeSeconds: z.int() });
const submission = z.object({
	verdict: z.string().optional(),
	problem: z.object({ contestId: z.int().optional(), problemsetName: z.string().optional(), index: z.string() })
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The result of a call, `null` when the source answers that the user does not exist. */
async function call(client: CodeforcesClient, path: string): Promise<unknown> {
	const answer: SourceAnswer = await sourceGet(client.http, `${client.baseUrl}/${path}`, 'application/json');
	// The call limit comes as a JSON refusal with a server status; any other server failure is a page of the proxy.
	const serverError = answer.status >= 500;
	if (serverError && !answer.body.trimStart().startsWith('{')) {
		throw new SourceUnavailable('server_error', `codeforces answered ${answer.status}`);
	}
	const parsed = envelope.safeParse(jsonOf(answer));
	if (!parsed.success) {
		throw new SourceUnavailable(
			serverError ? 'server_error' : 'protocol_error',
			`codeforces answer with status ${answer.status} has another shape`
		);
	}
	if (parsed.data.status === 'OK') return parsed.data.result;
	const comment = parsed.data.comment;
	if (/not found/i.test(comment)) return null;
	if (/call limit/i.test(comment)) {
		throw new SourceUnavailable(
			'rate_limited',
			'codeforces call limit exceeded',
			retryAfterOf(answer.headers, client.now()) ?? 2
		);
	}
	throw new SourceUnavailable('protocol_error', `codeforces refused the call with status ${answer.status}`);
}

/**
 * The user by handle (any letter case), `null` when there is none. `historic` — a handle the user has since changed
 * finds them too (a reading of a verified profile); a check of ownership takes the current handle only.
 */
export async function codeforcesUser(
	client: CodeforcesClient,
	handle: string,
	options: { historic: boolean }
): Promise<CodeforcesUser | null> {
	const result = await call(
		client,
		`user.info?handles=${encodeURIComponent(handle)}&checkHistoricHandles=${String(options.historic)}`
	);
	if (result === null) return null;
	const users = z.array(userSchema).safeParse(result);
	if (!users.success || users.data.length !== 1) {
		throw new SourceUnavailable('protocol_error', 'codeforces user.info answered another shape');
	}
	return users.data[0] ?? null;
}

/** Whether the code stands in a field the person edits in the settings: first name, last name or organization. */
export function codeforcesHasCode(user: CodeforcesUser, code: string): boolean {
	const needle = code.toLowerCase();
	return [user.firstName, user.lastName, user.organization].some((field) => field?.toLowerCase().includes(needle));
}

export interface CodeforcesReading {
	handle: string;
	rating: number | null;
	maxRating: number | null;
	rank: string | null;
	maxRank: string | null;
	/** Distinct problems with an accepted submission. */
	solvedCount: number;
	ratedContests: number;
	/** Day of the last rating change, UTC. */
	lastRatedOn: string | null;
	registeredOn: string;
}

const dayOf = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

/**
 * The public statistics of a user already read by `user.info`: rated contests and distinct solved problems. `null` —
 * the user disappeared between the calls.
 */
export async function codeforcesReading(
	client: CodeforcesClient,
	user: CodeforcesUser
): Promise<CodeforcesReading | null> {
	await sleep(client.callIntervalMs);
	const ratingResult = await call(client, `user.rating?handle=${encodeURIComponent(user.handle)}`);
	if (ratingResult === null) return null;
	const changes = z.array(ratingChange).safeParse(ratingResult);
	if (!changes.success) throw new SourceUnavailable('protocol_error', 'codeforces user.rating answered another shape');

	await sleep(client.callIntervalMs);
	const statusResult = await call(client, `user.status?handle=${encodeURIComponent(user.handle)}`);
	if (statusResult === null) return null;
	const submissions = z.array(submission).safeParse(statusResult);
	if (!submissions.success)
		throw new SourceUnavailable('protocol_error', 'codeforces user.status answered another shape');
	const solved = new Set<string>();
	for (const item of submissions.data) {
		if (item.verdict !== 'OK') continue;
		const { contestId, problemsetName, index } = item.problem;
		solved.add(`${contestId ?? problemsetName ?? '?'}:${index}`);
	}

	const last = changes.data.reduce<number | null>(
		(latest, change) =>
			latest === null || change.ratingUpdateTimeSeconds > latest ? change.ratingUpdateTimeSeconds : latest,
		null
	);
	return {
		handle: user.handle,
		rating: user.rating ?? null,
		maxRating: user.maxRating ?? null,
		rank: user.rank ?? null,
		maxRank: user.maxRank ?? null,
		solvedCount: solved.size,
		ratedContests: changes.data.length,
		lastRatedOn: last === null ? null : dayOf(last),
		registeredOn: dayOf(user.registrationTimeSeconds)
	};
}
