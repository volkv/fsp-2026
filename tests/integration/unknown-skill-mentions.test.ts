// The queue of skills the taxonomy does not know (docs/domain.md, section 11): the normalization of external postings
// counts the tags it could not resolve by their canonical spelling, a posting once per spelling however many times it
// is normalized; the administrator sees the most frequent first, with the latest posting that carries each and the
// taxonomy versions that already know it, and marks a spelling added or rejected. The queue is shared by the stand: a
// demo account sees it but does not mark it.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { Actor } from '$lib/server/access/actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { reviewUnknownSkill, unknownSkillQueue, type UnknownSkillQueueView } from '$lib/server/admin/reference';
import {
	productPolicies,
	staffRoles,
	taxonomyVersions,
	unknownSkillMentions,
	vacancyImportRuns,
	vacancyPostings
} from '$lib/server/db/schema';
import { claimJob, completeJob, enqueueJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { createLogger } from '$lib/server/jobs/log';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { PENDING_NORMALIZATION, PENDING_VERSION } from '$lib/server/vacancies/clusters';
import { createVacancyNormalizeHandler } from '$lib/server/vacancies/normalize-job';
import type { OriginalTerms } from '$lib/server/vacancies/normalize';
import { HABR_SOURCE_KEY, registerVacancySources } from '$lib/server/vacancies/sources/definitions';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createExternalVacancy, createUser, randomSha256 } from '../helpers/factories';

// The route reads `config()`: its environment points at this file's database once it exists.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const { closeDb } = await import('$lib/server/db');
const { testEnvironment } = await import('../helpers/environment');
const queuePage = await import('../../src/routes/(app)/admin/taxonomy/unknown-skills/+page.server');

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;

let database: TestDatabase;
let taxonomyVersionId: string;
let adminId: string;
let demoAdminId: string;
let enqueued = 0;
let requests = 0;

/** Words no taxonomy knows, fresh for this run. */
const marker = randomBytes(3).toString('hex');
const QUANTUM = `квантовая йога ${marker}`;
const GADGET = `фробникатор ${marker}`;
const LATE = `гиперлуп ${marker}`;

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl') }));
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const { db } = database;
	const [version] = await db.select({ id: taxonomyVersions.id }).from(taxonomyVersions);
	if (!version) throw new Error('taxonomy not published');
	taxonomyVersionId = version.id;
	await registerVacancySources(database.sql);
	await db.insert(productPolicies).values({
		kind: 'sourcing_policy',
		version: 1,
		params: { stale_after_days: 14 },
		effectiveFrom: new Date(Date.now() - 10 * DAY)
	});
	adminId = (await createUser(db)).id;
	demoAdminId = (await createUser(db, { seedBatchId: `demo-${marker}` })).id;
	await db.insert(staffRoles).values([
		{ userId: adminId, role: 'admin', grantedAt: new Date() },
		{ userId: demoAdminId, role: 'admin', grantedAt: new Date() }
	]);
});

afterAll(async () => {
	await closeDb();
	await database.drop();
});

function terms(skills: string[]): OriginalTerms {
	return {
		salary_text: null,
		salary: { min: null, max: null, currency: null, period: null, tax_base: null },
		grade_raw: null,
		employment_raw: null,
		location: { city: null, remote: null, raw: null },
		skills_raw: skills,
		description: null,
		contacts_removed: false
	};
}

/** An imported external posting that waits for its normalization. */
async function posting(title: string, skills: string[], fetchedAt = new Date()) {
	const { db } = database;
	const vacancy = await createExternalVacancy(db, taxonomyVersionId, { title });
	const [run] = await db
		.insert(vacancyImportRuns)
		.values({
			source: HABR_SOURCE_KEY,
			adapterVersion: 'test/1',
			mode: 'full',
			startedAt: fetchedAt,
			finishedAt: fetchedAt,
			status: 'succeeded',
			completeness: 'complete',
			counts: {}
		})
		.returning({ id: vacancyImportRuns.id });
	if (!run) throw new Error('import run not inserted');
	const externalId = String(randomBytes(4).readUInt32BE());
	const [row] = await db
		.insert(vacancyPostings)
		.values({
			vacancyId: vacancy.id,
			source: HABR_SOURCE_KEY,
			externalId,
			url: `https://career.habr.com/vacancies/${externalId}`,
			organization: { name: 'Пример', inn: null, source_org_id: null },
			title,
			originalTerms: terms(skills),
			rawSha256: randomSha256(),
			normalized: PENDING_NORMALIZATION,
			normalizationVersion: PENDING_VERSION,
			firstFetchedAt: fetchedAt,
			lastFetchedAt: fetchedAt,
			lastCheckedAt: fetchedAt,
			freshness: 'active',
			dedup: { method: 'exact', score: 1 },
			lastImportRunId: run.id
		})
		.returning({ id: vacancyPostings.id, url: vacancyPostings.url, rawSha256: vacancyPostings.rawSha256 });
	if (!row) throw new Error('posting not inserted');
	return { ...row, vacancyId: vacancy.id, fetchedAt };
}

/** Runs `vacancy.normalize` for the postings as the worker does: one job each, its result written conditionally. */
async function normalize(...postingIds: string[]) {
	const { db } = database;
	const handler = createVacancyNormalizeHandler(() => new Date());
	for (const postingId of postingIds) {
		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'vacancy.normalize',
				{ posting_id: postingId },
				{ inputVersion: `run-${++enqueued}`, createdBy: { kind: 'system' } }
			)
		);
	}
	for (;;) {
		const claimed = await claimJob(db, 'test-worker', ['vacancy.normalize']);
		if (!claimed) return;
		const job = {
			...claimed,
			type: 'vacancy.normalize' as const,
			payload: JOB_TYPES['vacancy.normalize'].payload.parse(claimed.payload)
		};
		const result = await handler.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: createLogger({}, () => undefined)
		});
		expect(await completeJob(db, job, result)).toBe('succeeded');
	}
}

async function queueRow(spelling: string) {
	const [row] = await database.db
		.select()
		.from(unknownSkillMentions)
		.where(eq(unknownSkillMentions.rawNormalized, spelling));
	return row;
}

const meta = { requestId: 'req-unknown-skills', ip: null, userAgent: null };
const subjectOf = (userId: string, admin: boolean): AccessSubject => ({
	userId,
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: false, admin, extraPermissions: [] }
});
const admin = () => ({ subject: subjectOf(adminId, true), meta });

function sessionActor(userId: string): Actor {
	return {
		kind: 'session',
		userId,
		sessionHash: randomSha256(),
		authTime: new Date(),
		authMethod: 'password',
		csrfToken: `csrf-${randomBytes(4).toString('hex')}`
	};
}

function event(actor: Actor, request: Request) {
	return {
		url: new URL(request.url),
		params: {},
		request,
		locals: { requestId: `req-unknown-${++requests}`, actor },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		depends: () => {}
	};
}

async function markByPage(userId: string, spelling: string, status: string) {
	const action = queuePage.actions.review;
	if (!action) throw new Error('the page has no review action');
	const form = new FormData();
	form.set('spelling', spelling);
	form.set('status', status);
	const request = new Request('http://localhost/admin/taxonomy/unknown-skills?/review', { method: 'POST', body: form });
	return (await action(event(sessionActor(userId), request) as never)) as unknown;
}

describe('the queue of unknown skills', () => {
	let first: Awaited<ReturnType<typeof posting>>;
	let second: Awaited<ReturnType<typeof posting>>;

	it('counts the tags the normalization did not resolve by their canonical spelling, a posting once', async () => {
		const earlier = new Date(Date.now() - DAY);
		first = await posting(
			'Разработчик на Python',
			['Python', `Квантовая йога ${marker}`, `КВАНТОВАЯ  ЙОГА ${marker}.`, `Фробникатор ${marker}`],
			earlier
		);
		second = await posting('Бэкенд-разработчик', [`квантовая Йога ${marker}`, 'PostgreSQL']);
		await normalize(first.id, second.id);

		expect(await queueRow(QUANTUM)).toMatchObject({ count: 2, reviewStatus: 'pending' });
		expect(await queueRow(GADGET)).toMatchObject({ count: 1, reviewStatus: 'pending' });
		// Tags the taxonomy knows never enter the queue.
		expect(await queueRow('python')).toBeUndefined();
		expect(await queueRow('postgresql')).toBeUndefined();
	});

	it('does not count a posting again when it is normalized again', async () => {
		const before = await queueRow(QUANTUM);
		await normalize(first.id, second.id, first.id);
		expect(await queueRow(QUANTUM)).toMatchObject({ count: 2, firstSeenAt: before?.firstSeenAt });
		expect(await queueRow(GADGET)).toMatchObject({ count: 1 });
	});

	it('counts only the spellings new to a posting whose tags changed', async () => {
		await database.db
			.update(vacancyPostings)
			.set({ originalTerms: terms([`Квантовая йога ${marker}`, `Гиперлуп ${marker}`]), rawSha256: randomSha256() })
			.where(eq(vacancyPostings.id, first.id));
		await normalize(first.id);
		expect(await queueRow(LATE)).toMatchObject({ count: 1 });
		// Normalized again, the posting fetched earlier does not take the place of the one fetched later.
		expect(await queueRow(QUANTUM)).toMatchObject({ count: 2, lastPostingId: second.id });
		// The counter records where a spelling was found; a posting that dropped it does not take it back.
		expect(await queueRow(GADGET)).toMatchObject({ count: 1 });
	});

	it('shows the most frequent first, with the latest posting carrying each and the versions that know it', async () => {
		const view: UnknownSkillQueueView = await unknownSkillQueue(database.db, admin(), {
			filter: 'pending',
			query: marker
		});
		expect(view.rows.map((row) => row.spelling)).toEqual([QUANTUM, GADGET, LATE]);
		const quantum = view.rows[0];
		expect(quantum?.lastSeen).toMatchObject({
			vacancyId: second.vacancyId,
			url: second.url,
			at: second.fetchedAt,
			written: `квантовая Йога ${marker}`
		});
		expect(quantum?.inTaxonomy).toEqual([]);
		expect(view.rows[1]?.lastSeen).toBeNull();
		expect(view.rows[2]?.lastSeen).toMatchObject({ vacancyId: first.vacancyId, written: `Гиперлуп ${marker}` });
		expect(view.counts.pending).toBeGreaterThanOrEqual(3);
	});

	it('reads where a spelling was last seen from the queue, not from the postings', async () => {
		const stored = await queueRow(QUANTUM);
		await database.db
			.update(unknownSkillMentions)
			.set({ lastPostingId: null })
			.where(eq(unknownSkillMentions.rawNormalized, QUANTUM));
		const view = await unknownSkillQueue(database.db, admin(), { filter: 'pending', query: QUANTUM });
		expect(view.rows.find((row) => row.spelling === QUANTUM)?.lastSeen).toBeNull();
		await database.db
			.update(unknownSkillMentions)
			.set({ lastPostingId: stored?.lastPostingId ?? null })
			.where(eq(unknownSkillMentions.rawNormalized, QUANTUM));
	});

	it('names the taxonomy versions whose aliases already know a spelling', async () => {
		await database.db.insert(unknownSkillMentions).values({ rawNormalized: 'python', count: 1 });
		const view = await unknownSkillQueue(database.db, admin(), { filter: 'pending', query: 'python' });
		expect(view.rows.find((row) => row.spelling === 'python')?.inTaxonomy).toEqual([
			expect.objectContaining({ status: 'published', skillKey: 'python' })
		]);
		await database.db.delete(unknownSkillMentions).where(eq(unknownSkillMentions.rawNormalized, 'python'));
	});

	it('the administrator marks a spelling added or rejected, and the filter follows the mark', async () => {
		expect(await markByPage(adminId, GADGET, 'rejected')).toEqual({ done: { spelling: GADGET, status: 'rejected' } });
		await reviewUnknownSkill(database.db, admin(), { spelling: LATE, status: 'added' });

		const pending = await unknownSkillQueue(database.db, admin(), { filter: 'pending', query: marker });
		expect(pending.rows.map((row) => row.spelling)).toEqual([QUANTUM]);
		const rejected = await unknownSkillQueue(database.db, admin(), { filter: 'rejected', query: marker });
		expect(rejected.rows.map((row) => [row.spelling, row.status])).toEqual([[GADGET, 'rejected']]);
		const all = await unknownSkillQueue(database.db, admin(), { filter: 'all', query: marker });
		expect(all.rows.map((row) => row.spelling)).toEqual([QUANTUM, GADGET, LATE]);

		// A marked spelling found again keeps its mark and counts on.
		const third = await posting('Инженер', [`Фробникатор ${marker}`]);
		await normalize(third.id);
		expect(await queueRow(GADGET)).toMatchObject({ count: 2, reviewStatus: 'rejected' });

		await reviewUnknownSkill(database.db, admin(), { spelling: GADGET, status: 'pending' });
		expect((await queueRow(GADGET))?.reviewStatus).toBe('pending');
	});

	it('refuses an unknown spelling, an unknown mark and a user who is not an administrator', async () => {
		await expect(
			reviewUnknownSkill(database.db, admin(), { spelling: `нет такого ${marker}`, status: 'added' })
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			reviewUnknownSkill(database.db, admin(), { spelling: QUANTUM, status: 'maybe' })
		).rejects.toMatchObject({ code: 'validation_failed' });
		const stranger = { subject: subjectOf(adminId, false), meta };
		await expect(unknownSkillQueue(database.db, stranger, { filter: 'pending', query: '' })).rejects.toMatchObject({
			code: 'forbidden'
		});
		await expect(
			reviewUnknownSkill(database.db, stranger, { spelling: QUANTUM, status: 'rejected' })
		).rejects.toMatchObject({ code: 'forbidden' });
		expect((await queueRow(QUANTUM))?.reviewStatus).toBe('pending');
	});

	it('a demo account sees the queue on the page but does not mark it', async () => {
		const page = (await queuePage.load(
			event(
				sessionActor(demoAdminId),
				new Request(`http://localhost/admin/taxonomy/unknown-skills?q=${encodeURIComponent(marker)}`)
			) as never
		)) as { queue: UnknownSkillQueueView; demoLocked: boolean };
		expect(page.demoLocked).toBe(true);
		expect(page.queue.rows.map((row) => row.spelling)).toContain(QUANTUM);

		expect(await markByPage(demoAdminId, QUANTUM, 'rejected')).toMatchObject({
			status: 403,
			data: { problem: { code: 'forbidden' } }
		});
		expect((await queueRow(QUANTUM))?.reviewStatus).toBe('pending');
	});

	it('takes a spelling of up to 80 characters and leaves a longer phrase in the posting', async () => {
		const other = randomBytes(3).toString('hex');
		const prefix = `фраза ${other} `;
		const ofLength = (length: number) => prefix + 'я'.repeat(length - prefix.length);
		const [fits, phrase] = [ofLength(80), ofLength(81)];
		expect([Array.from(fits).length, Array.from(phrase).length]).toEqual([80, 81]);
		const row = await posting('Аналитик', [fits.toUpperCase(), phrase]);
		await normalize(row.id);
		expect(await queueRow(fits)).toMatchObject({ count: 1 });
		expect(await queueRow(phrase)).toBeUndefined();
	});

	it('refuses a filter of the address it does not know', async () => {
		await expect(
			queuePage.load(
				event(
					sessionActor(adminId),
					new Request('http://localhost/admin/taxonomy/unknown-skills?status=maybe')
				) as never
			)
		).rejects.toMatchObject({ status: 400 });
	});
});
