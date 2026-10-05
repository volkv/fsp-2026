import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { companyTrust } from '$lib/server/companies/trust';
import {
	complaintCase,
	complaintOfOffer,
	complaintQueue,
	decideComplaint,
	fileComplaint
} from '$lib/server/complaints/service';
import { auditEvents, companies, demoSessions, invitations, notifications } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { uuidv7 } from '$lib/server/ids';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createUser } from '../helpers/factories';
import { createOfferWorld, testMeta, type OfferWorld } from '../helpers/offers';

let database: TestDatabase;
let world: OfferWorld;
let operator: AccessSubject;

const operatorMeta = { requestId: 'operator-request', ip: null, userAgent: null };

function operatorSubject(userId: string): AccessSubject {
	return {
		userId,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: true, admin: false, extraPermissions: [] }
	};
}

beforeAll(async () => {
	database = await createTestDatabase();
	world = await createOfferWorld(database);
	operator = operatorSubject((await createUser(database.db)).id);
});

afterAll(async () => {
	await database.drop();
});

async function failure(operation: Promise<unknown>): Promise<ApiError> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('the operation was expected to fail');
}

const typesOf = async (userId: string) =>
	(
		await database.db.select({ type: notifications.type }).from(notifications).where(eq(notifications.userId, userId))
	).map((row) => row.type);

describe('complaints of candidates about offers', () => {
	it('take one complaint of the addressee per offer, in any status', async () => {
		const company = await world.employer();
		const person = await world.candidate();
		const offer = await world.acceptedOffer(company, person);

		const filed = await fileComplaint(world.deps, person.subject, testMeta, offer.invitationId, {
			reasonCode: 'terms_mismatch',
			text: '  На собеседовании назвали вилку на треть ниже предложенной.  '
		});
		expect(filed).toMatchObject({
			reasonCode: 'terms_mismatch',
			text: 'На собеседовании назвали вилку на треть ниже предложенной.',
			status: 'open',
			decision: null
		});
		expect(await complaintOfOffer(world.deps, person.subject, offer.invitationId)).toEqual(filed);

		const again = await failure(
			fileComplaint(world.deps, person.subject, testMeta, offer.invitationId, {
				reasonCode: 'other',
				text: 'Ещё одна жалоба на то же предложение'
			})
		);
		expect(again.code).toBe('conflict');

		const stranger = await world.candidate();
		expect(
			(
				await failure(
					fileComplaint(world.deps, stranger.subject, testMeta, offer.invitationId, {
						reasonCode: 'other',
						text: 'Чужое предложение, не моё'
					})
				)
			).code
		).toBe('not_found');
		expect((await failure(complaintOfOffer(world.deps, stranger.subject, offer.invitationId))).code).toBe('not_found');

		const short = await failure(
			fileComplaint(world.deps, stranger.subject, testMeta, offer.invitationId, {
				reasonCode: 'other',
				text: 'коротко'
			})
		);
		expect(short.code).toBe('validation_failed');
		const unknown = await failure(
			fileComplaint(world.deps, person.subject, testMeta, offer.invitationId, {
				reasonCode: 'rude',
				text: 'Причина не из списка платформы'
			})
		);
		expect(unknown.code).toBe('validation_failed');
	});

	it('are decided by the operator: a warning reaches the candidate and the owners and counts in the facts', async () => {
		const company = await world.employer();
		const person = await world.candidate();
		const offer = await world.sentOffer(company, person);
		const complaint = await fileComplaint(world.deps, person.subject, testMeta, offer.invitationId, {
			reasonCode: 'payment_demanded',
			text: 'Попросили оплатить обучение перед выходом на работу.'
		});

		const queue = await complaintQueue(database.db, operator);
		expect(queue.open.map((item) => item.id)).toContain(complaint.id);

		const opened = await complaintCase(world.deps, operator, operatorMeta, complaint.id);
		expect(opened).toMatchObject({
			text: 'Попросили оплатить обучение перед выходом на работу.',
			company: { id: company.company.id, suspendable: true },
			offer: { invitationId: offer.invitationId, complainedTermsId: offer.termsId },
			companyComplaints: { open: 1, upheld: 0, dismissed: 0 }
		});
		const access = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'operator.case_access'), eq(auditEvents.objectId, complaint.id)));
		expect(access).toEqual([{ details: { case_type: 'complaint', case_id: complaint.id } }]);

		const short = await failure(
			decideComplaint(world.deps, { subject: operator, meta: operatorMeta }, complaint.id, {
				decision: 'warning',
				resolution: 'да'
			})
		);
		expect(short.code).toBe('validation_failed');

		await decideComplaint(world.deps, { subject: operator, meta: operatorMeta }, complaint.id, {
			decision: 'warning',
			resolution: 'Компания подтвердила, что просила оплату; вынесено предупреждение.'
		});
		expect(await complaintOfOffer(world.deps, person.subject, offer.invitationId)).toMatchObject({
			status: 'decided',
			decision: 'warning',
			resolution: 'Компания подтвердила, что просила оплату; вынесено предупреждение.'
		});
		expect(await typesOf(person.userId)).toContain('complaint.decided');
		expect(await typesOf(company.userId)).toContain('company.complaint_upheld');
		// The company learns the reason, never who complained or the words.
		const [upheld] = await database.db
			.select({ payload: notifications.payload })
			.from(notifications)
			.where(and(eq(notifications.userId, company.userId), eq(notifications.type, 'company.complaint_upheld')));
		expect(upheld?.payload).toEqual({ decision: 'warning', reason_code: 'payment_demanded' });

		const [company2] = await database.db
			.select({ status: companies.status })
			.from(companies)
			.where(eq(companies.id, company.company.id));
		expect(company2?.status).toBe('verified');

		// Two more offers make the facts observable: one upheld complaint of three offers.
		await world.sentOffer(company, await world.candidate());
		await world.sentOffer(company, await world.candidate());
		const trust = await companyTrust(database.db, company.company.id, new Date());
		expect(trust.facts.find((fact) => fact.key === 'complaints_upheld')).toEqual({
			key: 'complaints_upheld',
			status: 'shown',
			count: 1,
			of: 3
		});

		const twice = await failure(
			decideComplaint(world.deps, { subject: operator, meta: operatorMeta }, complaint.id, {
				decision: 'no_action',
				resolution: 'Повторное решение по той же жалобе'
			})
		);
		expect(twice.code).toBe('conflict');
	});

	it('suspend the company with the reason `complaint` and withdraw its open offers', async () => {
		const company = await world.employer();
		const person = await world.candidate();
		const accepted = await world.acceptedOffer(company, person);
		const openPerson = await world.candidate();
		const open = await world.sentOffer(company, openPerson);
		const complaint = await fileComplaint(world.deps, person.subject, testMeta, accepted.invitationId, {
			reasonCode: 'no_real_job',
			text: 'На собеседовании сказали, что такой позиции нет и не было.'
		});
		await decideComplaint(world.deps, { subject: operator, meta: operatorMeta }, complaint.id, {
			decision: 'suspension',
			resolution: 'Компания не подтвердила наличие позиции; работа компании приостановлена.'
		});
		const [row] = await database.db
			.select({ status: companies.status })
			.from(companies)
			.where(eq(companies.id, company.company.id));
		expect(row?.status).toBe('suspended');
		const statuses = await database.db
			.select({ id: invitations.id, status: invitations.status })
			.from(invitations)
			.where(eq(invitations.companyId, company.company.id));
		expect(new Map(statuses.map((s) => [s.id, s.status]))).toEqual(
			new Map([
				[accepted.invitationId, 'accepted'],
				[open.invitationId, 'withdrawn']
			])
		);
		const [suspended] = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'company.suspended'), eq(auditEvents.objectId, company.company.id)));
		expect(suspended?.details).toEqual({ reason_code: 'complaint', complaint_id: complaint.id });

		// A complaint about the withdrawn offer of the suspended company cannot suspend it again.
		const second = await fileComplaint(world.deps, openPerson.subject, testMeta, open.invitationId, {
			reasonCode: 'no_real_job',
			text: 'Та же компания, такое же поведение.'
		});
		const refused = await failure(
			decideComplaint(world.deps, { subject: operator, meta: operatorMeta }, second.id, {
				decision: 'suspension',
				resolution: 'Попытка приостановить уже приостановленную компанию.'
			})
		);
		expect(refused.code).toBe('conflict');
		expect((await complaintQueue(database.db, operator)).open.map((item) => item.id)).toContain(second.id);
	});

	it('stay within the reach of an operator of a demo session', async () => {
		const company = await world.employer();
		const person = await world.candidate();
		const offer = await world.sentOffer(company, person);
		const complaint = await fileComplaint(world.deps, person.subject, testMeta, offer.invitationId, {
			reasonCode: 'contact_harvesting',
			text: 'После раскрытия контактов начали присылать рекламу курсов.'
		});
		const [session] = await database.db
			.insert(demoSessions)
			.values({
				joinTokenSha256: 'a'.repeat(64),
				seedBatchId: 'demo-test',
				expiresAt: new Date(Date.now() + 86_400_000)
			})
			.returning({ id: demoSessions.id });
		if (!session) throw new Error('session not inserted');
		const clone = await createUser(database.db, { demoSessionId: session.id });
		const cloneOperator = operatorSubject(clone.id);
		expect((await complaintQueue(database.db, cloneOperator)).open.map((item) => item.id)).not.toContain(complaint.id);
		expect((await failure(complaintCase(world.deps, cloneOperator, operatorMeta, complaint.id))).code).toBe(
			'not_found'
		);
		expect(
			(
				await failure(
					decideComplaint(world.deps, { subject: cloneOperator, meta: operatorMeta }, complaint.id, {
						decision: 'no_action',
						resolution: 'Решение из чужой демо-сессии'
					})
				)
			).code
		).toBe('not_found');
		expect((await failure(complaintCase(world.deps, operator, operatorMeta, uuidv7()))).code).toBe('not_found');
	});
});
