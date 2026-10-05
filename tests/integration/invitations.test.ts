import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invitations, invitationTerms, vacancyClaims } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { loadInvitability } from '$lib/server/vacancies/invitable';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { expectDbError, SQLSTATE } from '../helpers/errors';
import {
	createCandidate,
	createCompany,
	createExternalVacancy,
	createMember,
	createOwnVacancy,
	createPolicy,
	createTaxonomyVersion,
	offerTermsRow
} from '../helpers/factories';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.drop();
});

async function setup() {
	const { db } = database;
	const company = await createCompany(db);
	const member = await createMember(db, company.id);
	const taxonomy = await createTaxonomyVersion(db);
	const vacancy = await createOwnVacancy(db, {
		companyId: company.id,
		memberId: member.id,
		taxonomyVersionId: taxonomy.id
	});
	const candidate = await createCandidate(db);
	const policy = await createPolicy(db, 'invitation_policy', Math.floor(Math.random() * 1_000_000) + 1);
	return { company, member, taxonomy, vacancy, candidate, policy };
}

/** Invitation and its first terms version in one transaction; the mutual references are checked at commit. */
async function sendInvitation(ctx: Awaited<ReturnType<typeof setup>>) {
	const invitationId = uuidv7();
	const termsId = uuidv7();
	await database.db.transaction(async (tx) => {
		await tx.insert(invitations).values({
			id: invitationId,
			companyId: ctx.company.id,
			candidateId: ctx.candidate.id,
			sentByMemberId: ctx.member.id,
			status: 'sent',
			currentTermsId: termsId,
			policyId: ctx.policy.id,
			sentAt: new Date()
		});
		await tx.insert(invitationTerms).values({
			id: termsId,
			invitationId,
			version: 1,
			...offerTermsRow(),
			salaryMin: 250_000,
			salaryMax: 350_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			responseDueAt: new Date(Date.now() + 72 * 3600_000),
			createdByMemberId: ctx.member.id
		});
	});
	return { invitationId, termsId };
}

describe('invitations', () => {
	it('allow one line of offers per company and candidate for all time', async () => {
		const ctx = await setup();
		await sendInvitation(ctx);
		await expectDbError(sendInvitation(ctx), SQLSTATE.uniqueViolation, /invitations_company_candidate/);
	});

	it('refuse terms not in roubles per month, a vacancy without its snapshot and «why you» without points', async () => {
		const ctx = await setup();
		const { invitationId } = await sendInvitation(ctx);
		const version = (overrides: Partial<typeof invitationTerms.$inferInsert>) =>
			database.db.insert(invitationTerms).values({
				invitationId,
				version: 2,
				...offerTermsRow(),
				changes: {},
				salaryMin: 250_000,
				salaryMax: 350_000,
				salaryCurrency: 'RUB',
				salaryPeriod: 'month',
				salaryTaxBase: 'gross',
				responseDueAt: new Date(Date.now() + 3600_000),
				createdByMemberId: ctx.member.id,
				...overrides
			});
		await expectDbError(version({ salaryCurrency: 'USD' }), SQLSTATE.checkViolation, /invitation_terms_salary_rub/);
		await expectDbError(version({ salaryPeriod: 'year' }), SQLSTATE.checkViolation, /invitation_terms_salary_rub/);
		await expectDbError(
			version({ vacancyId: ctx.vacancy.id }),
			SQLSTATE.checkViolation,
			/invitation_terms_vacancy_snapshot/
		);
		await expectDbError(version({ whyYou: [] }), SQLSTATE.checkViolation, /invitation_terms_why_you/);
	});

	it('refuse terms without a full range with a known tax base', async () => {
		const ctx = await setup();
		const { invitationId } = await sendInvitation(ctx);
		await expectDbError(
			database.db.insert(invitationTerms).values({
				invitationId,
				version: 2,
				...offerTermsRow(),
				changes: {},
				salaryMin: 250_000,
				salaryMax: 350_000,
				salaryCurrency: 'RUB',
				salaryPeriod: 'month',
				salaryTaxBase: 'unknown',
				responseDueAt: new Date(Date.now() + 3600_000),
				createdByMemberId: ctx.member.id
			}),
			SQLSTATE.checkViolation,
			/invitation_terms_full_salary/
		);
	});
});

describe('isInvitable', () => {
	it('accepts a published own vacancy with a full range in roubles', async () => {
		const ctx = await setup();
		expect(await loadInvitability(database.db, ctx.vacancy.id)).toEqual({ invitable: true });
	});

	it('refuses an external vacancy, also after an approved claim', async () => {
		const { db } = database;
		const ctx = await setup();
		const external = await createExternalVacancy(db, ctx.taxonomy.id, {
			salaryMin: 200_000,
			salaryMax: 300_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			claimedCompanyId: ctx.company.id
		});
		const applicant = ctx.member.userId;
		if (!applicant) throw new Error('member without user');
		await db.insert(vacancyClaims).values({
			vacancyId: external.id,
			companyId: ctx.company.id,
			requestedByUserId: applicant,
			status: 'approved',
			matchEvidence: {},
			decidedBy: applicant,
			decidedAt: new Date()
		});
		expect(await loadInvitability(db, external.id)).toEqual({ invitable: false, reason: 'external_vacancy' });
	});

	it('refuses a vacancy with a range not in roubles', async () => {
		const ctx = await setup();
		const { db } = database;
		const vacancy = await createOwnVacancy(
			db,
			{ companyId: ctx.company.id, memberId: ctx.member.id, taxonomyVersionId: ctx.taxonomy.id },
			{ salaryCurrency: 'USD' }
		);
		expect(await loadInvitability(db, vacancy.id)).toEqual({ invitable: false, reason: 'incomplete_salary' });
	});

	it('cannot meet an own vacancy without a full range: the database refuses it', async () => {
		const { db } = database;
		const company = await createCompany(db);
		const member = await createMember(db, company.id);
		const taxonomy = await createTaxonomyVersion(db);
		await expectDbError(
			createOwnVacancy(
				db,
				{ companyId: company.id, memberId: member.id, taxonomyVersionId: taxonomy.id },
				{ salaryMax: null }
			),
			SQLSTATE.checkViolation,
			/vacancies_own_fields/
		);
		await expectDbError(
			createOwnVacancy(
				db,
				{ companyId: company.id, memberId: member.id, taxonomyVersionId: taxonomy.id },
				{ salaryTaxBase: 'unknown' }
			),
			SQLSTATE.checkViolation,
			/vacancies_own_fields/
		);
	});

	it('keeps an external vacancy without salary and grade as unknown', async () => {
		const { db } = database;
		const taxonomy = await createTaxonomyVersion(db);
		const external = await createExternalVacancy(db, taxonomy.id);
		expect(external).toMatchObject({ salaryMin: null, salaryMax: null, gradeMin: null, gradeBasis: 'unknown' });
		await expectDbError(
			createExternalVacancy(db, taxonomy.id, { salaryMin: 100_000 }),
			SQLSTATE.checkViolation,
			/vacancies_salary_terms/
		);
	});
});
