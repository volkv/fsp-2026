// The candidate's actions on an invitation keep to the demo sessions (domain 19.3) on their own, behind the lists: an
// invitation of a company outside the candidate's place is not found, whatever brought its id.
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	candidates,
	companies,
	consentEvents,
	demoSessions,
	invitations,
	matchRulesets,
	productPolicies,
	users
} from '$lib/server/db/schema';
import type { InvitationDeps, RequestMeta } from '$lib/server/invitations/deps';
import { Refusal } from '$lib/server/invitations/errors';
import { markInvitationViewed, respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation } from '$lib/server/invitations/send';
import { matchRulesetParamsSchema } from '$lib/server/matching/params';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	randomSha256,
	offerTerms
} from '../helpers/factories';

const DAY = 86_400_000;
const EPOCH = new Date(Date.now() - 400 * DAY);

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 9)
});

let database: TestDatabase;
let taxonomyVersionId: string;
let documents: Record<'pd' | 'catalog' | 'disclosure', { id: string }>;
let deps: InvitationDeps;
const meta: RequestMeta = { requestId: 'test-request', ip: '127.0.0.1', userAgent: 'vitest' };

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	deps = { db, crypto, now: () => new Date() };
	taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	await db.insert(matchRulesets).values({
		version: shippedMatchRuleset.version,
		taxonomyVersionId,
		params: matchRulesetParamsSchema.parse(shippedMatchRuleset.params)
	});
	const published = { publishedAt: EPOCH };
	documents = {
		pd: await createPublishedDocument(db, 'pd_processing', published),
		catalog: await createPublishedDocument(db, 'catalog_visibility', published),
		disclosure: await createPublishedDocument(db, 'contact_disclosure', published)
	};
	await db.insert(productPolicies).values([
		{
			kind: 'invitation_policy',
			version: 1,
			params: {
				response_window_hours: 72,
				decline_reason_codes: ['salary', 'other'],
				reason_required: true,
				max_open_per_company_per_day: 50,
				reopen_cooldown_days: 14,
				max_reopens: 2
			},
			effectiveFrom: EPOCH
		},
		{
			kind: 'hiring_policy',
			version: 1,
			params: {
				outcome_due_days: 30,
				reminder_intervals_days: [7],
				max_reminders: 2,
				stages: ['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'],
				outcome_reason_codes: ['salary', 'other']
			},
			effectiveFrom: EPOCH
		},
		{
			kind: 'notification_policy',
			version: 1,
			params: { response_due_reminder_hours: [24, 2] },
			effectiveFrom: EPOCH
		}
	]);
});

afterAll(async () => {
	await database.drop();
});

async function demoSession(): Promise<string> {
	const [row] = await database.db
		.insert(demoSessions)
		.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + DAY) })
		.returning();
	if (!row) throw new Error('demo session not inserted');
	return row.id;
}

async function employer() {
	const { db } = database;
	const company = await createCompany(db, { status: 'verified' });
	const member = await createMember(db, company.id);
	if (!member.userId) throw new Error('member without user');
	const vacancy = await createOwnVacancy(
		db,
		{ companyId: company.id, memberId: member.id, taxonomyVersionId },
		{ salaryMin: 250_000, salaryMax: 350_000 }
	);
	const subject: AccessSubject = {
		userId: member.userId,
		via: 'session',
		candidate: null,
		membership: {
			memberId: member.id,
			companyId: company.id,
			role: 'owner',
			status: 'active',
			companyStatus: 'verified'
		},
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { company, vacancy, subject };
}

async function candidate() {
	const { db } = database;
	const email = `candidate-${randomBytes(4).toString('hex')}@example.org`;
	const [user] = await db
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email)
		})
		.returning();
	if (!user) throw new Error('user not inserted');
	const row = await createCandidate(db, {
		userId: user.id,
		birthDate: '1996-01-15',
		visibility: 'catalog',
		lastNameEnc: crypto.encrypt('Иванова', 'candidates.last_name'),
		firstNameEnc: crypto.encrypt('Анна', 'candidates.first_name')
	});
	for (const kind of ['pd_processing', 'catalog_visibility'] as const) {
		await db.insert(consentEvents).values({
			subjectCandidateId: row.id,
			kind,
			documentId: kind === 'pd_processing' ? documents.pd.id : documents.catalog.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: user.id,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date(EPOCH.getTime() + DAY)
		});
	}
	const subject: AccessSubject = {
		userId: user.id,
		via: 'session',
		candidate: { id: row.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { id: row.id, userId: user.id, subject };
}

/**
 * An invitation sent while the company and the candidate stood outside sessions, then each moved to the given place:
 * the state a lapse of the lists would leave behind.
 */
async function invitationAcross(companySession: string | null, candidateSession: string | null) {
	const { db } = database;
	const company = await employer();
	const person = await candidate();
	const sent = await createInvitation(deps, company.subject, meta, {
		...offerTerms({
			vacancyId: company.vacancy.id,
			salaryMin: 300_000,
			salaryMax: 340_000,
			message: 'Здравствуйте! Приглашаем на собеседование.'
		}),
		candidateId: person.id
	});
	await db.update(companies).set({ demoSessionId: companySession }).where(eq(companies.id, company.company.id));
	await db.update(users).set({ demoSessionId: candidateSession }).where(eq(users.id, person.userId));
	await db.update(candidates).set({ demoSessionId: candidateSession }).where(eq(candidates.id, person.id));
	return { person, sent };
}

async function refusal(operation: Promise<unknown>): Promise<Refusal> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof Refusal) return error;
		throw error;
	}
	throw new Error('the operation was expected to be refused');
}

const decline = (person: { subject: AccessSubject }, invitationId: string, termsId: string) =>
	respondToInvitation(deps, person.subject, meta, invitationId, {
		termsId,
		decision: 'decline',
		reasonCode: 'salary'
	});

const statusOf = async (invitationId: string) =>
	(
		await database.db.select({ status: invitations.status }).from(invitations).where(eq(invitations.id, invitationId))
	)[0]?.status;

describe('the candidate side of an invitation across demo sessions', () => {
	it('does not reach an invitation of a company of a session from outside sessions', async () => {
		const { person, sent } = await invitationAcross(await demoSession(), null);
		const viewed = await refusal(markInvitationViewed(deps, person.subject, sent.invitationId));
		expect([viewed.code, viewed.reason]).toEqual(['not_found', 'not_in_demo_scope']);
		const answered = await refusal(decline(person, sent.invitationId, sent.termsId));
		expect([answered.code, answered.reason]).toEqual(['not_found', 'not_in_demo_scope']);
		expect(await statusOf(sent.invitationId)).toBe('sent');
	});

	it('does not reach an invitation of a company of another session', async () => {
		const { person, sent } = await invitationAcross(await demoSession(), await demoSession());
		expect((await refusal(markInvitationViewed(deps, person.subject, sent.invitationId))).reason).toBe(
			'not_in_demo_scope'
		);
		expect((await refusal(decline(person, sent.invitationId, sent.termsId))).reason).toBe('not_in_demo_scope');
		expect(await statusOf(sent.invitationId)).toBe('sent');
	});

	it('does not reach an invitation of an original of the cast from a session', async () => {
		const { person, sent } = await invitationAcross(null, await demoSession());
		const { db } = database;
		const [row] = await db
			.select({ companyId: invitations.companyId })
			.from(invitations)
			.where(eq(invitations.id, sent.invitationId));
		if (!row) throw new Error('invitation not found');
		await db.update(companies).set({ demoOriginal: true }).where(eq(companies.id, row.companyId));
		expect((await refusal(markInvitationViewed(deps, person.subject, sent.invitationId))).reason).toBe(
			'not_in_demo_scope'
		);
		expect((await refusal(decline(person, sent.invitationId, sent.termsId))).reason).toBe('not_in_demo_scope');
	});

	it('acts on an invitation of the own session', async () => {
		const session = await demoSession();
		const { person, sent } = await invitationAcross(session, session);
		expect(await markInvitationViewed(deps, person.subject, sent.invitationId)).toBe('viewed');
		expect(await decline(person, sent.invitationId, sent.termsId)).toMatchObject({ status: 'declined' });
	});

	it('acts outside sessions on an invitation of a company outside sessions', async () => {
		const { person, sent } = await invitationAcross(null, null);
		expect(await markInvitationViewed(deps, person.subject, sent.invitationId)).toBe('viewed');
		expect(await decline(person, sent.invitationId, sent.termsId)).toMatchObject({ status: 'declined' });
	});
});
