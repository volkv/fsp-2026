// Notifications of the FSP operator's decisions (docs/domain.md 3.7, 5.2, 6.4, 12.3): the decision and the notification
// are one transaction; a letter names the decision and not its reasons, the operator's notes or the representative's
// document; the link leads to where the result is read, and only while the recipient still has access to the object.
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { RequestMeta } from '$lib/server/auth/context';
import { assignDispute, changeCategory, openDispute, upholdCategory } from '$lib/server/categorization/disputes';
import { createCategorizationHandler } from '$lib/server/categorization/job';
import type { CompanyDeps } from '$lib/server/companies/context';
import { registryNotConfigured } from '$lib/server/companies/registry';
import { decideVerification } from '$lib/server/companies/verification';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	categorizationRuns,
	categoryDisputes,
	companies,
	companyMembers,
	companyVerifications,
	legalRepresentatives,
	notifications,
	productPolicies,
	representations
} from '$lib/server/db/schema';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { notificationFacts } from '$lib/server/notifications/content';
import { notificationLinks } from '$lib/server/notifications/deliver';
import { openNotification } from '$lib/server/notifications/inbox';
import { notificationLetter, telegramText } from '$lib/server/notifications/templates';
import { isNotificationType } from '$lib/server/notifications/types';
import { decideAuthority } from '$lib/server/operator/representatives';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createCompany, createMember, createUser } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const APP_ORIGIN = 'https://career.test';
const COMPANY_NAME = 'Проверяемая Компания';

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 4)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 6)
});

let database: TestDatabase;
const meta = (): RequestMeta => ({ requestId: `test-${randomUUID()}`, ip: '10.0.0.1', userAgent: 'vitest' });

function companyDeps(): CompanyDeps {
	return {
		db: database.db,
		crypto,
		mailer: { send: () => Promise.reject(new Error('the decision sends no letter by itself')) },
		registry: registryNotConfigured,
		appOrigin: APP_ORIGIN,
		now: () => new Date()
	};
}

async function operator(): Promise<AccessSubject> {
	const user = await createUser(database.db);
	return {
		userId: user.id,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: true, admin: false, extraPermissions: [] }
	};
}

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	await database.db.insert(productPolicies).values({
		kind: 'minor_policy',
		version: 1,
		params: { enabled: true, authority_methods: ['document_upload', 'document_presented', 'in_person'] },
		effectiveFrom: new Date(Date.now() - 86_400_000)
	});
}, 120_000);

afterAll(async () => {
	await database.drop();
});

const notificationsOf = (objectId: string) =>
	database.db
		.select()
		.from(notifications)
		.where(eq(notifications.objectId, objectId))
		.orderBy(notifications.createdAt, notifications.id);

/** The letter and the Telegram text the recipient would get now; `null` — the object is no longer theirs. */
async function messagesOf(notification: typeof notifications.$inferSelect) {
	if (!isNotificationType(notification.type)) throw new Error(`unknown type ${notification.type}`);
	const facts = await notificationFacts(database.db, crypto, { ...notification, type: notification.type });
	if (!facts) return null;
	const links = notificationLinks(APP_ORIGIN, notification.id);
	const letter = notificationLetter(
		'someone@example.org',
		notification.type,
		facts,
		notification.payload as Record<string, unknown>,
		links
	);
	return { facts, letter, telegram: telegramText(notification.type) };
}

async function targetOf(notification: typeof notifications.$inferSelect) {
	const opened = await openNotification(database.db, notification.userId, notification.id, new Date());
	if (!opened) throw new Error('the recipient has no such notification');
	return opened.target;
}

describe('company verification decisions', () => {
	it('reach the applicant and every active owner, each decision separately, without the reason', async () => {
		const { db } = database;
		const company = await createCompany(db, { status: 'submitted', verifiedAt: null, displayName: COMPANY_NAME });
		const applicant = await createMember(db, company.id);
		const coOwner = await createMember(db, company.id);
		const recruiter = await createMember(db, company.id, { role: 'recruiter' });
		const removed = await createMember(db, company.id, { status: 'removed', removedAt: new Date() });
		const request = async () => {
			const [row] = await db
				.insert(companyVerifications)
				.values({ companyId: company.id, applicantMemberId: applicant.id, authorityMethod: 'corporate_email_domain' })
				.returning();
			if (!row) throw new Error('verification not inserted');
			return row.id;
		};
		const reviewer = { subject: await operator(), meta: meta() };
		const reason = 'Приложите доверенность на подписанта заявки';

		const first = await request();
		await decideVerification(companyDeps(), reviewer, first, { kind: 'request_info', reason });
		const afterFirst = await notificationsOf(company.id);
		expect(afterFirst.map((n) => [n.userId, n.type, n.category, n.objectType, n.payload])).toEqual(
			expect.arrayContaining([
				[
					applicant.userId,
					'company.verification_decided',
					'account',
					'company',
					{ verification_id: first, decision: 'needs_info' }
				],
				[
					coOwner.userId,
					'company.verification_decided',
					'account',
					'company',
					{ verification_id: first, decision: 'needs_info' }
				]
			])
		);
		expect(afterFirst).toHaveLength(2);
		expect(afterFirst.map((n) => n.userId)).not.toContain(recruiter.userId);
		expect(afterFirst.map((n) => n.userId)).not.toContain(removed.userId);

		const [toApplicant] = afterFirst.filter((n) => n.userId === applicant.userId);
		if (!toApplicant) throw new Error('no notification to the applicant');
		const messages = await messagesOf(toApplicant);
		expect(messages?.letter.subject).toBe('Заявка на проверку компании возвращена на уточнение — ФСП | Карьера');
		expect(messages?.letter.text).toContain(COMPANY_NAME);
		expect(messages?.letter.text).not.toContain(reason);
		expect(messages?.telegram).toBe('Решение по проверке компании — ФСП | Карьера');
		expect(await targetOf(toApplicant)).toEqual({ kind: 'company_profile' });

		// The owner submits again; the approval of the new request is a notification of its own.
		await db.update(companies).set({ status: 'submitted' }).where(eq(companies.id, company.id));
		const second = await request();
		await decideVerification(companyDeps(), { subject: reviewer.subject, meta: meta() }, second, { kind: 'approve' });
		const approvals = (await notificationsOf(company.id)).filter(
			(n) => (n.payload as { verification_id: string }).verification_id === second
		);
		expect(approvals.map((n) => n.userId).sort()).toEqual([applicant.userId, coOwner.userId].sort());
		const [approval] = approvals;
		if (!approval) throw new Error('no approval notification');
		expect((await messagesOf(approval))?.letter.subject).toBe('Компания подтверждена — ФСП | Карьера');

		// A member who left the company is told nothing more and led nowhere.
		await db
			.update(companyMembers)
			.set({ status: 'removed', removedAt: new Date() })
			.where(eq(companyMembers.id, coOwner.id));
		const [toCoOwner] = approvals.filter((n) => n.userId === coOwner.userId);
		if (!toCoOwner) throw new Error('no notification to the co-owner');
		expect(await messagesOf(toCoOwner)).toBeNull();
		expect(await targetOf(toCoOwner)).toEqual({ kind: 'unavailable' });
	});

	it('are not created when the decision fails', async () => {
		const { db } = database;
		const company = await createCompany(db, { status: 'submitted', verifiedAt: null });
		const recruiterOnly = await createMember(db, company.id, { role: 'recruiter' });
		const [verification] = await db
			.insert(companyVerifications)
			.values({ companyId: company.id, applicantMemberId: recruiterOnly.id, authorityMethod: 'corporate_email_domain' })
			.returning();
		if (!verification) throw new Error('verification not inserted');
		await expect(
			decideVerification(companyDeps(), { subject: await operator(), meta: meta() }, verification.id, {
				kind: 'approve'
			})
		).rejects.toMatchObject({ code: 'conflict' });
		expect(await notificationsOf(company.id)).toEqual([]);
	});
});

describe('dispute decisions', () => {
	const handler = createCategorizationHandler(() => new Date());

	/** A candidate with a category published by the calculation, and an objection taken into review. */
	async function disputeInReview() {
		const { db } = database;
		const candidate = await createCandidate(db);
		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'categorization.compute',
				{ candidate_id: candidate.id },
				{ inputVersion: '0', createdBy: { kind: 'system' } }
			)
		);
		const claimed = await claimJob(db, `worker-${randomBytes(3).toString('hex')}`, ['categorization.compute']);
		if (claimed?.type !== 'categorization.compute') throw new Error('no categorization job to run');
		const job: ClaimedJob<'categorization.compute'> = {
			...claimed,
			type: 'categorization.compute',
			payload: JOB_TYPES['categorization.compute'].payload.parse(claimed.payload)
		};
		const result = await handler.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: createLogger({ service: 'test' }).child({ job_id: job.id })
		});
		expect(await completeJob(db, job, result)).toBe('succeeded');
		const [run] = await db
			.select({ id: categorizationRuns.id })
			.from(categorizationRuns)
			.where(and(eq(categorizationRuns.candidateId, candidate.id), eq(categorizationRuns.status, 'published')));
		if (!run) throw new Error('no published run');
		const dispute = await openDispute(db, {
			candidateId: candidate.id,
			userId: candidate.userId,
			runId: run.id,
			reason: 'Я третий год пишу бэкенд на Go',
			requestId: 'r'
		});
		const reviewer = await createUser(db);
		await assignDispute(db, { disputeId: dispute.id, operatorId: reviewer.id, requestId: 'r' });
		return { candidate, dispute, reviewerId: reviewer.id };
	}

	it('tell the candidate that the category was upheld and lead to the category page', async () => {
		const { candidate, dispute, reviewerId } = await disputeInReview();
		const resolution = 'Опыт в резюме не подтверждён источниками';
		await upholdCategory(database.db, { disputeId: dispute.id, operatorId: reviewerId, resolution, requestId: 'r' });

		const sent = await notificationsOf(dispute.id);
		expect(sent.map((n) => [n.userId, n.type, n.category, n.objectType, n.payload])).toEqual([
			[
				candidate.userId,
				'dispute.decided',
				'disputes',
				'category_dispute',
				{ dispute_id: dispute.id, status: 'resolved_upheld' }
			]
		]);
		const [row] = await database.db.select().from(categoryDisputes).where(eq(categoryDisputes.id, dispute.id));
		expect(row?.notifiedAt).not.toBeNull();
		const [notification] = sent;
		if (!notification) throw new Error('no notification');
		const messages = await messagesOf(notification);
		expect(messages?.letter.subject).toBe('Возражение рассмотрено: категория оставлена — ФСП | Карьера');
		expect(messages?.letter.text).not.toContain(resolution);
		expect(messages?.telegram).toBe('Ответ на возражение по категории — ФСП | Карьера');
		expect(await targetOf(notification)).toEqual({ kind: 'candidate_category' });
		// Another user cannot open the candidate's notification.
		const stranger = await createUser(database.db);
		expect(await openNotification(database.db, stranger.id, notification.id, new Date())).toBeNull();
	});

	it('tell the candidate that the category was replaced by the operator’s decision', async () => {
		const { candidate, dispute, reviewerId } = await disputeInReview();
		await changeCategory(database.db, {
			disputeId: dispute.id,
			operatorId: reviewerId,
			resolution: 'Опыт подтверждён документами',
			axes: { roleKey: 'backend', grade: { min: 'junior', max: 'middle', confidence: 0.6 }, stackSkillKeys: ['go'] },
			requestId: 'r'
		});
		const sent = await notificationsOf(dispute.id);
		expect(sent.map((n) => [n.userId, n.type, n.payload])).toEqual([
			[candidate.userId, 'dispute.decided', { dispute_id: dispute.id, status: 'resolved_changed' }]
		]);
		const [notification] = sent;
		if (!notification) throw new Error('no notification');
		expect((await messagesOf(notification))?.letter.subject).toBe(
			'Возражение рассмотрено: категория изменена — ФСП | Карьера'
		);
	});
});

describe('representation decisions', () => {
	/** A candidate aged 16 whose representative confirmed the address. */
	async function awaitingRepresentation() {
		const { db } = database;
		const birth = new Date();
		birth.setUTCFullYear(birth.getUTCFullYear() - 16);
		const ward = await createCandidate(db, { birthDate: birth.toISOString().slice(0, 10) });
		const [representative] = await db
			.insert(legalRepresentatives)
			.values({
				fullNameEnc: crypto.encrypt('Петрова Анна Сергеевна', 'legal_representatives.full_name'),
				emailEnc: crypto.encrypt('parent@example.org', 'legal_representatives.email'),
				emailHmac: crypto.lookupHmac('email', 'parent@example.org')
			})
			.returning();
		if (!representative) throw new Error('representative not inserted');
		const [representation] = await db
			.insert(representations)
			.values({
				candidateId: ward.id,
				representativeId: representative.id,
				relation: 'parent',
				status: 'contact_confirmed',
				invitedAt: new Date(Date.now() - 86_400_000),
				contactConfirmedAt: new Date(Date.now() - 3_600_000)
			})
			.returning();
		if (!representation) throw new Error('representation not inserted');
		return { ward, representationId: representation.id };
	}

	it('tell the ward the result only, and lead to the visibility page once the authority is confirmed', async () => {
		const { ward, representationId } = await awaitingRepresentation();
		const basisNote = 'Свидетельство сверено на видеозвонке';
		await decideAuthority(
			database.db,
			await operator(),
			meta(),
			representationId,
			{ result: 'verified', method: 'document_presented', basisKind: 'birth_certificate', basisNote, note: '' },
			new Date()
		);
		const sent = await notificationsOf(representationId);
		expect(sent.map((n) => [n.userId, n.type, n.category, n.objectType, n.payload])).toEqual([
			[
				ward.userId,
				'representation.decided',
				'account',
				'representation',
				{ representation_id: representationId, result: 'verified' }
			]
		]);
		const [notification] = sent;
		if (!notification) throw new Error('no notification');
		const messages = await messagesOf(notification);
		expect(messages?.letter.subject).toBe('Полномочия представителя подтверждены — ФСП | Карьера');
		for (const secret of [basisNote, 'Петрова', 'Свидетельство', 'видеозвон']) {
			expect(messages?.letter.text).not.toContain(secret);
		}
		expect(messages?.telegram).toBe('Решение по полномочиям представителя — ФСП | Карьера');
		expect(await targetOf(notification)).toEqual({ kind: 'candidate_visibility' });
	});

	it('tell the ward that the authority was not confirmed without the operator’s note', async () => {
		const { ward, representationId } = await awaitingRepresentation();
		const note = 'Документ на другое имя, представитель не пришёл повторно';
		await decideAuthority(
			database.db,
			await operator(),
			meta(),
			representationId,
			{ result: 'rejected', method: 'in_person', basisKind: 'birth_certificate', basisNote: '', note },
			new Date()
		);
		const [notification] = await notificationsOf(representationId);
		if (!notification) throw new Error('no notification');
		expect(notification).toMatchObject({ userId: ward.userId, payload: { result: 'rejected' } });
		const messages = await messagesOf(notification);
		expect(messages?.letter.subject).toBe('Полномочия представителя не подтверждены — ФСП | Карьера');
		expect(messages?.letter.text).not.toContain(note);
		expect(await targetOf(notification)).toEqual({ kind: 'candidate_representative' });
		const [count] = await database.db
			.select({ n: sql<number>`count(*)::int` })
			.from(notifications)
			.where(eq(notifications.objectId, representationId));
		expect(count?.n).toBe(1);
	});
});
