// Vacancies of the demo stand. Own vacancies are written and published by a member of the company through the
// vacancies module; external ones come from two synthetic sources through the product's import job — postings,
// clustering of duplicates, normalization — exactly as a real source would bring them. An internship from 14–16 is
// saved like any vacancy for minors: the vacancies module refers it to the company's acceptance of the terms of work
// with minors in effect, and refuses it without one.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { vacancies, vacancyPostings, vacancySources } from '$lib/server/db/schema';
import type { JobLogger } from '$lib/server/jobs/log';
import { createOwnVacancy, publishOwnVacancy, type VacancyAuthor } from '$lib/server/vacancies/own';
import { createVacanciesImportHandler } from '$lib/server/vacancies/import-job';
import { sourceOk, type SourcePosting, type VacancySource } from '$lib/server/vacancies/sources/types';
import type { SeedContext } from './accounts';
import type { SeededCompany } from './companies';
import { DEMO_SOURCES, type OwnVacancyPlan } from './generate';
import { runJobInline } from './queue';

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
			.where(and(eq(vacancies.companyId, company.id), eq(vacancies.origin, 'own')))
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
				roleKey: row.roleKey ?? plan.input.roleKey
			});
		}
	}
	return seeded;
}

/** An adapter of a synthetic source over a fixed listing: one page, a posting found by its id. */
function listingSource(key: string, postings: readonly SourcePosting[]): VacancySource {
	const byId = new Map(postings.map((p) => [p.externalId, p]));
	return {
		source: key,
		adapterVersion: 'demo-listing/1',
		// A feed: absence from it proves nothing, so a repeated seed never takes postings off.
		listing: 'recent_window',
		// A curated listing of IT postings: the import does not filter it by the taxonomy.
		itScope: 'source',
		list: () =>
			Promise.resolve(sourceOk({ items: [...postings], nextCursor: null, sourceVersion: null, declaredTotal: null })),
		get: (externalId) => Promise.resolve(sourceOk(byId.get(externalId) ?? { gone: true as const }))
	};
}

/**
 * Registers the synthetic sources and imports their listings with the product's import job. A source is enabled only
 * inside the transaction that captures its import and switched off right after it: the schedule never imports it, and
 * freshness checks skip it (a real adapter does not exist for it).
 */
export async function importExternalVacancies(
	ctx: SeedContext,
	postings: ReadonlyMap<string, SourcePosting[]>,
	log: JobLogger
): Promise<void> {
	const { db, appOrigin } = ctx.services;
	const today = ctx.now().toISOString().slice(0, 10);
	for (const source of DEMO_SOURCES) {
		const terms = {
			status: 'allowed',
			checked_at: today,
			url: appOrigin,
			store_description: source.storeDescription,
			attribution: source.attribution
		};
		// A year between runs: the synthetic listing is imported by the seed only.
		const schedule = { full_every_hours: 8760, incremental_every_hours: null, check_after_hours: 8760 };
		await db
			.insert(vacancySources)
			.values({
				key: source.key,
				name: source.name,
				siteUrl: appOrigin,
				adapterVersion: 'demo-listing/1',
				terms,
				schedule,
				enabled: false
			})
			.onConflictDoUpdate({ target: vacancySources.key, set: { name: source.name, terms, schedule } });

		const listing = postings.get(source.key) ?? [];
		const handler = createVacanciesImportHandler(() => ({
			source: (key) => (key === source.key ? listingSource(source.key, listing) : null),
			now: ctx.now
		}));
		try {
			await runJobInline(
				db,
				handler,
				{ source: source.key, mode: 'full' },
				{
					inputVersion: `demo:${ctx.batch}`,
					log,
					before: async (tx) => {
						await tx.update(vacancySources).set({ enabled: true }).where(eq(vacancySources.key, source.key));
					}
				}
			);
		} finally {
			await db.update(vacancySources).set({ enabled: false }).where(eq(vacancySources.key, source.key));
		}
	}
	const keys = DEMO_SOURCES.map((s) => s.key);
	await db.update(vacancyPostings).set({ seedBatchId: ctx.batch }).where(inArray(vacancyPostings.source, keys));
	await db
		.update(vacancies)
		.set({ seedBatchId: ctx.batch })
		.where(
			and(
				eq(vacancies.origin, 'external'),
				sql`${vacancies.id} in (select ${vacancyPostings.vacancyId} from ${vacancyPostings} where ${inArray(vacancyPostings.source, keys)})`
			)
		);
}
