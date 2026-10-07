import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invitations, invitationTerms } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { loadInvitability } from '$lib/server/vacancies/invitable';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { expectDbError, SQLSTATE } from '../helpers/errors';
import {
	createCandidate,
	createCompany,
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
	it('accepts a published vacancy with a full range in roubles', async () => {
		const ctx = await setup();
		expect(await loadInvitability(database.db, ctx.vacancy.id)).toEqual({ invitable: true });
	});

	it('refuses a vacancy that is not published', async () => {
		const ctx = await setup();
		const { db } = database;
		const vacancy = await createOwnVacancy(
			db,
			{ companyId: ctx.company.id, memberId: ctx.member.id, taxonomyVersionId: ctx.taxonomy.id },
			{ status: 'paused' }
		);
		expect(await loadInvitability(db, vacancy.id)).toEqual({ invitable: false, reason: 'not_published' });
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

	it('cannot meet a vacancy without a full range: the database refuses it', async () => {
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
			/vacancies_full_salary/
		);
		await expectDbError(
			createOwnVacancy(
				db,
				{ companyId: company.id, memberId: member.id, taxonomyVersionId: taxonomy.id },
				{ salaryTaxBase: 'unknown' }
			),
			SQLSTATE.checkViolation,
			/vacancies_full_salary/
		);
	});
});
