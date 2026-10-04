// Public profiles of Codeforces and GitHub against a local stand-in of both APIs: ownership by a one-time code, the
// reading as a `public_verifiable` fact through the common path of evidence changes, the daily refresh by the job,
// unlinking, and a source that does not answer — a stated status, never a substitute answer.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { and, desc, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { createCategorizationHandler } from '$lib/server/categorization/job';
import {
	auditEvents,
	candidates,
	categorizationRuns,
	claims,
	externalProfiles,
	jobs,
	skillInferences,
	sourceFacts,
	taxonomyVersions,
	users,
	verificationReceipts
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import type { ExternalProfileDeps } from '$lib/server/external-profiles/deps';
import {
	createExternalProfileRefreshHandler,
	scheduleExternalProfileRefreshes
} from '$lib/server/external-profiles/refresh-job';
import { confirmLink, refreshOwnProfile, startLink, unlinkProfile } from '$lib/server/external-profiles/service';
import { MAX_CHALLENGE_ATTEMPTS } from '$lib/server/external-profiles/types';
import {
	createReceiptSigner,
	issueCompanyReceipts,
	loadReceiptTemplates,
	type ReceiptSigner
} from '$lib/server/fsp/receipts';
import type { RequestMeta } from '$lib/server/invitations/deps';
import { JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES, type JobType } from '$lib/server/jobs/registry';
import { loadVacancySnapshot } from '$lib/server/matching/evidence';
import { scoreCandidatesForVacancy } from '$lib/server/matching/rank';
import { loadActiveMatchRuleset } from '$lib/server/matching/ruleset';
import { qualifiesForPool } from '$lib/server/matching/score';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { fail } from '$lib/server/ml/result';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createCompany, createMember, createOwnVacancy } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));

const meta: RequestMeta = { requestId: 'test-request', ip: '127.0.0.1', userAgent: 'vitest' };

// --- A stand-in of the Codeforces and GitHub APIs ------------------------------------------------------------------

interface CfUser {
	handle: string;
	firstName?: string;
	organization?: string;
	rating?: number;
	maxRating?: number;
	rank?: string;
	solved: string[];
	contests: number[];
}

interface GhUser {
	login: string;
	id: number;
	gists: { description: string | null; files: string[] }[];
	readme: string | null;
	repos: { name: string; fork: boolean; language: string | null; pushedAt: string; bytes: Record<string, number> }[];
}

type Failure = 'server_error' | 'rate_limited' | 'hang' | null;

interface Source {
	url: string;
	cf: Map<string, CfUser>;
	gh: Map<string, GhUser>;
	failure: Failure;
	calls: string[];
	/** `Authorization` of every request, `null` when absent. */
	authorizations: (string | null)[];
	close(): Promise<void>;
}

/** What the stand-in answers: JSON by default, a raw text body for a README. */
interface Answer {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
	raw?: string;
}

const notFound: Answer = { status: 404, body: { message: 'Not Found' } };

function codeforces(source: Source, path: string, query: URLSearchParams): Answer {
	const handle = (query.get('handles') ?? query.get('handle') ?? '').toLowerCase();
	const user = source.cf.get(handle);
	if (!user)
		return { status: 400, body: { status: 'FAILED', comment: `handles: User with handle ${handle} not found` } };
	if (path === 'user.info') {
		const info: Record<string, unknown> = { ...user, registrationTimeSeconds: 1_600_000_000 };
		delete info.solved;
		delete info.contests;
		return { status: 200, body: { status: 'OK', result: [info] } };
	}
	if (path === 'user.rating') {
		const result = user.contests.map((contestId, i) => ({
			contestId,
			ratingUpdateTimeSeconds: 1_700_000_000 + i * 86_400
		}));
		return { status: 200, body: { status: 'OK', result } };
	}
	if (path === 'user.status') {
		const accepted = user.solved.map((key) => {
			const [contestId, index] = key.split(':');
			return { verdict: 'OK', problem: { contestId: Number(contestId), index } };
		});
		// A second accepted submission of the same problem and a wrong one are not new solved problems.
		const extra =
			accepted.length > 0 ? [accepted[0], { verdict: 'WRONG_ANSWER', problem: { contestId: 1, index: 'Z' } }] : [];
		return { status: 200, body: { status: 'OK', result: [...accepted, ...extra] } };
	}
	return notFound;
}

function github(source: Source, path: string): Answer {
	const parts = path.split('/').filter(Boolean);
	const byLogin = (login: string | undefined) => (login === undefined ? undefined : source.gh.get(login.toLowerCase()));
	const account = (user: GhUser): Answer => ({
		status: 200,
		body: {
			login: user.login,
			id: user.id,
			type: 'User',
			public_repos: user.repos.length,
			created_at: '2019-03-04T10:00:00Z'
		}
	});
	if (parts[0] === 'users' && parts.length === 2) {
		const user = byLogin(parts[1]);
		return user ? account(user) : notFound;
	}
	if (parts[0] === 'user' && parts.length === 2) {
		const user = [...source.gh.values()].find((u) => String(u.id) === parts[1]);
		return user ? account(user) : notFound;
	}
	if (parts[0] === 'users' && parts[2] === 'gists') {
		const user = byLogin(parts[1]);
		if (!user) return notFound;
		const body = user.gists.map((g) => ({
			description: g.description,
			files: Object.fromEntries(g.files.map((f) => [f, {}]))
		}));
		return { status: 200, body };
	}
	if (parts[0] === 'users' && parts[2] === 'repos') {
		const user = byLogin(parts[1]);
		if (!user) return notFound;
		const body = user.repos.map((r) => ({ name: r.name, fork: r.fork, language: r.language, pushed_at: r.pushedAt }));
		return { status: 200, body };
	}
	if (parts[0] === 'repos' && parts[3] === 'readme') {
		const user = byLogin(parts[1]);
		if (!user || parts[2]?.toLowerCase() !== user.login.toLowerCase() || user.readme === null) return notFound;
		return { status: 200, body: null, raw: user.readme };
	}
	if (parts[0] === 'repos' && parts[3] === 'languages') {
		const repo = byLogin(parts[1])?.repos.find((r) => r.name === parts[2]);
		return repo ? { status: 200, body: repo.bytes } : notFound;
	}
	return notFound;
}

function answerOf(source: Source, url: URL): Answer | null {
	if (source.failure === 'hang') return null;
	if (source.failure === 'server_error') return { status: 502, body: null, raw: '<html>' };
	if (source.failure === 'rate_limited') {
		if (url.pathname.startsWith('/cf/'))
			return { status: 503, body: { status: 'FAILED', comment: 'Call limit exceeded' } };
		return {
			status: 403,
			body: { message: 'API rate limit exceeded' },
			headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(clock.getTime() / 1000) + 600) }
		};
	}
	if (url.pathname.startsWith('/cf/')) return codeforces(source, url.pathname.slice(4), url.searchParams);
	if (url.pathname.startsWith('/gh/')) return github(source, url.pathname.slice(3));
	return notFound;
}

async function startSource(): Promise<Source> {
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? '/', 'http://source');
		source.calls.push(url.pathname);
		source.authorizations.push(req.headers.authorization ?? null);
		const answer = answerOf(source, url);
		// No answer at all: the client's deadline decides.
		if (answer === null) return;
		if (answer.raw !== undefined) {
			res.writeHead(answer.status, { 'content-type': 'text/plain', ...answer.headers }).end(answer.raw);
		} else {
			res
				.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers })
				.end(JSON.stringify(answer.body));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const source: Source = {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		cf: new Map(),
		gh: new Map(),
		failure: null,
		calls: [],
		authorizations: [],
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			})
	};
	return source;
}

// --- Setup ---------------------------------------------------------------------------------------------------------

let database: TestDatabase;
let source: Source;
let deps: ExternalProfileDeps;
let signer: ReceiptSigner;
let clock: Date;

beforeAll(async () => {
	[database, source] = await Promise.all([createTestDatabase(), startSource()]);
	// The published taxonomy: receipt templates and the rules that weigh public profiles.
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const now = () => clock;
	const http = { fetch: (input: string, init: RequestInit) => fetch(input, init), userAgent: 'test', timeoutMs: 500 };
	signer = createReceiptSigner({ issuer: 'http://localhost', keyId: 'test-key', seed: randomBytes(32) });
	deps = {
		db: database.db,
		now,
		codeforces: { http, baseUrl: `${source.url}/cf`, callIntervalMs: 0, now },
		github: { http, baseUrl: `${source.url}/gh`, languageRepos: 5, token: null, now },
		signer
	};
}, 180_000);

afterAll(async () => {
	await Promise.all([database.drop(), source.close()]);
});

beforeEach(() => {
	clock = new Date();
	source.failure = null;
	source.cf.clear();
	source.gh.clear();
});

function subjectOf(candidate: { id: string; userId: string }): AccessSubject {
	return {
		userId: candidate.userId,
		via: 'session',
		candidate: { id: candidate.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

async function profileOf(id: string) {
	const [row] = await database.db.select().from(externalProfiles).where(eq(externalProfiles.id, id));
	return row;
}

async function factsOf(candidateId: string) {
	return database.db.select().from(sourceFacts).where(eq(sourceFacts.candidateId, candidateId)).orderBy(sourceFacts.id);
}

async function revisionOf(candidateId: string) {
	const [row] = await database.db
		.select({ revision: candidates.profileRevision, floor: candidates.evidenceFloorRevision })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error('candidate is missing');
	return row;
}

async function journal(candidateId: string) {
	const rows = await database.db
		.select({ action: auditEvents.action, outcome: auditEvents.outcome, details: auditEvents.details })
		.from(auditEvents)
		.where(eq(auditEvents.subjectCandidateId, candidateId))
		.orderBy(auditEvents.occurredAt);
	return rows.filter((row) => row.action.startsWith('external_profile.'));
}

function cfUser(handle: string, overrides: Partial<CfUser> = {}): CfUser {
	const user: CfUser = {
		handle,
		rating: 1850,
		maxRating: 1932,
		rank: 'expert',
		solved: Array.from({ length: 12 }, (_, i) => `${String(100 + i)}:A`),
		contests: [10, 11, 12],
		...overrides
	};
	source.cf.set(handle.toLowerCase(), user);
	return user;
}

function ghUser(login: string, id: number, overrides: Partial<GhUser> = {}): GhUser {
	const user: GhUser = {
		login,
		id,
		gists: [],
		readme: null,
		repos: [
			{
				name: 'solver',
				fork: false,
				language: 'C++',
				pushedAt: '2026-08-20T10:00:00Z',
				bytes: { 'C++': 6000, Python: 2000 }
			},
			{ name: 'bot', fork: false, language: 'Python', pushedAt: '2026-05-01T10:00:00Z', bytes: { Python: 2000 } },
			{ name: 'linux', fork: true, language: 'C', pushedAt: '2026-09-01T10:00:00Z', bytes: { C: 900000 } }
		],
		...overrides
	};
	source.gh.set(login.toLowerCase(), user);
	return user;
}

/** Makes the refresh job of the profile the only one ready to run: other tests' profiles are due too. */
async function onlyRefreshOf(profileId: string) {
	await database.db
		.update(jobs)
		.set({ runAfter: new Date('2100-01-01T00:00:00Z') })
		.where(and(eq(jobs.type, 'external_profile.refresh'), eq(jobs.status, 'queued')));
	await database.db
		.update(jobs)
		.set({ runAfter: new Date(0) })
		.where(eq(jobs.dedupKey, `external_profile.refresh:${profileId}`));
}

/** A candidate with a verified Codeforces profile. */
async function linkedCodeforces(handle: string) {
	const candidate = await createCandidate(database.db);
	const user = cfUser(handle);
	const { profileId, code } = await startLink(deps, subjectOf(candidate), { platform: 'codeforces', handle }, meta);
	user.firstName = `Ivan ${code}`;
	const outcome = await confirmLink(deps, subjectOf(candidate), profileId, meta);
	expect(outcome).toEqual({ kind: 'verified', sync: 'ok', reason: null });
	return { candidate, profileId, user };
}

// --- Jobs ----------------------------------------------------------------------------------------------------------

const log = createLogger({ service: 'test' });

async function runNext<T extends JobType>(type: T, handler: JobHandler<T>) {
	const claimed = await claimJob(database.db, 'worker-test', [type]);
	if (claimed?.type !== type) throw new Error(`no ${type} job to run`);
	const job = { ...claimed, type, payload: JOB_TYPES[type].payload.parse(claimed.payload) } as ClaimedJob<T>;
	try {
		const result: JobResult = await handler.run({
			job,
			db: database.db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: log.child({ job_id: job.id })
		});
		return await completeJob(database.db, job, result);
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		await failJob(database.db, job, { code: error.code, retryable: error.retryable, message: error.message });
		return error;
	}
}

const handler = () => createExternalProfileRefreshHandler(() => deps);

// --- Tests ---------------------------------------------------------------------------------------------------------

describe('linking by a one-time code', () => {
	it('verifies a Codeforces profile whose name field carries the code and reads it as a public_verifiable fact', async () => {
		const candidate = await createCandidate(database.db);
		const user = cfUser('Tourist_1');
		const before = await revisionOf(candidate.id);
		const { profileId, code, expiresAt } = await startLink(
			deps,
			subjectOf(candidate),
			{ platform: 'codeforces', handle: 'https://codeforces.com/profile/tourist_1' },
			meta
		);
		expect(code).toMatch(/^fsp[a-z]{12}$/);
		expect(expiresAt.getTime() - clock.getTime()).toBe(60 * 60 * 1000);
		expect((await profileOf(profileId))?.ownershipStatus).toBe('unverified');

		user.organization = `Club ${code.toUpperCase()}`;
		expect(await confirmLink(deps, subjectOf(candidate), profileId, meta)).toEqual({
			kind: 'verified',
			sync: 'ok',
			reason: null
		});

		const profile = await profileOf(profileId);
		expect(profile).toMatchObject({
			handle: 'Tourist_1',
			ownershipStatus: 'verified',
			ownershipMethod: 'handle_challenge',
			challengeCode: null,
			challengeExpiresAt: null,
			syncStatus: 'ok',
			syncError: null
		});
		const facts = await factsOf(candidate.id);
		expect(facts).toHaveLength(1);
		expect(facts[0]).toMatchObject({
			source: 'codeforces',
			factType: 'platform_rating',
			trustLevel: 'public_verifiable',
			ownershipBasis: 'handle_challenge',
			ownershipRef: profileId,
			sourceRecordRef: 'codeforces:user:tourist_1',
			eventKey: 'profile:codeforces:tourist_1',
			status: 'active'
		});
		expect(facts[0]?.payload).toMatchObject({
			account: { platform: 'codeforces', login: 'Tourist_1', rating: 1850 },
			maxRating: 1932,
			rank: 'expert',
			solvedCount: 12,
			ratedContests: 3
		});
		// The common path of evidence changes: the revision moves and the recalculation is enqueued.
		const after = await revisionOf(candidate.id);
		expect(after.revision).toBe(before.revision + 1);
		expect(after.floor).toBe(before.floor);
		const [compute] = await database.db
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.type, 'categorization.compute'), eq(jobs.dedupKey, `categorization:${candidate.id}`)));
		expect(compute).toBeDefined();
		expect((await journal(candidate.id)).map((e) => [e.action, e.outcome])).toEqual([
			['external_profile.challenge_issued', 'success'],
			['external_profile.verified', 'success']
		]);
	});

	it('verifies a GitHub profile by a public gist and by the profile README, with languages of own repositories', async () => {
		const byGist = await createCandidate(database.db);
		const user = ghUser('Maria-Dev', 4242);
		const first = await startLink(deps, subjectOf(byGist), { platform: 'github', handle: '@maria-dev' }, meta);
		user.gists.push({ description: 'notes', files: [`${first.code}.txt`] });
		expect((await confirmLink(deps, subjectOf(byGist), first.profileId, meta)).kind).toBe('verified');
		const [fact] = await factsOf(byGist.id);
		expect(fact).toMatchObject({
			source: 'github',
			factType: 'repo_languages',
			trustLevel: 'public_verifiable',
			sourceRecordRef: 'github:user:4242'
		});
		// Forks are not the person's code: C of the forked kernel is not among the languages.
		expect(fact?.payload).toMatchObject({
			login: 'Maria-Dev',
			publicRepos: 3,
			ownRepos: 2,
			reposRead: 2,
			languages: [
				{ name: 'C++', share: 0.6, repos: 1 },
				{ name: 'Python', share: 0.4, repos: 1 }
			],
			lastPushMonth: '2026-08'
		});
		expect((await profileOf(first.profileId))?.externalId).toBe('4242');

		const byReadme = await createCandidate(database.db);
		const other = ghUser('octo', 7);
		const second = await startLink(deps, subjectOf(byReadme), { platform: 'github', handle: 'octo' }, meta);
		other.readme = `# Hi\n\nVerification: ${second.code}\n`;
		expect((await confirmLink(deps, subjectOf(byReadme), second.profileId, meta)).kind).toBe('verified');
	});

	it('refuses a wrong code and keeps the profile unverified until the checks of the code run out', async () => {
		const candidate = await createCandidate(database.db);
		const user = cfUser('petr_x', { firstName: 'Petr' });
		const { profileId } = await startLink(
			deps,
			subjectOf(candidate),
			{ platform: 'codeforces', handle: 'petr_x' },
			meta
		);
		// Another code, of another request, is not this one.
		user.firstName = 'fspaaaaaaaaaaaa';
		expect(await confirmLink(deps, subjectOf(candidate), profileId, meta)).toEqual({ kind: 'code_not_found' });
		expect((await profileOf(profileId))?.ownershipStatus).toBe('unverified');
		expect(await factsOf(candidate.id)).toHaveLength(0);

		for (let i = 1; i < MAX_CHALLENGE_ATTEMPTS; i++) await confirmLink(deps, subjectOf(candidate), profileId, meta);
		expect(await confirmLink(deps, subjectOf(candidate), profileId, meta)).toEqual({ kind: 'attempts_exhausted' });
		const events = await journal(candidate.id);
		expect(events.at(-1)).toMatchObject({
			action: 'external_profile.verification_failed',
			outcome: 'failure',
			details: { platform: 'codeforces', result: 'attempts_exhausted' }
		});
	});

	it('refuses an expired code and an unknown handle', async () => {
		const candidate = await createCandidate(database.db);
		const user = cfUser('late_one');
		const { profileId, code } = await startLink(
			deps,
			subjectOf(candidate),
			{ platform: 'codeforces', handle: 'late_one' },
			meta
		);
		user.firstName = code;
		clock = new Date(clock.getTime() + 61 * 60 * 1000);
		expect(await confirmLink(deps, subjectOf(candidate), profileId, meta)).toEqual({ kind: 'expired' });
		expect((await profileOf(profileId))?.ownershipStatus).toBe('unverified');

		const ghost = await startLink(deps, subjectOf(candidate), { platform: 'github', handle: 'nobody-here' }, meta);
		expect(await confirmLink(deps, subjectOf(candidate), ghost.profileId, meta)).toEqual({ kind: 'handle_not_found' });
		await expect(
			startLink(deps, subjectOf(candidate), { platform: 'github', handle: 'bad--name' }, meta)
		).rejects.toMatchObject({ code: 'validation_failed' });
	});

	it('refuses a handle another person has verified, before and at the check', async () => {
		await linkedCodeforces('Owner_Handle');
		const intruder = await createCandidate(database.db);
		await expect(
			startLink(deps, subjectOf(intruder), { platform: 'codeforces', handle: 'owner_handle' }, meta)
		).rejects.toSatisfy((e) => e instanceof ApiError && e.details?.[0]?.code === 'handle_taken');

		// The owner's code does not verify someone else's request: a code is tied to its request.
		const late = await createCandidate(database.db);
		const second = cfUser('Shared_Handle');
		const pending = await startLink(deps, subjectOf(late), { platform: 'codeforces', handle: 'shared_handle' }, meta);
		const winner = await createCandidate(database.db);
		const won = await startLink(deps, subjectOf(winner), { platform: 'codeforces', handle: 'Shared_Handle' }, meta);
		second.firstName = `${won.code} ${pending.code}`;
		expect((await confirmLink(deps, subjectOf(winner), won.profileId, meta)).kind).toBe('verified');
		// Both codes stand in the profile, but the account is already another candidate's.
		expect(await confirmLink(deps, subjectOf(late), pending.profileId, meta)).toEqual({ kind: 'handle_taken' });
		expect((await profileOf(pending.profileId))?.ownershipStatus).toBe('unverified');
	});

	it('does not let an account of the demo seed block a real person', async () => {
		const { candidate: seeded, profileId } = await linkedCodeforces('Demo_Handle');
		const [row] = await database.db
			.select({ userId: candidates.userId })
			.from(candidates)
			.where(eq(candidates.id, seeded.id));
		if (!row) throw new Error('candidate is missing');
		await database.db.update(users).set({ seedBatchId: 'demo-2026-09' }).where(eq(users.id, row.userId));
		const person = await createCandidate(database.db);
		const started = await startLink(deps, subjectOf(person), { platform: 'codeforces', handle: 'demo_handle' }, meta);
		expect(started.profileId).not.toBe(profileId);
	});
});

describe('unlinking', () => {
	it('withdraws the facts with their claims and raises the evidence floor', async () => {
		const { candidate, profileId } = await linkedCodeforces('Leaver');
		const [fact] = await factsOf(candidate.id);
		if (!fact) throw new Error('fact is missing');
		await database.db.insert(claims).values({
			candidateId: candidate.id,
			factId: fact.id,
			claimType: 'skill_mention',
			rawText: 'codeforces rating',
			polarity: 'asserted',
			skillKey: 'algorithms',
			extractor: 'source_mapping',
			status: 'active'
		});
		const before = await revisionOf(candidate.id);

		expect(await unlinkProfile(deps, subjectOf(candidate), profileId, meta)).toEqual({ withdrawn: 1 });

		expect(await profileOf(profileId)).toBeUndefined();
		const [after] = await factsOf(candidate.id);
		expect(after).toMatchObject({ status: 'withdrawn', statusReason: 'profile_unlinked' });
		const [claim] = await database.db.select().from(claims).where(eq(claims.factId, fact.id));
		expect(claim?.status).toBe('invalidated');
		const revision = await revisionOf(candidate.id);
		expect(revision.revision).toBe(before.revision + 1);
		expect(revision.floor).toBe(revision.revision);
		expect((await journal(candidate.id)).at(-1)).toMatchObject({
			action: 'external_profile.unlinked',
			details: { platform: 'codeforces', was_verified: true, withdrawn: 1 }
		});
	});

	it('refuses to unlink a profile of another candidate', async () => {
		const { profileId } = await linkedCodeforces('Mine_Only');
		const other = await createCandidate(database.db);
		await expect(unlinkProfile(deps, subjectOf(other), profileId, meta)).rejects.toMatchObject({ code: 'not_found' });
		expect((await profileOf(profileId))?.ownershipStatus).toBe('verified');
	});
});

describe('refresh', () => {
	it('schedules profiles not read for a day, supersedes a changed reading and re-verifies an unchanged one', async () => {
		const { candidate, profileId, user } = await linkedCodeforces('Climber');
		// Read just now: not due.
		expect(await scheduleExternalProfileRefreshes(database.db, clock)).toBe(0);

		clock = new Date(clock.getTime() + 25 * 60 * 60 * 1000);
		expect(await scheduleExternalProfileRefreshes(database.db, clock)).toBeGreaterThanOrEqual(1);
		// A waiting job is not enqueued twice.
		await scheduleExternalProfileRefreshes(database.db, clock);
		const waiting = await database.db
			.select({ id: jobs.id })
			.from(jobs)
			.where(eq(jobs.dedupKey, `external_profile.refresh:${profileId}`));
		expect(waiting).toHaveLength(1);
		await onlyRefreshOf(profileId);

		user.rating = 2010;
		user.maxRating = 2010;
		user.rank = 'candidate master';
		user.contests.push(13);
		const before = await revisionOf(candidate.id);
		expect(await runNext('external_profile.refresh', handler())).toBe('succeeded');

		const facts = await factsOf(candidate.id);
		expect(facts.map((f) => f.status)).toEqual(['superseded', 'active']);
		expect(facts[1]?.payload).toMatchObject({ account: { rating: 2010 }, rank: 'candidate master', ratedContests: 4 });
		expect(await profileOf(profileId)).toMatchObject({ syncStatus: 'ok', syncedAt: clock });
		const after = await revisionOf(candidate.id);
		expect(after.revision).toBe(before.revision + 1);

		// Nothing changed: the fact is re-verified, the revision stays.
		clock = new Date(clock.getTime() + 11 * 60 * 1000);
		const again = await refreshOwnProfile(deps, subjectOf(candidate), profileId, meta);
		expect(again).toMatchObject({ kind: 'synced', sync: 'ok', change: { unchanged: 1, inserted: 0, superseded: 0 } });
		expect((await factsOf(candidate.id))[1]?.lastVerifiedAt).toEqual(clock);
		expect((await revisionOf(candidate.id)).revision).toBe(after.revision);
		// Asked again at once: refused, the source is not called.
		const calls = source.calls.length;
		await expect(refreshOwnProfile(deps, subjectOf(candidate), profileId, meta)).rejects.toMatchObject({
			code: 'rate_limited'
		});
		expect(source.calls.length).toBe(calls);
	});

	it('withdraws the facts of an account the source no longer has', async () => {
		const { candidate, profileId } = await linkedCodeforces('Vanished');
		source.cf.delete('vanished');
		clock = new Date(clock.getTime() + 11 * 60 * 1000);
		expect(await refreshOwnProfile(deps, subjectOf(candidate), profileId, meta)).toMatchObject({
			kind: 'synced',
			sync: 'not_found',
			change: { withdrawn: 1 }
		});
		expect((await factsOf(candidate.id))[0]).toMatchObject({
			status: 'withdrawn',
			statusReason: 'source_profile_not_found'
		});
		expect((await profileOf(profileId))?.syncStatus).toBe('not_found');
	});

	it('follows a renamed GitHub account by its id', async () => {
		const candidate = await createCandidate(database.db);
		const user = ghUser('old-name', 99);
		const { profileId, code } = await startLink(
			deps,
			subjectOf(candidate),
			{ platform: 'github', handle: 'old-name' },
			meta
		);
		user.gists.push({ description: `proof ${code}`, files: ['a.md'] });
		expect((await confirmLink(deps, subjectOf(candidate), profileId, meta)).kind).toBe('verified');
		source.gh.delete('old-name');
		source.gh.set('new-name', { ...user, login: 'new-name' });
		clock = new Date(clock.getTime() + 11 * 60 * 1000);
		expect((await refreshOwnProfile(deps, subjectOf(candidate), profileId, meta)).kind).toBe('synced');
		expect((await profileOf(profileId))?.handle).toBe('new-name');
		const facts = await factsOf(candidate.id);
		expect(facts.map((f) => [f.sourceRecordRef, f.status])).toEqual([
			['github:user:99', 'superseded'],
			['github:user:99', 'active']
		]);
	});
});

describe('a source that does not answer', () => {
	it.each([
		['server_error', 'server_error'],
		['rate_limited', 'rate_limited'],
		['hang', 'timeout']
	] as const)('is a stated status at the check (%s)', async (failure, reason) => {
		const candidate = await createCandidate(database.db);
		cfUser(`down_${failure}`);
		const { profileId } = await startLink(
			deps,
			subjectOf(candidate),
			{ platform: 'codeforces', handle: `down_${failure}` },
			meta
		);
		source.failure = failure;
		expect(await confirmLink(deps, subjectOf(candidate), profileId, meta)).toEqual({
			kind: 'source_unavailable',
			reason
		});
		expect((await profileOf(profileId))?.ownershipStatus).toBe('unverified');
		expect(await factsOf(candidate.id)).toHaveLength(0);
	});

	it('keeps the facts and records the status on the profile; the job retries at the moment the source names', async () => {
		const candidate = await createCandidate(database.db);
		const user = ghUser('busy-dev', 555);
		const { profileId, code } = await startLink(
			deps,
			subjectOf(candidate),
			{ platform: 'github', handle: 'busy-dev' },
			meta
		);
		user.readme = code;
		expect((await confirmLink(deps, subjectOf(candidate), profileId, meta)).kind).toBe('verified');
		const [fact] = await factsOf(candidate.id);
		const revision = await revisionOf(candidate.id);

		source.failure = 'rate_limited';
		clock = new Date(clock.getTime() + 25 * 60 * 60 * 1000);
		await scheduleExternalProfileRefreshes(database.db, clock);
		await onlyRefreshOf(profileId);
		const failed = await runNext('external_profile.refresh', handler());
		expect(failed).toBeInstanceOf(JobFailure);
		expect(failed).toMatchObject({ code: 'source_rate_limited', retryable: true });
		expect((failed as JobFailure).retryAfterSeconds).toBeGreaterThan(0);

		expect(await profileOf(profileId)).toMatchObject({ syncStatus: 'source_unavailable', syncError: 'rate_limited' });
		const facts = await factsOf(candidate.id);
		expect(facts).toHaveLength(1);
		expect(facts[0]).toMatchObject({ id: fact?.id, status: 'active', lastVerifiedAt: fact?.lastVerifiedAt });
		expect(await revisionOf(candidate.id)).toEqual(revision);
		expect((await journal(candidate.id)).at(-1)).toMatchObject({
			action: 'external_profile.sync_failed',
			outcome: 'failure',
			details: { platform: 'github', reason: 'rate_limited' }
		});

		// The ownership proven while the data could not be read: verified, with the status instead of data.
		const other = await createCandidate(database.db);
		source.failure = null;
		const cf = cfUser('half_read');
		const started = await startLink(deps, subjectOf(other), { platform: 'codeforces', handle: 'half_read' }, meta);
		cf.firstName = started.code;
		const realFetch = deps.codeforces.http.fetch;
		let calls = 0;
		deps.codeforces.http.fetch = (input, init) =>
			++calls === 1 ? realFetch(input, init) : Promise.reject(new Error('reset'));
		try {
			expect(await confirmLink(deps, subjectOf(other), started.profileId, meta)).toEqual({
				kind: 'verified',
				sync: 'source_unavailable',
				reason: 'network'
			});
		} finally {
			deps.codeforces.http.fetch = realFetch;
		}
		expect(await profileOf(started.profileId)).toMatchObject({
			ownershipStatus: 'verified',
			syncStatus: 'source_unavailable',
			syncError: 'network',
			syncedAt: null
		});
		expect(await factsOf(other.id)).toHaveLength(0);
	});
});

describe('evidence of a verified profile', () => {
	const categorization = () => createCategorizationHandler(() => clock);

	async function onlyCategorizationOf(candidateId: string) {
		await database.db
			.update(jobs)
			.set({ runAfter: new Date('2100-01-01T00:00:00Z') })
			.where(and(eq(jobs.type, 'categorization.compute'), eq(jobs.status, 'queued')));
		await database.db
			.update(jobs)
			.set({ runAfter: new Date(0) })
			.where(and(eq(jobs.dedupKey, `categorization:${candidateId}`), eq(jobs.status, 'queued')));
	}

	async function latestInferences(candidateId: string) {
		const [run] = await database.db
			.select({ id: categorizationRuns.id })
			.from(categorizationRuns)
			.where(eq(categorizationRuns.candidateId, candidateId))
			.orderBy(desc(categorizationRuns.computedAt), desc(categorizationRuns.id))
			.limit(1);
		if (!run) throw new Error('no categorization run');
		return database.db.select().from(skillInferences).where(eq(skillInferences.runId, run.id));
	}

	it('gives the skills of the rules the badge «public profile», and unlinking takes the contribution away', async () => {
		const { candidate, profileId } = await linkedCodeforces('Rated_Solver');
		await onlyCategorizationOf(candidate.id);
		expect(await runNext('categorization.compute', categorization())).toBe('succeeded');
		const skills = await latestInferences(candidate.id);
		const cp = skills.find((s) => s.skillKey === 'competitive_programming');
		expect(cp).toMatchObject({ attestation: 'direct', badgeTrust: 'public_verifiable' });
		expect(cp?.contributions).toEqual([
			expect.objectContaining({ basis: 'public_profile', source: 'codeforces', trust_level: 'public_verifiable' })
		]);
		expect(skills.find((s) => s.skillKey === 'algorithms')?.badgeTrust).toBe('public_verifiable');

		await unlinkProfile(deps, subjectOf(candidate), profileId, meta);
		await onlyCategorizationOf(candidate.id);
		expect(await runNext('categorization.compute', categorization())).toBe('succeeded');
		const after = await latestInferences(candidate.id);
		expect(after.filter((s) => s.skillKey === 'competitive_programming' || s.skillKey === 'algorithms')).toEqual([]);
	});

	it('covers a required skill by repository languages, but neither trusts it nor counts it for the pool', async () => {
		const candidate = await createCandidate(database.db);
		const user = ghUser('Pool-Dev', 5151);
		const link = await startLink(deps, subjectOf(candidate), { platform: 'github', handle: 'Pool-Dev' }, meta);
		user.gists.push({ description: link.code, files: ['notes.md'] });
		expect((await confirmLink(deps, subjectOf(candidate), link.profileId, meta)).kind).toBe('verified');
		await onlyCategorizationOf(candidate.id);
		expect(await runNext('categorization.compute', categorization())).toBe('succeeded');
		expect((await latestInferences(candidate.id)).find((s) => s.skillKey === 'python')).toMatchObject({
			attestation: 'direct',
			badgeTrust: 'public_verifiable'
		});

		const company = await createCompany(database.db);
		const member = await createMember(database.db, company.id);
		const [version] = await database.db.select({ id: taxonomyVersions.id }).from(taxonomyVersions);
		if (!version) throw new Error('taxonomy not published');
		const vacancy = await createOwnVacancy(
			database.db,
			{ companyId: company.id, memberId: member.id, taxonomyVersionId: version.id },
			{ requiredSkillKeys: ['python'] }
		);
		const snapshot = await loadVacancySnapshot(database.db, vacancy.id);
		if (!snapshot) throw new Error('no vacancy snapshot');
		const modelsOff: MatchingModels = {
			embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
			rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' }))
		};
		const ruleset = await loadActiveMatchRuleset(database.db);
		const [pair] = (await scoreCandidatesForVacancy(database.db, modelsOff, snapshot, [candidate.id], { ruleset }))
			.ranked;
		if (!pair) throw new Error('the pair is not scored');
		const { required, trust } = pair.result.components;
		expect(required.status).toBe('computed');
		expect(required.value ?? 0).toBeGreaterThan(0);
		expect(trust).toMatchObject({
			status: 'computed',
			value: 0,
			details: { direct: 0, total: 1, public_profile: 1, confirmed_coverage: 0 }
		});
		expect(pair.result.explanation.matches).toContainEqual(
			expect.objectContaining({ kind: 'skill', skill_key: 'python', badge_trust: 'public_verifiable' })
		);
		// Even at the threshold the pair is not among the confirmed candidates.
		expect(qualifiesForPool(ruleset.params.poolThreshold, trust, ruleset.params)).toBe(false);
	});

	it('issues the candidate a receipt of the fact and receipts to a company that sees it', async () => {
		const { candidate } = await linkedCodeforces('Receipt_Holder');
		const [fact] = await factsOf(candidate.id);
		if (!fact) throw new Error('fact is missing');
		expect(fact.sourceSnapshotSha256).toBe(fact.payloadSha256);
		const [own] = await database.db.select().from(verificationReceipts).where(eq(verificationReceipts.factId, fact.id));
		expect(own).toMatchObject({ audienceCompanyId: null, disclosureLevel: 'generalized' });
		expect(own?.statement).toMatchObject({
			source: 'codeforces',
			fact_type: 'platform_rating',
			asserts: { platform: 'codeforces', ratingBand: 'candidate_master' },
			does_not_assert: expect.arrayContaining(['коммерческий опыт']) as unknown
		});

		const company = await createCompany(database.db);
		const outcome = await issueCompanyReceipts(database.db, signer, await loadReceiptTemplates(database.db), {
			companyId: company.id,
			candidateId: candidate.id,
			factIds: [fact.id],
			exactFactIds: [fact.id]
		});
		// One receipt at the level the fact is shown: exact.
		expect(outcome).toEqual({ issued: 1, existing: 0, ineligible: 0 });
		const exact = await database.db
			.select({ statement: verificationReceipts.statement })
			.from(verificationReceipts)
			.where(
				and(eq(verificationReceipts.audienceCompanyId, company.id), eq(verificationReceipts.disclosureLevel, 'exact'))
			);
		expect(exact[0]?.statement).toMatchObject({
			asserts: { platform: 'codeforces', handle: 'Receipt_Holder', rating: 1850, maxRating: 1932 }
		});

		// A GitHub receipt says plainly what repository languages do not assert.
		const coder = await createCandidate(database.db);
		const user = ghUser('receipt-dev', 31337);
		const started = await startLink(deps, subjectOf(coder), { platform: 'github', handle: 'receipt-dev' }, meta);
		user.readme = started.code;
		expect((await confirmLink(deps, subjectOf(coder), started.profileId, meta)).kind).toBe('verified');
		const [ghFact] = await factsOf(coder.id);
		const [ghReceipt] = await database.db
			.select({ statement: verificationReceipts.statement })
			.from(verificationReceipts)
			.where(eq(verificationReceipts.factId, ghFact?.id ?? ''));
		expect(ghReceipt?.statement).toMatchObject({
			source: 'github',
			asserts: { languages: 'C++, Python' },
			does_not_assert: expect.arrayContaining([
				'авторство каждой строки кода: это языки публичных репозиториев, в них может быть и чужой код'
			]) as unknown
		});
	});

	it('sends the GitHub token when one is configured, and none otherwise', async () => {
		const candidate = await createCandidate(database.db);
		ghUser('token-dev', 777);
		source.authorizations.length = 0;
		await startLink(deps, subjectOf(candidate), { platform: 'github', handle: 'token-dev' }, meta);
		const started = await startLink(
			{ ...deps, github: { ...deps.github, token: 'ghp_testtoken0000000000000000' } },
			subjectOf(candidate),
			{ platform: 'github', handle: 'token-dev' },
			meta
		);
		await confirmLink(
			{ ...deps, github: { ...deps.github, token: 'ghp_testtoken0000000000000000' } },
			subjectOf(candidate),
			started.profileId,
			meta
		);
		expect(source.authorizations.length).toBeGreaterThan(0);
		expect(source.authorizations.every((a) => a === 'Bearer ghp_testtoken0000000000000000')).toBe(true);
		source.authorizations.length = 0;
		await confirmLink(deps, subjectOf(candidate), started.profileId, meta);
		expect(source.authorizations.length).toBeGreaterThan(0);
		expect(source.authorizations.every((a) => a === null)).toBe(true);
	});
});
