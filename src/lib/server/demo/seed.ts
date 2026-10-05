// The demo seed (docs/domain.md, sections 7.1, 12, 13.10, 21, 23.3): accounts of every role, companies of the scenario
// and of the background, verified and under review, candidates on real FSP competitions of the simulator's dataset and
// with synthetic resumes, each through the survey, the declared grade and the seeded tests of the specializations with a
// released bank, the categories their decisions give, the needs of the companies with shortlists and offers in every
// status, own and external vacancies, and the states the scenario starts from. Data flow through the product: FSP sync →
// facts → claims → evidence, resume parse → extraction, survey → declaration → attempt → decision → category, need →
// shortlist → offer → acceptance → disclosure → hiring. Every record the seed creates carries the batch id. The seed is
// deterministic in what it creates and idempotent: its batch id is a hash of its inputs (the released banks included),
// a finished batch is recorded in the journal and not seeded again, and a stopped one continues where it stopped.
import { createHash } from 'node:crypto';
import { and, count, eq, inArray, lte, max, sql } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import { currentDocument, type CurrentDocument } from '$lib/server/auth/documents';
import { openSpecializations } from '$lib/server/assessments/bank-store';
import type { SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { createEvidenceHandler } from '$lib/server/evidence/job';
import { companyRegistryLookup } from '$lib/server/companies/registry-check';
import { registryNotConfigured } from '$lib/server/companies/registry';
import type { DocumentKind } from '$lib/server/consent/kinds';
import {
	auditEvents,
	bankReleases,
	candidateCategories,
	candidateSurveys,
	candidates,
	disclosures,
	evidenceRuns,
	companies,
	documentExtractions,
	gradeDecisions,
	hiringNeeds,
	hiringProcesses,
	invitations,
	legalDocuments,
	matchScores,
	productPolicies,
	resumeDocuments,
	shortlists,
	skills,
	sourceFacts,
	users,
	vacancies,
	vacancyPostings
} from '$lib/server/db/schema';
import { createFspSyncHandler } from '$lib/server/fsp/sync';
import { handlerRegistry } from '$lib/server/jobs/handler';
import { enqueueJob } from '$lib/server/jobs/queue';
import type { JobType } from '$lib/server/jobs/registry';
import { marketRefresh } from '$lib/server/market/refresh';
import { createMatchRefreshHandler } from '$lib/server/matching/refresh';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { modelAdapter } from '$lib/server/ml';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import { fail } from '$lib/server/ml/result';
import { createResumeExtractHandler } from '$lib/server/resumes/extract-job';
import { createResumeParseHandler } from '$lib/server/resumes/parse-job';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';
import { createVacancyNormalizeHandler } from '$lib/server/vacancies/normalize-job';
import { ensureStaffRole, ensureUser, DemoBatchConflict, type SeedContext } from './accounts';
import { ensureAssessment, type AssessmentState } from './assessments';
import { ensureCandidate, inPool, type SeededCandidate } from './candidates';
import { castOriginals, castRoles, markCastOriginals } from './cast';
import { ensureCompany, type SeededCompany } from './companies';
import { readSeedData, type SeedData } from './data';
import {
	athletePlan,
	companyPlans,
	externalPostings,
	heroPlan,
	minorPlan,
	needPlans,
	ownVacancyPlans,
	Random,
	resumePlan,
	type CandidatePlan
} from './generate';
import { drainJobs } from './queue';
import {
	ensureRepresentative,
	grantPartnerPool,
	revokeSomeConsents,
	showMinorInCatalog,
	stageFunnel,
	stageContacts,
	stageScenario,
	type FunnelSummary
} from './scenes';
import { LetterBox, type DemoServices } from './services';
import { ensureOwnVacancies, importExternalVacancies } from './vacancies';
import { demoWorld, eligibleAthletes, heroAthlete, minorAthletes, type World } from './world';
import { syntheticName } from '../../../../services/fsp-mock/src/seed/names.ts';

/** Bump when the seed code changes what it creates from the same inputs: a new version is a new batch. */
const SEED_VERSION = 6;

/** Share of FSP athletes among the synthetic candidates; the rest have a resume and no FSP history. */
const FSP_SHARE = 0.9;
/** Share of own vacancies of verified companies among all vacancies; the rest come from the synthetic sources. */
const OWN_SHARE = 0.4;
/** Share of background candidates who revoked the catalog consent. */
const REVOKED_SHARE = 0.03;

const DOCUMENT_KINDS: readonly DocumentKind[] = [
	'user_agreement',
	'employer_terms',
	'pd_processing',
	'catalog_visibility',
	'fsp_import',
	'contact_disclosure',
	'minor_employment_terms',
	'partner_pool'
];

const POLICY_KINDS = [
	'invitation_policy',
	'hiring_policy',
	'minor_policy',
	'market_policy',
	'catalog_policy',
	'matching_policy'
] as const;

/** Types of the jobs the seed runs to fill the derived data. */
const CHAIN: readonly JobType[] = [
	'fsp.sync',
	'resume.parse',
	'resume.extract',
	'evidence.compute',
	'match.refresh',
	'vacancy.normalize',
	'company.registry_lookup',
	'market.refresh'
];

class DemoPrerequisiteMissing extends Error {
	override name = 'DemoPrerequisiteMissing';
}

/** Matching without the models: the matches of the demo data are reproducible and do not wait for a model. */
const MODELS_OFF: MatchingModels = {
	embed: () => Promise.resolve(fail('disabled', 'embed: off for the demo seed', { reason: 'demo_seed' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: off for the demo seed', { reason: 'demo_seed' }))
};

async function candidateOfExtraction(services: DemoServices, extractionId: string): Promise<string> {
	const [row] = await services.db
		.select({ candidateId: resumeDocuments.candidateId })
		.from(documentExtractions)
		.innerJoin(resumeDocuments, eq(resumeDocuments.id, documentExtractions.resumeDocumentId))
		.where(eq(documentExtractions.id, extractionId));
	if (!row) throw new Error(`document extraction ${extractionId} is missing`);
	return row.candidateId;
}

/**
 * `extract` of the seed's resume jobs. The heroes' resumes go to the product's model adapter: the model reads them
 * when it is configured, switched on and answers; otherwise the job takes the product's rules path and the result
 * names the adapter's reason. The background candidates' resumes — hundreds of them — are read by the rules without a
 * model call, which would add minutes of the model per hundred resumes to the seed; their results name that reason.
 */
function seedExtract(services: DemoServices, heroCandidateIds: ReadonlySet<string>): Pick<ModelAdapter, 'extract'> {
	return {
		extract: async (request, lexicon, options) => {
			if (heroCandidateIds.has(await candidateOfExtraction(services, request.input.id))) {
				return modelAdapter().extract(request, lexicon, options);
			}
			return fail('disabled', 'extract: background resumes of the demo seed are read by the rules', {
				reason: 'demo_seed_background'
			});
		}
	};
}

function seedHandlers(services: DemoServices, heroCandidateIds: ReadonlySet<string>) {
	return handlerRegistry([
		createFspSyncHandler(() => services.fsp),
		createEvidenceHandler(),
		createMatchRefreshHandler(() => MODELS_OFF),
		createResumeParseHandler({ store: () => services.store, parser: () => services.parser }),
		createResumeExtractHandler({
			adapter: () => seedExtract(services, heroCandidateIds),
			crypto: () => services.crypto,
			now: () => new Date()
		}),
		createVacancyNormalizeHandler(),
		// The companies are fictional: a registry would not find them.
		companyRegistryLookup(() => registryNotConfigured),
		marketRefresh
	]);
}

interface SeedCounts {
	users: number;
	candidates: number;
	candidatesWithFsp: number;
	sourceFacts: number;
	publishedEvidenceRuns: number;
	companies: number;
	surveys: number;
	/** Decisions of the seeded tests by outcome: `confirmed`, `confident` (of the confirmed), `not_confirmed`, `undetermined`. */
	decisions: Record<string, number>;
	categories: number;
	needs: number;
	shortlists: number;
	/** Offers by status. */
	invitations: Record<string, number>;
	disclosures: number;
	hiringProcesses: number;
	vacancies: number;
	ownVacancies: number;
	externalPostings: number;
	matchScores: number;
}

/** What the seed did with the tests: specializations with a released bank, and candidates left without the survey. */
export interface SeedTests {
	open: SpecializationKey[];
	/** Candidates whose specialization has no released bank, by specialization: no survey, no attempts. */
	closed: Record<string, number>;
	/** Candidates of the plan whose roles no test checks. */
	untested: number;
	/** Needs of the background whose specialization has no released bank: not written. */
	closedNeeds: number;
	/** Needs of the scenario (`company.need`) waiting for a released bank, with their offers. */
	closedScenes: string[];
}

export interface SeedSummary {
	status: 'seeded' | 'already_seeded';
	batch: string;
	counts: SeedCounts;
	/** `null` for a batch seeded earlier. */
	tests: SeedTests | null;
	durationMs: number;
}

/** The released banks the batch is seeded against: a bank released later is a new batch, with tests of its own. */
export async function releasedBanks(services: DemoServices): Promise<string[]> {
	const rows = await services.db
		.select({ id: bankReleases.id })
		.from(bankReleases)
		.where(eq(bankReleases.status, 'released'));
	return rows.map((row) => row.id).sort();
}

/** The batch of these inputs: seed data, world, sizes, released banks and the seed code version. */
export function batchId(data: SeedData, settings: DemoServices['settings'], releases: readonly string[]): string {
	const hash = createHash('sha256')
		.update(
			JSON.stringify({
				version: SEED_VERSION,
				data: data.sha256,
				world: settings.world,
				candidates: settings.candidates,
				vacancies: settings.vacancies,
				releases
			})
		)
		.digest('hex');
	return `demo-${hash.slice(0, 12)}`;
}

async function seededBatches(services: DemoServices): Promise<string[]> {
	const rows = await services.db.execute<{ batch: string }>(sql`
		select seed_batch_id as batch from users where seed_batch_id is not null
		union select seed_batch_id from companies where seed_batch_id is not null
		union select seed_batch_id from candidates where seed_batch_id is not null
		union select seed_batch_id from vacancies where seed_batch_id is not null`);
	return rows.map((row) => row.batch);
}

export async function isSeeded(services: DemoServices, batch: string): Promise<boolean> {
	const [row] = await services.db
		.select({ n: count() })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'demo.seeded'), sql`${auditEvents.details}->>'batch' = ${batch}`));
	return (row?.n ?? 0) > 0;
}

async function seedCounts(services: DemoServices, batch: string): Promise<SeedCounts> {
	const { db } = services;
	const one = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;
	const grouped = async (query: Promise<{ key: string; n: number }[]>) =>
		Object.fromEntries((await query).map((row) => [row.key, row.n]));
	const decisions = await grouped(
		db
			.select({ key: gradeDecisions.outcome, n: sql<number>`count(*)::int` })
			.from(gradeDecisions)
			.where(eq(gradeDecisions.status, 'valid'))
			.groupBy(gradeDecisions.outcome)
	);
	decisions.confident = await one(
		db
			.select({ n: count() })
			.from(gradeDecisions)
			.where(and(eq(gradeDecisions.status, 'valid'), eq(gradeDecisions.confident, true)))
	);
	return {
		users: await one(db.select({ n: count() }).from(users).where(eq(users.seedBatchId, batch))),
		candidates: await one(db.select({ n: count() }).from(candidates).where(eq(candidates.seedBatchId, batch))),
		candidatesWithFsp: await one(
			db
				.select({ n: sql<number>`count(distinct ${sourceFacts.candidateId})::int` })
				.from(sourceFacts)
				.where(eq(sourceFacts.source, 'fsp'))
		),
		sourceFacts: await one(db.select({ n: count() }).from(sourceFacts)),
		publishedEvidenceRuns: await one(
			db.select({ n: count() }).from(evidenceRuns).where(eq(evidenceRuns.status, 'published'))
		),
		companies: await one(db.select({ n: count() }).from(companies).where(eq(companies.seedBatchId, batch))),
		surveys: await one(db.select({ n: count() }).from(candidateSurveys)),
		decisions,
		categories: await one(
			db.select({ n: count() }).from(candidateCategories).where(eq(candidateCategories.status, 'active'))
		),
		needs: await one(db.select({ n: count() }).from(hiringNeeds)),
		shortlists: await one(db.select({ n: count() }).from(shortlists)),
		invitations: await grouped(
			db
				.select({ key: invitations.status, n: sql<number>`count(*)::int` })
				.from(invitations)
				.groupBy(invitations.status)
		),
		disclosures: await one(db.select({ n: count() }).from(disclosures)),
		hiringProcesses: await one(db.select({ n: count() }).from(hiringProcesses)),
		vacancies: await one(db.select({ n: count() }).from(vacancies).where(eq(vacancies.seedBatchId, batch))),
		ownVacancies: await one(
			db
				.select({ n: count() })
				.from(vacancies)
				.where(and(eq(vacancies.seedBatchId, batch), eq(vacancies.origin, 'own')))
		),
		externalPostings: await one(
			db.select({ n: count() }).from(vacancyPostings).where(eq(vacancyPostings.seedBatchId, batch))
		),
		matchScores: await one(db.select({ n: count() }).from(matchScores))
	};
}

async function prerequisites(services: DemoServices, now: Date) {
	const { db } = services;
	const missing: string[] = [];
	const taxonomy = await latestPublishedVersion(db);
	if (!taxonomy) missing.push('published taxonomy (scripts/seed-taxonomy.ts)');
	const documents = new Map<DocumentKind, CurrentDocument>();
	for (const kind of DOCUMENT_KINDS) {
		const document = await currentDocument(db, kind, now);
		if (document?.available) documents.set(kind, document);
		else missing.push(`legal document ${kind} (scripts/seed-legal.ts)`);
	}
	for (const kind of POLICY_KINDS) {
		const [policy] = await db
			.select({ id: productPolicies.id })
			.from(productPolicies)
			.where(and(eq(productPolicies.kind, kind), lte(productPolicies.effectiveFrom, now)))
			.limit(1);
		if (!policy) missing.push(`product policy ${kind} (scripts/seed-policies.ts)`);
	}
	if (!taxonomy || missing.length > 0) {
		throw new DemoPrerequisiteMissing(`the demo seed needs: ${missing.join(', ')}`);
	}
	return { taxonomyVersionId: taxonomy.id, documents };
}

/** How long before the seed the people of the stand joined it, when the legal documents they accepted allow. */
const JOINED_BEFORE_MS = 45 * 60_000;

/**
 * When the people of the stand joined: `JOINED_BEFORE_MS` before the seed, or when the last of the legal documents they
 * accept was published, if that was later — nobody accepts a document before it exists. Their accounts and consents
 * date from then, so what they did afterwards (an action half an hour before the seed) comes after the consent.
 */
async function joiningTime(
	services: DemoServices,
	documents: ReadonlyMap<DocumentKind, CurrentDocument>,
	now: Date
): Promise<Date> {
	const [row] = await services.db
		.select({ published: max(legalDocuments.publishedAt) })
		.from(legalDocuments)
		.where(
			inArray(
				legalDocuments.id,
				[...documents.values()].map((document) => document.id)
			)
		);
	if (!row?.published) throw new Error('the legal documents of the demo seed have no publication time');
	// The database keeps microseconds and a date milliseconds: the next millisecond is surely after the publication.
	return new Date(Math.max(row.published.getTime() + 1, now.getTime() - JOINED_BEFORE_MS));
}

/**
 * The running simulator must serve the same dataset the seed generates: otherwise the linked athletes would not exist
 * there or would have other achievements.
 */
async function checkSimulator(services: DemoServices, world: World): Promise<void> {
	const response = await fetch(`${services.fspMockOrigin}/mock/accounts`, {
		headers: { authorization: `Bearer ${services.settings.fspMockControlToken}` }
	});
	if (!response.ok) throw new DemoPrerequisiteMissing(`the simulator's accounts answered ${response.status}`);
	const body = (await response.json()) as { items: { athlete: { sourceVersion: string } | null }[] };
	const versions = body.items.flatMap((item) => (item.athlete ? [item.athlete.sourceVersion] : []));
	const dataset = versions[0]?.split('.')[0];
	if (dataset !== world.datasetId) {
		throw new DemoPrerequisiteMissing(
			`the simulator serves dataset ${dataset ?? 'none'}, the seed generates ${world.datasetId}: ` +
				'FSP_MOCK_SEED and FSP_MOCK_ATHLETES must be the same for the simulator and the application'
		);
	}
}

async function skillNames(services: DemoServices, taxonomyVersionId: string): Promise<Map<string, string>> {
	const rows = await services.db
		.select({ key: skills.key, name: skills.name })
		.from(skills)
		.where(eq(skills.taxonomyVersionId, taxonomyVersionId));
	return new Map(rows.map((row) => [row.key, row.name]));
}

async function ensureStaff(ctx: SeedContext, data: SeedData): Promise<{ operatorUserId: string }> {
	const admin = data.demo.staff.find((s) => s.role === 'admin');
	const operator = data.demo.staff.find((s) => s.role === 'operator');
	if (!admin || !operator) throw new Error('seeds/demo.json names no administrator or no operator');
	const adminId = await ensureUser(ctx, { email: admin.email, displayName: admin.displayName });
	await ensureStaffRole(ctx, adminId, 'admin', null);
	const operatorUserId = await ensureUser(ctx, { email: operator.email, displayName: operator.displayName });
	await ensureStaffRole(ctx, operatorUserId, 'operator', adminId);
	return { operatorUserId };
}

export async function seedDemo(services: DemoServices): Promise<SeedSummary> {
	const started = Date.now();
	const { db, settings, log } = services;
	const now = () => new Date();
	const data = await readSeedData(services.seedsDir);
	const batch = batchId(data, settings, await releasedBanks(services));
	if (await isSeeded(services, batch)) {
		return { status: 'already_seeded', batch, counts: await seedCounts(services, batch), tests: null, durationMs: 0 };
	}
	const foreign = (await seededBatches(services)).filter((b) => b !== batch);
	if (foreign.length > 0) {
		throw new DemoBatchConflict(
			`the stand holds demo batch ${foreign.join(', ')}, the seed data now give ${batch}: reset the demo stand first`
		);
	}
	const { taxonomyVersionId, documents } = await prerequisites(services, now());
	const joinedAt = await joiningTime(services, documents, now());
	const world = demoWorld(settings.world);
	await checkSimulator(services, world);
	const open = await openSpecializations(db);

	const letters = new LetterBox();
	const ctx: SeedContext = {
		services,
		batch,
		now,
		meta: { requestId: `demo-seed:${batch}`, ip: null, userAgent: 'demo-seed' },
		letters,
		auth: { db, redis: services.redis, crypto: services.crypto, mailer: letters, appOrigin: services.appOrigin, now },
		companies: {
			db,
			crypto: services.crypto,
			mailer: letters,
			registry: registryNotConfigured,
			appOrigin: services.appOrigin,
			now
		},
		invitations: { db, crypto: services.crypto, now },
		documents,
		joinedAt,
		taxonomyVersionId
	};
	const names = await skillNames(services, taxonomyVersionId);

	log.info('demo seed: accounts and companies', { batch, open_specializations: [...open].join(',') });
	const { operatorUserId } = await ensureStaff(ctx, data);
	const plans = companyPlans(data, batch);
	const companyList: SeededCompany[] = [];
	for (const plan of plans) companyList.push(await ensureCompany(ctx, plan, operatorUserId, world));
	const companyMap = new Map(companyList.map((c) => [c.key, c]));

	log.info('demo seed: candidates', { batch });
	const heroPlans = data.demo.candidates.map((hero) =>
		heroPlan(hero, hero.athlete === undefined ? null : heroAthlete(world, hero.athlete), data)
	);
	const background = settings.candidates - heroPlans.length - 1;
	const athletes = eligibleAthletes(world, now()).slice(0, Math.max(0, Math.round(background * FSP_SHARE)));
	const minor = minorAthletes(world, now())[0];
	if (!minor) throw new Error('the simulator dataset has no minor of the product discipline');
	const backgroundPlans: CandidatePlan[] = [
		...athletes.map((athlete) => athletePlan(athlete, data, batch, now())),
		...Array.from({ length: Math.max(0, background - athletes.length) }, (_, i) =>
			resumePlan(i + 1, data, batch, now(), names)
		)
	];
	const heroes = new Map<string, SeededCandidate>();
	for (const plan of heroPlans) heroes.set(plan.key, await ensureCandidate(ctx, plan));
	const handlers = seedHandlers(services, new Set([...heroes.values()].map((hero) => hero.candidateId)));
	const drain = (label: string, types: readonly JobType[] = CHAIN) =>
		drainJobs(db, handlers, types, { since: new Date(started), log, label });
	// The whole cast is seeded now: its profiles and companies are the originals the demo sessions clone.
	await markCastOriginals(db, await castOriginals(db, services.crypto, castRoles(data)));
	const minorPlanned = minorPlan(minor, batch);
	const minorCandidate = await ensureCandidate(ctx, minorPlanned);
	const seededBackground = await inPool(backgroundPlans, 4, (plan) => ensureCandidate(ctx, plan));

	for (const hero of data.demo.candidates) {
		const seeded = heroes.get(hero.key);
		if (hero.representative && seeded) {
			// The representative confirmed the address; the operator has not checked the authority yet.
			await ensureRepresentative(ctx, seeded, hero.representative, { verify: false, operatorUserId });
		}
	}
	const parent = syntheticName(new Random(`${batch}:representative`));
	await ensureRepresentative(
		ctx,
		minorCandidate,
		{
			fullName: `${parent.lastName} ${parent.firstName} ${parent.middleName ?? ''}`.trim(),
			email: `representative.${minor.fspId.slice(0, 8)}@candidates.example`,
			relation: 'parent'
		},
		{ verify: true, operatorUserId }
	);
	await showMinorInCatalog(ctx, minorCandidate);
	// Sources first: the evidence calculation each candidate's settings enqueued is still waiting when the facts arrive,
	// so the facts join it and each profile is computed once.
	await drain('candidate sources', ['fsp.sync', 'resume.parse', 'resume.extract']);
	await drain('candidates');

	log.info('demo seed: surveys and tests', { batch });
	// The hint of a declaration reads the evidence just computed; the categories the decisions give move the profiles.
	const tests: SeedTests = { open: [...open].sort(), closed: {}, untested: 0, closedNeeds: 0, closedScenes: [] };
	const pairs: [SeededCandidate, CandidatePlan][] = [
		...heroPlans.map((plan): [SeededCandidate, CandidatePlan] => [required(heroes.get(plan.key)), plan]),
		...backgroundPlans.map((plan, i): [SeededCandidate, CandidatePlan] => [required(seededBackground[i]), plan])
	];
	const states = await inPool(pairs, 4, ([candidate, plan]) => ensureAssessment(ctx, candidate, plan, open));
	for (const [index, state] of states.entries()) countTest(tests, state, pairs[index]?.[1]);
	await drain('categories');

	log.info('demo seed: vacancies', { batch });
	const ownCount = Math.round(settings.vacancies * OWN_SHARE);
	const ownVacancies = await ensureOwnVacancies(ctx, ownVacancyPlans(data, plans, ownCount, batch, names), companyMap);
	const claimCompany = plans.find((p) => p.status === 'submitted');
	await importExternalVacancies(
		ctx,
		externalPostings(
			data,
			settings.vacancies - ownCount,
			batch,
			new Date(`${world.asOf}T09:00:00Z`),
			claimCompany?.displayName ?? '',
			names
		),
		log
	);
	// Normalized first: an external vacancy is matched once, at the revision its normalization gives.
	await drain('vacancy normalization', ['vacancy.normalize']);
	await drain('vacancies');

	log.info('demo seed: needs, shortlists and offers', { batch });
	const cast = { companies: companyMap, heroes, background: seededBackground, operatorUserId };
	tests.closedScenes = await stageScenario(ctx, cast, data, open);
	const gateway = ownVacancies.find((vacancy) => vacancy.scenarioKey === 'go_payments');
	if (!gateway) throw new Error('the scenario needs the vacancy go_payments');
	if (!(await stageContacts(ctx, cast, gateway.id, open))) tests.closedScenes.push('contacts');
	const funnel: FunnelSummary = await stageFunnel(
		ctx,
		cast,
		needPlans(data, plans, batch),
		open,
		Math.min(150, Math.max(10, Math.round(settings.candidates / 8))),
		batch
	);
	tests.closedNeeds = funnel.closedNeeds;
	await revokeSomeConsents(ctx, seededBackground, REVOKED_SHARE, batch);
	const athleteOf = new Map(backgroundPlans.map((plan) => [plan.key, plan.athlete]));
	for (const company of companyList) {
		const competitionRef = company.competitionRef;
		if (competitionRef === null) continue;
		const finalists = seededBackground.filter((candidate) => {
			const athlete = athleteOf.get(candidate.key);
			const record = athlete ? world.athletes.get(athlete.fspId) : undefined;
			return record?.results.some((r) => r.competitionId === competitionRef) ?? false;
		});
		await grantPartnerPool(ctx, competitionRef, finalists, batch);
	}
	await db.transaction((tx) =>
		enqueueJob(
			tx,
			'market.refresh',
			{ period: now().toISOString().slice(0, 10) },
			{ inputVersion: batch, createdBy: { kind: 'system', id: 'demo-seed' } }
		)
	);
	await drain('scenario and market');

	const counts = await seedCounts(services, batch);
	await recordAuditEvent(db, {
		action: 'demo.seeded',
		outcome: 'success',
		actor: { kind: 'system' },
		requestId: ctx.meta.requestId,
		details: {
			batch,
			candidates: counts.candidates,
			vacancies: counts.vacancies,
			tests_open: tests.open,
			tests_closed: tests.closed,
			tests_untested: tests.untested,
			tests_closed_needs: tests.closedNeeds,
			tests_closed_scenes: tests.closedScenes
		}
	});
	return { status: 'seeded', batch, counts, tests, durationMs: Date.now() - started };
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('a seeded candidate of the plan is missing');
	return value;
}

function countTest(tests: SeedTests, state: AssessmentState | undefined, plan: CandidatePlan | undefined): void {
	if (state === 'none') tests.untested++;
	else if (state === 'closed' && plan?.assessment) {
		const key = plan.assessment.specialization;
		tests.closed[key] = (tests.closed[key] ?? 0) + 1;
	}
}
