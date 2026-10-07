// `vacancies.text_recheck` (docs/domain.md, section 13.1): the vacancies whose text was checked by another version of
// the validator are checked again by the version in force, a batch per run. A listed vacancy whose text is now blocked
// goes to an operator, as an edit would send it, unless the operator approved the same phrases; one in moderation whose
// phrases changed gets a new revision the operator decides on, and one whose text now passes returns to where it left
// from. Every vacancy ends on the version in force, and a second pass changes nothing. The schedule enqueues the recheck while a vacancy lags and
// no job of the version waits, runs or failed.
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, jobs, vacancies } from '$lib/server/db/schema';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { decideVacancyModeration } from '$lib/server/vacancies/own';
import {
	TEXT_CHECK_VERSION,
	checkVacancyText,
	textCheckSchema,
	type TextCheck
} from '$lib/server/vacancies/text-check';
import { RECHECK_BATCH, scheduleTextRecheck, vacanciesTextRecheck } from '$lib/server/vacancies/text-recheck';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCompany, createMember, createOwnVacancy, createTaxonomyVersion } from '../helpers/factories';

const BLOCKED = 'Только мужчины до 30 лет';
const CLEAN = 'Разработка сервисов на Go, код-ревью, дежурства';
const YOUTH = 'Молодой коллектив, разработка сервисов на Go';
const PHOTO = 'Разработка сервисов на Go, отклик с фото';
const TITLE = 'Backend-разработчик на Go';

/** The check the first version made of a text: the phrases the version in force finds, under the first version. */
const firstVersionOf = (description: string, rest: Partial<TextCheck> = {}): TextCheck => ({
	...checkVacancyText({ title: TITLE, description }),
	validator_version: 'text-check/1',
	...rest
});

/** A case the operator approved: the phrases were found lawful. */
const approvedCase = {
	opened_at: '2026-01-01T00:00:00.000Z',
	resume_to: 'published' as const,
	decision: { outcome: 'published' as const, reason: 'Требование законно', at: '2026-01-02T00:00:00.000Z' }
};

/** A check of the first version: the text it found clean. */
const oldClean: TextCheck = {
	validator_version: 'text-check/1',
	result: 'clean',
	phrases: [],
	warnings_confirmed: null,
	moderation: null
};

let database: TestDatabase;
let taxonomyVersionId: string;
let company: { id: string; memberId: string };

beforeAll(async () => {
	database = await createTestDatabase();
	taxonomyVersionId = (await createTaxonomyVersion(database.db)).id;
	const created = await createCompany(database.db);
	company = { id: created.id, memberId: (await createMember(database.db, created.id)).id };
});

afterAll(async () => {
	await database.drop();
});

const own = (overrides: Parameters<typeof createOwnVacancy>[2] = {}) =>
	createOwnVacancy(
		database.db,
		{ companyId: company.id, memberId: company.memberId, taxonomyVersionId },
		{ textCheck: oldClean, ...overrides }
	);

async function stored(vacancyId: string) {
	const [row] = await database.db.select().from(vacancies).where(eq(vacancies.id, vacancyId));
	if (!row) throw new Error('vacancy not found');
	return { status: row.status, check: textCheckSchema.parse(row.textCheck), revision: row.revision };
}

/** Runs the waiting recheck as the worker does; `null` — none waits. */
async function runRecheck() {
	const { db } = database;
	const claimed = (await claimJob(db, 'recheck-test', [
		'vacancies.text_recheck'
	])) as ClaimedJob<'vacancies.text_recheck'> | null;
	if (!claimed) return null;
	const result = await vacanciesTextRecheck.run({
		job: claimed,
		db,
		signal: new AbortController().signal,
		requestId: `job:${claimed.id}`,
		log: createLogger({}, () => undefined)
	});
	expect(await completeJob(db, claimed, result)).toBe('succeeded');
	return result.describe?.() ?? null;
}

/** The schedule enqueues the recheck and the worker runs it with its continuations; the runs it took. */
async function recheckAll(): Promise<Record<string, unknown>[]> {
	await scheduleTextRecheck(database.db);
	const runs: Record<string, unknown>[] = [];
	for (let described = await runRecheck(); described !== null; described = await runRecheck()) runs.push(described);
	return runs;
}

const lagging = async () =>
	(
		await database.db
			.select({ id: vacancies.id })
			.from(vacancies)
			.where(sql`${vacancies.textCheck} ->> 'validator_version' <> ${TEXT_CHECK_VERSION}`)
	).length;

const recheckJobs = () =>
	database.db
		.select({ status: jobs.status })
		.from(jobs)
		.where(eq(jobs.dedupKey, `vacancies.text_recheck:${TEXT_CHECK_VERSION}`));

describe('vacancies.text_recheck', () => {
	it('sends a listed own vacancy the new version blocks to an operator and keeps the others where they are', async () => {
		const published = await own({ description: BLOCKED });
		const paused = await own({ description: BLOCKED, status: 'paused' });
		const draft = await own({ description: BLOCKED, status: 'draft', publishedAt: null });
		const clean = await own({ description: CLEAN });
		// The operator approved the phrases the first version found; the new one finds the same.
		const approved = await own({
			description: BLOCKED,
			textCheck: firstVersionOf(BLOCKED, { moderation: approvedCase })
		});

		await recheckAll();

		const moderated = await stored(published.id);
		expect(moderated.status).toBe('pending_moderation');
		expect(moderated.check).toMatchObject({
			validator_version: TEXT_CHECK_VERSION,
			result: 'blocked',
			moderation: { resume_to: 'published', decision: null }
		});
		expect(moderated.check.phrases.map((p) => p.rule).sort()).toEqual(['age.limit', 'sex.explicit']);
		expect((await stored(paused.id)).check.moderation?.resume_to).toBe('paused');
		expect((await stored(paused.id)).status).toBe('pending_moderation');
		expect(await stored(draft.id)).toMatchObject({ status: 'draft', check: { result: 'blocked', moderation: null } });
		expect(await stored(clean.id)).toMatchObject({ status: 'published', check: { result: 'clean' } });
		expect(await stored(approved.id)).toMatchObject({
			status: 'published',
			check: { validator_version: TEXT_CHECK_VERSION, result: 'blocked', moderation: approvedCase }
		});
		// The text did not change: nothing is recomputed from it.
		expect((await stored(published.id)).revision).toBe(published.revision);

		const journal = await database.db
			.select({ objectId: auditEvents.objectId, actorKind: auditEvents.actorKind })
			.from(auditEvents)
			.where(eq(auditEvents.action, 'vacancy.blocked_text_check'));
		expect(journal.map((row) => row.objectId).sort()).toEqual([paused.id, published.id].sort());
		expect(journal.every((row) => row.actorKind === 'system')).toBe(true);
	});

	it('keeps an approval only while the new version finds the same blocking phrases', async () => {
		// The first version found only the phrase about sex; the operator approved it. The new one finds the age too.
		const first = firstVersionOf(BLOCKED, { moderation: approvedCase });
		const partly = await own({
			description: BLOCKED,
			textCheck: { ...first, phrases: first.phrases.filter((p) => p.rule === 'sex.explicit') }
		});

		await recheckAll();

		expect(await stored(partly.id)).toMatchObject({
			status: 'pending_moderation',
			check: { result: 'blocked', moderation: { resume_to: 'published', decision: null } }
		});
	});

	it('drops the case of an approved vacancy whose text the new version passes', async () => {
		const approved = await own({
			description: CLEAN,
			textCheck: firstVersionOf(BLOCKED, { moderation: approvedCase })
		});

		await recheckAll();

		expect(await stored(approved.id)).toMatchObject({
			status: 'published',
			check: { validator_version: TEXT_CHECK_VERSION, result: 'clean', moderation: null }
		});
	});

	it('keeps a confirmation of warnings only while the new version finds the same warnings', async () => {
		const confirmation = { member_id: company.memberId, at: '2026-01-01T00:00:00.000Z' };
		const same = await own({
			description: YOUTH,
			textCheck: firstVersionOf(YOUTH, { warnings_confirmed: confirmation })
		});
		// The employer confirmed a warning about a photo; the new version finds one about age instead.
		const other = await own({
			description: YOUTH,
			textCheck: firstVersionOf(PHOTO, { warnings_confirmed: confirmation })
		});

		await recheckAll();

		expect(await stored(same.id)).toMatchObject({
			status: 'published',
			check: { result: 'warnings', warnings_confirmed: confirmation }
		});
		expect(await stored(other.id)).toMatchObject({
			status: 'published',
			check: { result: 'warnings', warnings_confirmed: null }
		});
	});

	it('gives a vacancy in moderation a new revision when the new version finds other phrases', async () => {
		const openCase = { opened_at: '2026-01-01T00:00:00.000Z', resume_to: 'published' as const, decision: null };
		const first = firstVersionOf(BLOCKED, { moderation: openCase });
		// The operator opened the case on the phrase about sex; the new version adds the age.
		const moderated = await own({
			description: BLOCKED,
			status: 'pending_moderation',
			textCheck: { ...first, phrases: first.phrases.filter((p) => p.rule === 'sex.explicit') }
		});
		const unchanged = await own({ description: BLOCKED, status: 'pending_moderation', textCheck: first });

		await recheckAll();

		const revised = await stored(moderated.id);
		expect(revised).toMatchObject({
			status: 'pending_moderation',
			revision: moderated.revision + 1,
			check: { validator_version: TEXT_CHECK_VERSION, moderation: openCase }
		});
		expect(revised.check.phrases.map((p) => p.rule).sort()).toEqual(['age.limit', 'sex.explicit']);
		// The vector and the matches follow the new revision, as after an edit.
		const derivations = await database.db
			.select({ type: jobs.type })
			.from(jobs)
			.where(
				and(sql`${jobs.payload} ->> 'vacancy_id' = ${moderated.id}`, eq(jobs.inputVersion, String(revised.revision)))
			);
		expect(derivations.map((job) => job.type).sort()).toEqual(['match.refresh', 'vacancy.embed']);
		// A decision on the phrases the operator read before the recheck is refused.
		await expect(
			decideVacancyModeration({ db: database.db, now: () => new Date() }, moderated.id, {
				operatorUserId: randomUUID(),
				decision: 'publish',
				revision: moderated.revision,
				reason: null,
				requestId: 'req-test'
			})
		).rejects.toMatchObject({ code: 'conflict', details: [{ code: 'vacancy_changed' }] });
		expect((await stored(moderated.id)).status).toBe('pending_moderation');

		// The same phrases under the new version: the case and its revision stay.
		expect(await stored(unchanged.id)).toMatchObject({
			status: 'pending_moderation',
			revision: unchanged.revision,
			check: { validator_version: TEXT_CHECK_VERSION, moderation: openCase }
		});
	});

	it('returns a vacancy in moderation whose text the new version passes to where it left from', async () => {
		const { db } = database;
		const blockedBefore = (resume_to: 'published' | 'paused') =>
			firstVersionOf(BLOCKED, { moderation: { opened_at: '2026-01-01T00:00:00.000Z', resume_to, decision: null } });
		// Sent to the operator on its first publication: it was never listed.
		const fromDraft = await own({
			description: CLEAN,
			status: 'pending_moderation',
			publishedAt: null,
			textCheck: blockedBefore('published')
		});
		const fromPause = await own({
			description: CLEAN,
			status: 'pending_moderation',
			textCheck: blockedBefore('paused')
		});
		const suspended = await createCompany(db, { status: 'suspended' });
		const ofSuspended = await createOwnVacancy(
			db,
			{ companyId: suspended.id, memberId: (await createMember(db, suspended.id)).id, taxonomyVersionId },
			{ description: CLEAN, status: 'pending_moderation', textCheck: blockedBefore('published') }
		);

		await recheckAll();

		const [listed] = await db
			.select({ status: vacancies.status, publishedAt: vacancies.publishedAt })
			.from(vacancies)
			.where(eq(vacancies.id, fromDraft.id));
		expect(listed?.status).toBe('published');
		expect(listed?.publishedAt).toBeInstanceOf(Date);
		expect(await stored(fromDraft.id)).toMatchObject({
			revision: fromDraft.revision,
			check: { validator_version: TEXT_CHECK_VERSION, result: 'clean', moderation: null }
		});
		expect(await stored(fromPause.id)).toMatchObject({ status: 'paused', check: { moderation: null } });
		expect(await stored(ofSuspended.id)).toMatchObject({ status: 'draft', check: { moderation: null } });

		const journal = await db
			.select({ objectId: auditEvents.objectId, action: auditEvents.action, actorKind: auditEvents.actorKind })
			.from(auditEvents)
			.where(sql`${auditEvents.objectId} in (${fromDraft.id}, ${fromPause.id}, ${ofSuspended.id})`);
		expect(
			journal
				.map(
					(row) =>
						`${row.objectId === fromDraft.id ? 'draft' : row.objectId === fromPause.id ? 'pause' : 'suspended'}:${row.action}`
				)
				.sort()
		).toEqual([
			'draft:vacancy.moderation_cleared',
			'draft:vacancy.published',
			'pause:vacancy.moderation_cleared',
			'suspended:vacancy.moderation_cleared'
		]);
		expect(journal.every((row) => row.actorKind === 'system')).toBe(true);
		// The listed vacancy gets its matches, as a publication does.
		const refresh = await db
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.type, 'match.refresh'), sql`${jobs.payload} ->> 'vacancy_id' = ${fromDraft.id}`));
		expect(refresh).toHaveLength(1);
	});

	it('leaves every vacancy on the version in force, and a second pass finds nothing to do', async () => {
		await own({ description: BLOCKED });
		await own({ description: CLEAN, status: 'draft', publishedAt: null });
		await recheckAll();
		expect(await lagging()).toBe(0);
		const before = await database.db.select().from(vacancies).orderBy(vacancies.id);

		// Nothing lags: the schedule enqueues nothing, and a recheck run anyway changes nothing.
		expect(await scheduleTextRecheck(database.db)).toBe(0);
		await database.db.insert(jobs).values({
			type: 'vacancies.text_recheck',
			typeVersion: 1,
			payload: { validator_version: TEXT_CHECK_VERSION },
			inputVersion: TEXT_CHECK_VERSION,
			dedupKey: `vacancies.text_recheck:${TEXT_CHECK_VERSION}`,
			status: 'queued',
			maxAttempts: 3,
			createdBy: { kind: 'system' }
		});
		expect(await runRecheck()).toMatchObject({ restamped: 0, moderation: 0, revised: 0, cleared: 0 });
		expect(await database.db.select().from(vacancies).orderBy(vacancies.id)).toEqual(before);
	});

	it('goes through the lagging vacancies a batch per run, the continuation after the run', async () => {
		for (let i = 0; i < RECHECK_BATCH + 5; i++) await own({ description: CLEAN, status: 'draft', publishedAt: null });

		const runs = await recheckAll();
		expect(runs.map((run) => run.more)).toEqual([true, false]);
		expect(runs.map((run) => run.restamped)).toEqual([RECHECK_BATCH, 5]);
		expect(await lagging()).toBe(0);
	});

	it('is enqueued while a vacancy lags, once, and not again after a failure', async () => {
		const { db } = database;
		await db.delete(jobs).where(eq(jobs.type, 'vacancies.text_recheck'));
		const lag = await own({ description: CLEAN });

		expect(await scheduleTextRecheck(db)).toBe(1);
		expect(await scheduleTextRecheck(db)).toBe(0);
		expect((await recheckJobs()).map((job) => job.status)).toEqual(['queued']);

		// A failed recheck stays visible instead of being restarted by every tick.
		await db
			.update(jobs)
			.set({ status: 'failed', finishedAt: new Date(), lastError: { code: 'test', retryable: false, message: 'x' } })
			.where(and(eq(jobs.type, 'vacancies.text_recheck'), eq(jobs.status, 'queued')));
		expect(await scheduleTextRecheck(db)).toBe(0);
		expect((await stored(lag.id)).check.validator_version).toBe('text-check/1');
	});

	it('leaves a job of another validator version without work', async () => {
		const { db } = database;
		await db.delete(jobs).where(eq(jobs.type, 'vacancies.text_recheck'));
		const lag = await own({ description: BLOCKED });
		await db.insert(jobs).values({
			type: 'vacancies.text_recheck',
			typeVersion: 1,
			payload: { validator_version: 'text-check/1' },
			inputVersion: 'text-check/1',
			dedupKey: 'vacancies.text_recheck:text-check/1',
			status: 'queued',
			maxAttempts: 3,
			createdBy: { kind: 'system' }
		});
		expect(await runRecheck()).toMatchObject({ outdated: true, restamped: 0, moderation: 0 });
		expect(await stored(lag.id)).toMatchObject({ status: 'published', check: { validator_version: 'text-check/1' } });
	});
});
