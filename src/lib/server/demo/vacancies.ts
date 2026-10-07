// Vacancies of the demo stand, written and published by a member of the company through the vacancies module. An
// internship from 14–16 is saved like any vacancy for minors: the vacancies module refers it to the company's
// acceptance of the terms of work with minors in effect, and refuses it without one.
import { asc, eq } from 'drizzle-orm';
import { vacancies } from '$lib/server/db/schema';
import { createOwnVacancy, publishOwnVacancy, type VacancyAuthor } from '$lib/server/vacancies/own';
import type { SeedContext } from './accounts';
import type { SeededCompany } from './companies';
import type { OwnVacancyPlan } from './generate';

export interface SeededVacancy {
	id: string;
	companyKey: string;
	scenarioKey: string | null;
	roleKey: string;
}

function authorOf(ctx: SeedContext, company: SeededCompany): VacancyAuthor {
	const member =
		[...company.members.values()].find((m) => m.role === 'recruiter') ??
		[...company.members.values()].find((m) => m.role === 'owner');
	if (!member) throw new Error(`company ${company.key} has no members`);
	return {
		memberId: member.memberId,
		companyId: company.id,
		audit: { kind: 'user', userId: member.userId, companyId: company.id },
		requestId: ctx.meta.requestId
	};
}

/**
 * Own vacancies by plan. A company's vacancies are created in the order of the plans, so a repeated seed skips the
 * ones the company already has and publishes a draft a stopped seed left behind.
 */
export async function ensureOwnVacancies(
	ctx: SeedContext,
	plans: readonly OwnVacancyPlan[],
	companies: ReadonlyMap<string, SeededCompany>
): Promise<SeededVacancy[]> {
	const { db } = ctx.services;
	const deps = { db, now: ctx.now };
	const seeded: SeededVacancy[] = [];
	const byCompany = new Map<string, OwnVacancyPlan[]>();
	for (const plan of plans) byCompany.set(plan.company, [...(byCompany.get(plan.company) ?? []), plan]);

	for (const [companyKey, companyPlans] of byCompany) {
		const company = companies.get(companyKey);
		if (!company) throw new Error(`vacancy plans name an unknown company ${companyKey}`);
		const author = authorOf(ctx, company);
		const existing = await db
			.select({ id: vacancies.id, status: vacancies.status, roleKey: vacancies.roleKey })
			.from(vacancies)
			.where(eq(vacancies.companyId, company.id))
			.orderBy(asc(vacancies.id));
		for (const [index, plan] of companyPlans.entries()) {
			let row = existing[index];
			if (!row) {
				const created = await createOwnVacancy(deps, author, plan.input);
				await db.update(vacancies).set({ seedBatchId: ctx.batch }).where(eq(vacancies.id, created.id));
				row = { id: created.id, status: created.status, roleKey: created.roleKey };
			}
			if (row.status === 'draft') {
				const outcome = await publishOwnVacancy(deps, author, row.id, { confirmWarnings: true });
				if (outcome.status !== 'published') {
					throw new Error(`vacancy «${plan.input.title}» went to moderation: its text check blocked it`);
				}
			}
			seeded.push({
				id: row.id,
				companyKey,
				scenarioKey: plan.scenarioKey,
				roleKey: row.roleKey
			});
		}
	}
	return seeded;
}
