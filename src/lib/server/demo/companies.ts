// Companies of the demo stand, created the way employers and the FSP operator create them: the owner registers a draft
// and submits it, the operator approves it; recruiters join by the owner's invitation; the operator opens the
// partnership of a competition; the owner of the scenario's main employer accepts the terms of work with minors.
import { and, eq, isNull, ne } from 'drizzle-orm';
import { submitForVerification, decideVerification } from '$lib/server/companies/verification';
import { acceptMinorTerms, createCompanyDraft, minorTermsAcceptance } from '$lib/server/companies/profile';
import { acceptMemberInvite, inviteMember } from '$lib/server/companies/members';
import { openPartnership } from '$lib/server/companies/partnerships';
import { loadCompanyProfile, updateCompanyProfile } from '$lib/server/companies/public-profile';
import { companies, companyMembers, companyVerifications, competitionPartnerships } from '$lib/server/db/schema';
import { DemoBatchConflict, documentOf, ensureUser, metaOf, subjectOf, type SeedContext } from './accounts';
import type { CompanyPlan } from './generate';
import { findCompetition, type World } from './world';

export interface SeededCompany {
	key: string;
	id: string;
	displayName: string;
	status: 'verified' | 'submitted';
	/** Members by their key in the plan. */
	members: Map<string, { userId: string; memberId: string; role: 'owner' | 'recruiter' }>;
	partnershipId: string | null;
	competitionRef: string | null;
}

async function companyByInn(ctx: SeedContext, inn: string) {
	const [row] = await ctx.services.db
		.select({ id: companies.id, status: companies.status, batch: companies.seedBatchId })
		.from(companies)
		// The clones of the demo sessions carry the same number: the seed works the original, outside sessions.
		.where(and(eq(companies.inn, inn), ne(companies.status, 'rejected'), isNull(companies.demoSessionId)));
	if (row && row.batch !== ctx.batch) {
		throw new DemoBatchConflict(`company ИНН ${inn} belongs to another batch: reset the demo stand first`);
	}
	return row ?? null;
}

async function memberOf(ctx: SeedContext, companyId: string, userId: string) {
	const [row] = await ctx.services.db
		.select({ id: companyMembers.id, role: companyMembers.role })
		.from(companyMembers)
		.where(
			and(
				eq(companyMembers.companyId, companyId),
				eq(companyMembers.userId, userId),
				eq(companyMembers.status, 'active')
			)
		);
	return row ?? null;
}

export async function ensureCompany(
	ctx: SeedContext,
	plan: CompanyPlan,
	operatorUserId: string,
	world: World
): Promise<SeededCompany> {
	const { db } = ctx.services;
	const ownerPlan = plan.members.find((m) => m.role === 'owner');
	if (!ownerPlan) throw new Error(`company ${plan.key} has no owner in the seed data`);
	const ownerId = await ensureUser(ctx, { email: ownerPlan.email, displayName: ownerPlan.displayName });
	const operator = { subject: await subjectOf(ctx, operatorUserId), meta: metaOf(ctx, operatorUserId) };

	let company = await companyByInn(ctx, plan.inn);
	if (!company) {
		const created = await createCompanyDraft(
			ctx.companies,
			{ subject: await subjectOf(ctx, ownerId), meta: metaOf(ctx, ownerId) },
			{
				inn: plan.inn,
				displayName: plan.displayName,
				legalName: plan.legalName,
				employerTermsId: documentOf(ctx, 'employer_terms').id
			}
		);
		await db.update(companies).set({ seedBatchId: ctx.batch }).where(eq(companies.id, created.companyId));
		company = { id: created.companyId, status: 'draft', batch: ctx.batch };
	}
	const companyId = company.id;
	const owner = { subject: await subjectOf(ctx, ownerId), meta: metaOf(ctx, ownerId) };

	if (company.status === 'draft') {
		// The corporate address of the owner is checked by the operator without a document (domain 5.2).
		await submitForVerification(ctx.companies, owner, companyId, {
			authorityMethod: 'corporate_email_domain',
			authorityEvidenceFileId: null
		});
		company = { ...company, status: 'submitted' };
	}
	if (plan.status === 'verified' && company.status === 'submitted') {
		const [open] = await db
			.select({ id: companyVerifications.id })
			.from(companyVerifications)
			.where(and(eq(companyVerifications.companyId, companyId), isNull(companyVerifications.decision)));
		if (!open) throw new Error(`company ${plan.key} is submitted without an open verification request`);
		await decideVerification(ctx.companies, operator, open.id, { kind: 'approve' });
		company = { ...company, status: 'verified' };
	}
	if (company.status !== plan.status) {
		throw new Error(`company ${plan.key} is ${company.status}, the seed expects ${plan.status}`);
	}

	const members = new Map<string, { userId: string; memberId: string; role: 'owner' | 'recruiter' }>();
	for (const member of plan.members) {
		const userId =
			member.role === 'owner'
				? ownerId
				: await ensureUser(ctx, { email: member.email, displayName: member.displayName });
		let row = await memberOf(ctx, companyId, userId);
		if (!row) {
			await inviteMember(ctx.companies, { subject: await subjectOf(ctx, ownerId), meta: owner.meta }, companyId, {
				email: member.email,
				role: member.role
			});
			await acceptMemberInvite(
				ctx.companies,
				{ subject: await subjectOf(ctx, userId), meta: metaOf(ctx, userId) },
				ctx.letters.tokenFor(member.email)
			);
			row = await memberOf(ctx, companyId, userId);
			if (!row) throw new Error(`${member.email} did not join company ${plan.key}`);
		}
		members.set(member.key, { userId, memberId: row.id, role: row.role });
	}

	if (!(await loadCompanyProfile(db, companyId)).complete) {
		// The owner fills in the profile an offer needs (domain 5.1, 13.5): what the company does and its line of business.
		await updateCompanyProfile(ctx.companies, owner, companyId, {
			description: `${plan.displayName} — ИТ-компания демонстрационного стенда: разрабатывает и поддерживает собственные цифровые продукты, нанимает инженеров через платформу.`,
			activity: 'Разработка программного обеспечения'
		});
	}

	if (plan.minorTerms && !(await minorTermsAcceptance(db, companyId, ctx.now()))) {
		// The owner accepts the current terms of work with minors on the company profile.
		await acceptMinorTerms(
			ctx.companies,
			{ subject: await subjectOf(ctx, ownerId), meta: owner.meta },
			companyId,
			documentOf(ctx, 'minor_employment_terms').id
		);
	}

	let partnershipId: string | null = null;
	let competitionRef: string | null = null;
	if (plan.partnership) {
		competitionRef = findCompetition(world, plan.partnership.competition).id;
		const [active] = await db
			.select({ id: competitionPartnerships.id })
			.from(competitionPartnerships)
			.where(
				and(
					eq(competitionPartnerships.companyId, companyId),
					eq(competitionPartnerships.competitionRef, competitionRef),
					eq(competitionPartnerships.status, 'active')
				)
			);
		partnershipId =
			active?.id ??
			(
				await openPartnership(ctx.companies, operator, {
					companyId,
					competitionRef,
					kind: plan.partnership.kind,
					validFrom: ctx.now().toISOString().slice(0, 10),
					validTo: null,
					basis: plan.partnership.basis
				})
			).partnershipId;
	}

	return {
		key: plan.key,
		id: companyId,
		displayName: plan.displayName,
		status: plan.status,
		members,
		partnershipId,
		competitionRef
	};
}
