// Public REST API of GitHub (https://docs.github.com/rest), without a token 60 requests an hour from an address, so a
// reading is kept to a few calls — the account, the list of its repositories, and the languages of the most recently
// pushed own repositories. Forks are not the person's code and are left out.
import { z } from 'zod';
import { jsonOf, retryAfterOf, sourceGet, SourceUnavailable, type PlatformHttp, type SourceAnswer } from './http';

export interface GithubClient {
	http: PlatformHttp;
	baseUrl: string;
	/** Own repositories whose languages are read, most recently pushed first. */
	languageRepos: number;
	/** Raises the limit from 60 to 5000 requests an hour; the data read is public either way. */
	token: string | null;
	now: () => Date;
}

const JSON_ACCEPT = 'application/vnd.github+json';

/** Throws for statuses that are not an answer: the rate limit, server failures and anything unexpected. */
function checkStatus(client: GithubClient, answer: SourceAnswer, what: string): void {
	const { status, headers } = answer;
	if (status === 200 || status === 404) return;
	if (status === 429 || (status === 403 && headers.get('x-ratelimit-remaining') === '0')) {
		throw new SourceUnavailable('rate_limited', 'github rate limit reached', retryAfterOf(headers, client.now()));
	}
	if (status === 403 && headers.get('retry-after') !== null) {
		// The secondary rate limit.
		throw new SourceUnavailable('rate_limited', 'github secondary rate limit', retryAfterOf(headers, client.now()));
	}
	if (status >= 500) throw new SourceUnavailable('server_error', `github ${what} answered ${status}`);
	throw new SourceUnavailable('protocol_error', `github ${what} answered ${status}`);
}

async function get(client: GithubClient, path: string, what: string, accept = JSON_ACCEPT): Promise<SourceAnswer> {
	const auth: Record<string, string> = client.token === null ? {} : { authorization: `Bearer ${client.token}` };
	const answer = await sourceGet(client.http, `${client.baseUrl}${path}`, accept, auth);
	checkStatus(client, answer, what);
	return answer;
}

function parse<S extends z.ZodType>(schema: S, answer: SourceAnswer, what: string): z.output<S> {
	const parsed = schema.safeParse(jsonOf(answer));
	if (!parsed.success) throw new SourceUnavailable('protocol_error', `github ${what} answered another shape`);
	return parsed.data;
}

const userSchema = z.object({
	login: z.string().min(1),
	id: z.int(),
	type: z.string(),
	public_repos: z.int().min(0),
	created_at: z.string()
});
export type GithubUser = z.output<typeof userSchema>;

/** The account by login, `null` when there is none (or it is an organization, not a person). */
export async function githubUser(client: GithubClient, login: string): Promise<GithubUser | null> {
	const answer = await get(client, `/users/${encodeURIComponent(login)}`, 'user');
	if (answer.status === 404) return null;
	const user = parse(userSchema, answer, 'user');
	return user.type === 'User' ? user : null;
}

/** The account by its stable id: a renamed account is found under its new login. */
export async function githubUserById(client: GithubClient, id: string): Promise<GithubUser | null> {
	const answer = await get(client, `/user/${encodeURIComponent(id)}`, 'user');
	if (answer.status === 404) return null;
	const user = parse(userSchema, answer, 'user');
	return user.type === 'User' ? user : null;
}

const gistSchema = z.array(z.object({ description: z.string().nullable(), files: z.record(z.string(), z.unknown()) }));

/**
 * Whether the code stands in a public gist of the account (its description or a file name) or in the README of the
 * profile repository `<login>/<login>`. Only the account's owner can put it in either.
 */
export async function githubHasCode(client: GithubClient, login: string, code: string): Promise<boolean> {
	const needle = code.toLowerCase();
	const gistsAnswer = await get(client, `/users/${encodeURIComponent(login)}/gists?per_page=100`, 'gists');
	if (gistsAnswer.status === 200) {
		const gists = parse(gistSchema, gistsAnswer, 'gists');
		const found = gists.some(
			(gist) =>
				(gist.description ?? '').toLowerCase().includes(needle) ||
				Object.keys(gist.files).some((name) => name.toLowerCase().includes(needle))
		);
		if (found) return true;
	}
	const readme = await get(
		client,
		`/repos/${encodeURIComponent(login)}/${encodeURIComponent(login)}/readme`,
		'readme',
		'application/vnd.github.raw+json'
	);
	return readme.status === 200 && readme.body.toLowerCase().includes(needle);
}

const repoSchema = z.array(
	z.object({
		name: z.string(),
		fork: z.boolean(),
		language: z.string().nullable(),
		pushed_at: z.string().nullable()
	})
);
const languagesSchema = z.record(z.string(), z.int().min(0));

export interface GithubLanguage {
	name: string;
	/** Share of the bytes of the read repositories, two decimals. */
	share: number;
	/** Own repositories whose main language it is. */
	repos: number;
}

export interface GithubReading {
	login: string;
	id: string;
	publicRepos: number;
	ownRepos: number;
	/** Own repositories whose languages were read by bytes. */
	reposRead: number;
	languages: GithubLanguage[];
	/** Month of the last push to an own repository, UTC. */
	lastPushMonth: string | null;
	/** Own repositories pushed within a year before the reading. */
	reposPushedLastYear: number;
	createdOn: string;
}

const MIN_SHARE = 0.01;
const MAX_LANGUAGES = 8;

/** Languages of the account's own public repositories and how active they are. */
export async function githubReading(client: GithubClient, user: GithubUser): Promise<GithubReading> {
	const login = encodeURIComponent(user.login);
	const repos = parse(
		repoSchema,
		await get(client, `/users/${login}/repos?type=owner&sort=pushed&per_page=100`, 'repos'),
		'repos'
	).filter((repo) => !repo.fork);

	const primary = new Map<string, number>();
	for (const repo of repos) if (repo.language) primary.set(repo.language, (primary.get(repo.language) ?? 0) + 1);

	const bytes = new Map<string, number>();
	const read = repos.slice(0, client.languageRepos);
	for (const repo of read) {
		const answer = await get(client, `/repos/${login}/${encodeURIComponent(repo.name)}/languages`, 'languages');
		// A repository removed between the calls is simply not counted.
		if (answer.status === 404) continue;
		for (const [name, count] of Object.entries(parse(languagesSchema, answer, 'languages'))) {
			bytes.set(name, (bytes.get(name) ?? 0) + count);
		}
	}
	const total = [...bytes.values()].reduce((sum, value) => sum + value, 0);
	const languages = [...bytes.entries()]
		.map(([name, count]) => ({ name, share: Number((count / total).toFixed(2)), repos: primary.get(name) ?? 0 }))
		.filter((language) => language.share >= MIN_SHARE)
		.sort((a, b) => b.share - a.share || b.repos - a.repos || a.name.localeCompare(b.name))
		.slice(0, MAX_LANGUAGES);

	const now = client.now();
	const yearAgo = now.getTime() - 365 * 24 * 60 * 60 * 1000;
	const pushes = repos.flatMap((repo) => (repo.pushed_at === null ? [] : [Date.parse(repo.pushed_at)]));
	const lastPush = pushes.length === 0 ? null : Math.max(...pushes);
	return {
		login: user.login,
		id: String(user.id),
		publicRepos: user.public_repos,
		ownRepos: repos.length,
		reposRead: read.length,
		languages,
		lastPushMonth: lastPush === null ? null : new Date(lastPush).toISOString().slice(0, 7),
		reposPushedLastYear: pushes.filter((at) => at >= yearAgo).length,
		createdOn: user.created_at.slice(0, 10)
	};
}
