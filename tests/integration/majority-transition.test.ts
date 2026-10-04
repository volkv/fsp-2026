// Majority (docs/domain.md, sections 6.3, 6.4, 7.3): the daily schedule finds the adults whose consents or
// representation still date from minority and enqueues `candidate.majority_transition` once per candidate and day; the
// job records `lapse` for every consent resting on a grant of minority, the candidate's own and the representative's,
// ends the representation (`majority`), hides the profile and asks the candidate to sign again. A consent the adult
// signed after 18 stays in force; a minor and an adult without such consents are not touched.
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { effectiveConsentOf } from '$lib/server/consent/effective';
import { candidateMajorityTransition, scheduleMajorityTransitions } from '$lib/server/consent/majority';
import { processingAllowed } from '$lib/server/consent/processing';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	candidates,
	consentEvents,
	emailTokens,
	jobs,
	legalRepresentatives,
	notifications,
	representations
} from '$lib/server/db/schema';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { notificationFacts } from '$lib/server/notifications/content';
import { openNotification } from '$lib/server/notifications/inbox';
import { notificationLetter } from '$lib/server/notifications/templates';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { testEnvironment } from '../helpers/environment';
import { createCandidate, createPublishedDocument, randomSha256 } from '../helpers/factories';

const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const DAY = 86_400_000;
const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});

let database: TestDatabase;
let documents: Record<'pd' | 'catalog' | 'fsp', { id: string }>;

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url }));
	const published = { publishedAt: new Date('2000-01-01T00:00:00Z') };
	documents = {
		pd: await createPublishedDocument(database.db, 'pd_processing', published),
		catalog: await createPublishedDocument(database.db, 'catalog_visibility', published),
		fsp: await createPublishedDocument(database.db, 'fsp_import', published)
	};
});

afterAll(async () => {
	await database.drop();
});

/** The birth date of someone who turns `years` old `daysFromToday` days from now (negative — in the past). */
function birthDate(years: number, daysFromToday: number): string {
	const date = new Date(Date.now() + daysFromToday * DAY);
	date.setUTCFullYear(date.getUTCFullYear() - years);
	return date.toISOString().slice(0, 10);
}

const KINDS = { pd: 'pd_processing', catalog: 'catalog_visibility', fsp: 'fsp_import' } as const;

async function grant(
	candidateId: string,
	userId: string,
	kind: keyof typeof KINDS,
	at: Date,
	representationId?: string
) {
	await database.db.insert(consentEvents).values({
		subjectCandidateId: candidateId,
		kind: KINDS[kind],
		documentId: documents[kind].id,
		action: 'grant',
		...(representationId
			? { signerKind: 'representative' as const, representationId }
			: { signerKind: 'subject' as const, signerUserId: userId }),
		method: representationId ? 'email_link' : 'separate_screen_button',
		evidence: {},
		occurredAt: at
	});
}

/** A candidate with a verified representative, both signed the consents while the candidate was a minor. */
async function representedCandidate(birth: string) {
	const { db } = database;
	const row = await createCandidate(db, { birthDate: birth, visibility: 'catalog' }, { processingConsent: false });
	const [person] = await db
		.insert(legalRepresentatives)
		.values({ fullNameEnc: randomBytes(32), emailEnc: randomBytes(32), emailHmac: randomSha256() })
		.returning();
	if (!person) throw new Error('representative not inserted');
	const [representation] = await db
		.insert(representations)
		.values({
			candidateId: row.id,
			representativeId: person.id,
			relation: 'parent',
			status: 'authority_verified',
			invitedAt: new Date(Date.now() - 400 * DAY),
			contactConfirmedAt: new Date(Date.now() - 399 * DAY)
		})
		.returning();
	if (!representation) throw new Error('representation not inserted');
	const signedAt = new Date(Date.now() - 300 * DAY);
	for (const kind of ['pd', 'catalog', 'fsp'] as const) {
		await grant(row.id, row.userId, kind, signedAt);
		await grant(row.id, row.userId, kind, signedAt, representation.id);
	}
	// A link of the representative still waiting to be used.
	await db.insert(emailTokens).values({
		purpose: 'representative_consent',
		tokenHash: randomSha256(),
		targetRef: representation.id,
		expiresAt: new Date(Date.now() + 7 * DAY)
	});
	return { ...row, representationId: representation.id };
}

async function runDueJobs(): Promise<string[]> {
	const done: string[] = [];
	for (;;) {
		const claimed = (await claimJob(database.db, 'majority-test', [
			'candidate.majority_transition'
		])) as ClaimedJob<'candidate.majority_transition'> | null;
		if (!claimed) return done;
		const result = await candidateMajorityTransition.run({
			job: claimed,
			db: database.db,
			signal: new AbortController().signal,
			requestId: `job:${claimed.id}`,
			log: createLogger({}, () => undefined)
		});
		expect(await completeJob(database.db, claimed, result)).toBe('succeeded');
		done.push(claimed.payload.candidate_id);
	}
}

describe('candidate.majority_transition', () => {
	it('lapses the consents of minority, ends the representation and asks the adult to sign again', async () => {
		const { db } = database;
		const now = new Date();
		// Turned 18 today.
		const today = await representedCandidate(birthDate(18, 0));
		// Turned 18 a month ago and already signed the processing consent anew; the other consents date from minority.
		const renewed = await representedCandidate(birthDate(18, -30));
		await grant(renewed.id, renewed.userId, 'pd', new Date(Date.now() - 10 * DAY));
		// Turns 18 tomorrow: still a minor.
		const tomorrow = await representedCandidate(birthDate(18, 1));
		// An adult for years with consents of adulthood only.
		const adult = await createCandidate(db, { birthDate: birthDate(30, -100) });

		expect(await scheduleMajorityTransitions(db, now)).toBe(2);
		// Once a day: the next tick of the same day enqueues nothing.
		expect(await scheduleMajorityTransitions(db, now)).toBe(0);
		const enqueued = await db
			.select({ id: sql<string>`${jobs.payload} ->> 'candidate_id'`, version: jobs.inputVersion })
			.from(jobs)
			.where(eq(jobs.type, 'candidate.majority_transition'));
		expect(new Set(enqueued.map((job) => job.id))).toEqual(new Set([today.id, renewed.id]));
		expect(enqueued.every((job) => job.version === now.toISOString().slice(0, 10))).toBe(true);

		expect(new Set(await runDueJobs())).toEqual(new Set([today.id, renewed.id]));

		const lapses = async (candidateId: string) =>
			(
				await db
					.select({ kind: consentEvents.kind, reason: consentEvents.reason, signer: consentEvents.signerKind })
					.from(consentEvents)
					.where(and(eq(consentEvents.subjectCandidateId, candidateId), eq(consentEvents.action, 'lapse')))
			).map((row) => ({ ...row }));
		expect(new Set((await lapses(today.id)).map((row) => row.kind))).toEqual(
			new Set(['pd_processing', 'catalog_visibility', 'fsp_import'])
		);
		expect((await lapses(today.id)).every((row) => row.reason === 'majority' && row.signer === 'system')).toBe(true);
		// The processing consent the adult signed after 18 stands.
		expect(new Set((await lapses(renewed.id)).map((row) => row.kind))).toEqual(
			new Set(['catalog_visibility', 'fsp_import'])
		);
		expect(await processingAllowed(db, renewed.id, new Date())).toBe(true);
		expect(await processingAllowed(db, today.id, new Date())).toBe(false);
		expect(await effectiveConsentOf(db, today.id, 'catalog_visibility', new Date())).toBeNull();

		for (const who of [today, renewed]) {
			const [representation] = await db
				.select()
				.from(representations)
				.where(eq(representations.id, who.representationId));
			expect(representation).toMatchObject({ status: 'ended', endReason: 'majority' });
			expect(await db.select().from(emailTokens).where(eq(emailTokens.targetRef, who.representationId))).toEqual([]);
			const [profile] = await db.select().from(candidates).where(eq(candidates.id, who.id));
			expect(profile).toMatchObject({ status: 'active', visibility: 'hidden' });
			const [notice] = await db
				.select()
				.from(notifications)
				.where(and(eq(notifications.userId, who.userId), eq(notifications.type, 'candidate.majority_reached')));
			if (!notice) throw new Error('no notification of majority');
			// It leads to the page of consents, and its letter asks to sign.
			const opened = await openNotification(db, who.userId, notice.id, new Date());
			expect(opened?.target).toEqual({ kind: 'candidate_consents' });
			const facts = await notificationFacts(db, crypto, {
				type: 'candidate.majority_reached',
				objectType: notice.objectType,
				objectId: notice.objectId,
				userId: who.userId
			});
			expect(facts).toEqual({ object: 'candidate', side: 'candidate' });
			if (!facts) throw new Error('no facts');
			const letter = notificationLetter(
				'person@example.org',
				'candidate.majority_reached',
				facts,
				notice.payload as Record<string, unknown>,
				{
					open: `http://localhost/notifications/${notice.id}`,
					settings: 'http://localhost/account/notifications'
				}
			);
			expect(letter.subject).toContain('18');
		}
		const journal = await db
			.select({ action: auditEvents.action, details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.subjectCandidateId, today.id));
		expect(journal.filter((event) => event.action === 'consent.lapsed')).toHaveLength(3);
		expect(journal).toContainEqual({ action: 'representation.ended', details: { end_reason: 'majority' } });

		// The minor and the adult are untouched.
		const [young] = await db.select().from(representations).where(eq(representations.id, tomorrow.representationId));
		expect(young?.status).toBe('authority_verified');
		expect(await lapses(tomorrow.id)).toEqual([]);
		expect(await lapses(adult.id)).toEqual([]);

		// The next day: only the one who turns 18 then.
		const next = new Date(Date.now() + DAY);
		expect(await scheduleMajorityTransitions(db, next)).toBe(1);
		const [due] = await db
			.select({ id: sql<string>`${jobs.payload} ->> 'candidate_id'` })
			.from(jobs)
			.where(
				and(eq(jobs.type, 'candidate.majority_transition'), eq(jobs.inputVersion, next.toISOString().slice(0, 10)))
			);
		expect(due?.id).toBe(tomorrow.id);
	});
});
