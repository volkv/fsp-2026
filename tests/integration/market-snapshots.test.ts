import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	candidateCompanyBlocks,
	consentEvents,
	demoSessions,
	grades,
	marketSnapshots,
	productPolicies,
	salaryReferences,
	taxonomyVersions,
	vacancies,
	vacancyImportRuns,
	vacancyPostings,
	vacancySources
} from '$lib/server/db/schema';
import type { SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type { CatalogViewer } from '$lib/server/matching/visibility';
import type { CategoryKey } from '$lib/server/market/aggregate';
import { loadMarketPolicy } from '$lib/server/market/policy';
import { loadCategoryMarket, positionText, vacancyMarketPosition } from '$lib/server/market/read';
import { computeMarket, storeMarket } from '$lib/server/market/refresh';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createExternalVacancy,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	createUser,
	randomSha256
} from '../helpers/factories';

let database: TestDatabase;
let taxonomyVersionId: string;
let documents: { pd: string; catalog: string };
let employer: { companyId: string; memberId: string; userId: string };

const DAY = 86_400_000;
const NOW = new Date();

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	const taxonomy = await createTaxonomyVersion(db);
	taxonomyVersionId = taxonomy.id;
	await db
		.insert(grades)
		.values(['junior', 'middle', 'senior'].map((key, ordinal) => ({ taxonomyVersionId, key, ordinal, name: key })));
	// The external reference of backend / middle: observed, and a stack premium for Go that the source gives as a median.
	// QA is referenced by the automation role of the source: its test checks automation from Junior on.
	await reference({
		roleKey: 'qa_automation',
		gradeKey: 'junior',
		skillKey: null,
		median: 150_000,
		p25: 120_000,
		p75: 190_000,
		sampleSize: 400,
		method: 'observed_median'
	});
	await reference({
		gradeKey: 'middle',
		skillKey: null,
		median: 220_000,
		p25: 170_000,
		p75: 280_000,
		sampleSize: 900,
		method: 'observed_median'
	});
	await reference({
		gradeKey: 'middle',
		skillKey: 'go',
		median: 242_000,
		p25: null,
		p75: null,
		sampleSize: 120,
		method: 'estimated_stack_adjustment'
	});
	// Published versions are immutable: everything of the version is inserted before.
	await db
		.update(taxonomyVersions)
		.set({ status: 'published', publishedAt: new Date(Date.now() - DAY) })
		.where(eq(taxonomyVersions.id, taxonomyVersionId));
	documents = {
		pd: (await createPublishedDocument(db, 'pd_processing')).id,
		catalog: (await createPublishedDocument(db, 'catalog_visibility')).id
	};
	await db.insert(productPolicies).values([
		{ kind: 'market_policy', version: 1, params: { window_days: 30, min_sample: 3 }, effectiveFrom: new Date(0) },
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 5 }, effectiveFrom: new Date(0) }
	]);
	const company = await createCompany(db);
	const member = await createMember(db, company.id);
	if (!member.userId) throw new Error('member without user');
	employer = { companyId: company.id, memberId: member.id, userId: member.userId };

	await db.insert(vacancySources).values({
		key: 'test_board',
		name: 'Тестовая доска',
		siteUrl: 'https://example.org',
		adapterVersion: '1',
		terms: { status: 'allowed' },
		schedule: {}
	});
});

afterAll(async () => {
	await database.drop();
});

beforeEach(async () => {
	const { db } = database;
	await db.delete(marketSnapshots);
	await db.delete(candidateCompanyBlocks);
	await db.delete(vacancyPostings);
	await db.delete(vacancyImportRuns);
	await db.delete(vacancies);
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

type Salary = { min: number | null; max: number | null; tax_base: 'gross' | 'net' | 'unknown' };

/**
 * A catalog candidate with the category middle of a specialization (backend unless given) and a salary expectation; a
 * clone when a demo session is given.
 */
async function candidate(
	salary: Salary,
	options: { seed?: boolean; specialization?: SpecializationKey; demoSessionId?: string } = {}
) {
	const { db } = database;
	const demoSessionId = options.demoSessionId ?? null;
	const row = await createCandidate(db, {
		userId: (await createUser(db, { demoSessionId })).id,
		demoSessionId,
		visibility: 'catalog',
		profileRevision: 1,
		seedBatchId: options.seed ? 'demo-1' : null,
		preferences: { salary_expectation: { ...salary, currency: 'RUB', period: 'month' } }
	});
	for (const [kind, documentId] of [
		['pd_processing', documents.pd],
		['catalog_visibility', documents.catalog]
	] as const) {
		await db.insert(consentEvents).values({
			subjectCandidateId: row.id,
			kind,
			documentId,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: row.userId,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date(Date.now() - DAY)
		});
	}
	await decide(db, row.id, { specialization: options.specialization ?? 'backend', grade: 'middle' });
	return row;
}

async function ownVacancy(
	min: number,
	max: number,
	taxBase: 'gross' | 'net',
	seed = false,
	company: { companyId: string; memberId: string } = employer
) {
	return createOwnVacancy(
		database.db,
		{ companyId: company.companyId, memberId: company.memberId, taxonomyVersionId },
		{
			roleKey: 'backend',
			gradeMin: 'middle',
			gradeMax: 'middle',
			requiredSkillKeys: ['go'],
			salaryMin: min,
			salaryMax: max,
			salaryTaxBase: taxBase,
			seedBatchId: seed ? 'demo-1' : null
		}
	);
}

/** An external vacancy in search with one posting checked `checkedDaysAgo` days ago. */
async function externalVacancy(min: number, max: number, checkedDaysAgo: number) {
	const { db } = database;
	const vacancy = await createExternalVacancy(db, taxonomyVersionId, {
		roleKey: 'backend',
		gradeMin: 'middle',
		gradeMax: 'middle',
		gradeBasis: 'inferred',
		requiredSkillKeys: ['go'],
		salaryMin: min,
		salaryMax: max,
		salaryCurrency: 'RUB',
		salaryPeriod: 'month',
		salaryTaxBase: 'unknown'
	});
	const [run] = await db
		.insert(vacancyImportRuns)
		.values({
			source: 'test_board',
			adapterVersion: '1',
			mode: 'incremental',
			startedAt: new Date(),
			finishedAt: new Date(),
			status: 'succeeded',
			completeness: 'partial',
			incompleteReason: 'test',
			counts: {}
		})
		.returning();
	if (!run) throw new Error('import run not inserted');
	const checked = new Date(Date.now() - checkedDaysAgo * DAY);
	await db.insert(vacancyPostings).values({
		vacancyId: vacancy.id,
		source: 'test_board',
		externalId: randomSha256().slice(0, 12),
		url: 'https://example.org/v',
		organization: {},
		title: vacancy.title,
		originalTerms: {},
		rawSha256: randomSha256(),
		normalized: {},
		normalizationVersion: '1',
		firstFetchedAt: checked,
		lastFetchedAt: checked,
		lastCheckedAt: checked,
		freshness: 'active',
		dedup: { method: 'exact' },
		lastImportRunId: run.id
	});
	return vacancy;
}

async function reference(values: {
	roleKey?: string;
	gradeKey: string | null;
	skillKey: string | null;
	median: number;
	p25: number | null;
	p75: number | null;
	sampleSize: number;
	method: string;
}) {
	await database.db.insert(salaryReferences).values({
		taxonomyVersionId,
		source: 'habr_career_calculator',
		collectedAt: new Date('2026-09-24T00:00:00Z'),
		currency: 'RUB',
		period: 'month',
		taxBase: 'net',
		geography: 'ru',
		...values,
		roleKey: values.roleKey ?? 'backend'
	});
}

async function refresh() {
	const { db } = database;
	const market = await computeMarket(db, await loadMarketPolicy(db, NOW), NOW);
	await db.transaction((tx) => storeMarket(tx, market.rows));
	return market;
}

const middle: CategoryKey = { specialization: 'backend', grade: 'middle' };

function viewer(demoSessionId: string | null = null): CatalogViewer {
	return {
		viewer: {
			kind: 'member',
			userId: employer.userId,
			memberId: employer.memberId,
			companyId: employer.companyId,
			via: 'session',
			demoSessionId
		},
		company: {
			membershipActive: true,
			companyAdmitted: true,
			hasCardReadPermission: true,
			minorTermsAccepted: false
		}
	};
}

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('category market', () => {
	it('shows three indicators side by side, each with its own sample, window and method', async () => {
		for (const amount of [200_000, 250_000, 300_000, 350_000, 400_000]) {
			await candidate({ min: amount, max: null, tax_base: 'net' });
		}
		await ownVacancy(300_000, 400_000, 'gross');
		await ownVacancy(320_000, 420_000, 'gross');
		await ownVacancy(340_000, 440_000, 'gross');
		const { skippedReferences } = await refresh();

		const market = await loadCategoryMarket(database.db, { category: middle, viewer: null, now: NOW });
		const [expectations] = market.indicators.candidate_expectations;
		expect(expectations).toMatchObject({
			status: 'ok',
			taxBase: 'net',
			method: 'observed_median_from',
			sampleSize: 5,
			median: 300_000,
			provenance: 'live'
		});
		const [ranges] = market.indicators.vacancy_ranges;
		expect(ranges).toMatchObject({ status: 'ok', taxBase: 'gross', sampleSize: 3, median: 370_000 });
		expect(ranges?.window.to).toBe(NOW.toISOString().slice(0, 10));
		expect(market.indicators.external_reference).toEqual([
			expect.objectContaining({ status: 'ok', median: 220_000, sampleSize: 900, estimated: false })
		]);

		// The stack premium is not a category: it is skipped, never stored as the value of the grade or of another key.
		expect(skippedReferences).toBe(1);
		const references = await database.db
			.select({ key: marketSnapshots.categoryKey, method: marketSnapshots.method, median: marketSnapshots.median })
			.from(marketSnapshots)
			.where(eq(marketSnapshots.indicator, 'external_reference'));
		expect(references).toHaveLength(2);
		expect(references.some((row) => row.method === 'estimated_stack_adjustment')).toBe(false);
		// The reference of a specialization is that of its reference role.
		const qa = await loadCategoryMarket(database.db, {
			category: { specialization: 'qa', grade: 'junior' },
			viewer: null,
			now: NOW
		});
		expect(qa.indicators.external_reference).toEqual([
			expect.objectContaining({ status: 'ok', median: 150_000, sampleSize: 400, estimated: false })
		]);
	});

	it('keeps gross, net and an unknown tax base in separate rows', async () => {
		await ownVacancy(300_000, 400_000, 'gross');
		await ownVacancy(300_000, 400_000, 'gross');
		await ownVacancy(300_000, 400_000, 'gross');
		await ownVacancy(100_000, 140_000, 'net');
		await ownVacancy(100_000, 140_000, 'net');
		await ownVacancy(100_000, 140_000, 'net');
		await externalVacancy(900_000, 1_000_000, 2);
		await refresh();

		const { indicators } = await loadCategoryMarket(database.db, { category: middle, viewer: null, now: NOW });
		const byBase = new Map(indicators.vacancy_ranges.map((figure) => [figure.taxBase, figure]));
		expect(byBase.get('gross')).toMatchObject({ status: 'ok', sampleSize: 3, median: 350_000 });
		expect(byBase.get('net')).toMatchObject({ status: 'ok', sampleSize: 3, median: 120_000 });
		expect(byBase.get('unknown')).toMatchObject({ status: 'insufficient_data', sampleSize: 1 });
		expect(indicators.vacancy_ranges).toHaveLength(3);
	});

	it('does not count an external vacancy not confirmed within the window', async () => {
		await externalVacancy(200_000, 300_000, 1);
		await externalVacancy(200_000, 300_000, 45);
		await refresh();
		const { indicators } = await loadCategoryMarket(database.db, { category: middle, viewer: null, now: NOW });
		expect(indicators.vacancy_ranges).toEqual([expect.objectContaining({ taxBase: 'unknown', sampleSize: 1 })]);
	});

	it('shows no number below the threshold and hides a small candidate count', async () => {
		await candidate({ min: 200_000, max: 300_000, tax_base: 'gross' }, { specialization: 'frontend' });
		await candidate({ min: 210_000, max: 310_000, tax_base: 'gross' }, { specialization: 'frontend' });
		await refresh();
		const { indicators } = await loadCategoryMarket(database.db, {
			category: { specialization: 'frontend' },
			viewer: null,
			now: NOW
		});
		expect(indicators.candidate_expectations).toEqual([
			expect.objectContaining({ status: 'insufficient_data', sampleSize: null, threshold: 5 })
		]);
		expect(indicators.candidate_expectations[0]).not.toHaveProperty('median');
		expect(indicators.vacancy_ranges).toEqual([]);
		expect(indicators.external_reference).toEqual([]);
	});

	it('counts for a company only the candidates it sees in its catalog', async () => {
		const rows = [];
		for (const amount of [200_000, 220_000, 240_000, 260_000, 280_000]) {
			rows.push(await candidate({ min: amount, max: null, tax_base: 'gross' }, { specialization: 'mobile' }));
		}
		const category: CategoryKey = { specialization: 'mobile' };
		const seen = await loadCategoryMarket(database.db, { category, viewer: viewer(), now: NOW });
		expect(seen.indicators.candidate_expectations).toEqual([
			expect.objectContaining({ status: 'ok', sampleSize: 5, median: 240_000 })
		]);

		const blocked = rows[0];
		if (!blocked) throw new Error('no candidate');
		await database.db.insert(candidateCompanyBlocks).values({ candidateId: blocked.id, companyId: employer.companyId });
		const afterBlock = await loadCategoryMarket(database.db, { category, viewer: viewer(), now: NOW });
		expect(afterBlock.indicators.candidate_expectations).toEqual([
			expect.objectContaining({ status: 'insufficient_data', sampleSize: null })
		]);
	});

	it('never counts demonstration records in the market and labels their own rows', async () => {
		await ownVacancy(300_000, 400_000, 'gross');
		await ownVacancy(300_000, 400_000, 'gross');
		await ownVacancy(300_000, 400_000, 'gross');
		for (let i = 0; i < 3; i++) await ownVacancy(2_000_000, 3_000_000, 'gross', true);
		await refresh();

		const { indicators } = await loadCategoryMarket(database.db, { category: middle, viewer: null, now: NOW });
		const live = indicators.vacancy_ranges.filter((figure) => figure.provenance === 'live');
		expect(live).toEqual([expect.objectContaining({ status: 'ok', sampleSize: 3, median: 350_000 })]);
		expect(indicators.vacancy_ranges.filter((figure) => figure.provenance === 'synthetic')).toEqual([
			expect.objectContaining({ sampleSize: 3, median: 2_500_000 })
		]);
		expect(indicators.vacancy_ranges.some((figure) => figure.provenance === 'mixed')).toBe(false);
	});

	it('does not count the clones of demo sessions or the vacancies of their companies', async () => {
		const { db } = database;
		const [session] = await db
			.insert(demoSessions)
			.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + DAY) })
			.returning();
		if (!session) throw new Error('demo session not inserted');
		const cloneCompany = await createCompany(db, { demoSessionId: session.id });
		const cloneMember = await createMember(db, cloneCompany.id, {
			userId: (await createUser(db, { demoSessionId: session.id })).id
		});
		for (const amount of [200_000, 220_000, 240_000, 260_000, 280_000]) {
			await candidate(
				{ min: amount, max: null, tax_base: 'gross' },
				{ specialization: 'qa', demoSessionId: session.id }
			);
		}
		await ownVacancy(300_000, 400_000, 'gross');
		await ownVacancy(300_000, 400_000, 'gross');
		await ownVacancy(300_000, 400_000, 'gross');
		for (let i = 0; i < 3; i++) {
			await ownVacancy(2_000_000, 3_000_000, 'gross', false, { companyId: cloneCompany.id, memberId: cloneMember.id });
		}
		await refresh();

		const { indicators } = await loadCategoryMarket(database.db, { category: middle, viewer: null, now: NOW });
		expect(indicators.vacancy_ranges).toEqual([expect.objectContaining({ sampleSize: 3, median: 350_000 })]);
		const qa: CategoryKey = { specialization: 'qa' };
		const stored = await loadCategoryMarket(database.db, { category: qa, viewer: null, now: NOW });
		expect(stored.indicators.candidate_expectations).toEqual([]);
		// A company inside the session sees the clones in its catalog, but the market does not count them either.
		const inSession = await loadCategoryMarket(database.db, { category: qa, viewer: viewer(session.id), now: NOW });
		expect(inSession.indicators.candidate_expectations).toEqual([]);
	});

	it('places a vacancy range against the market only in the same tax base', async () => {
		await ownVacancy(300_000, 400_000, 'gross');
		await ownVacancy(300_000, 400_000, 'gross');
		await ownVacancy(300_000, 400_000, 'gross');
		await refresh();

		const base = { roleKey: 'backend', gradeMin: 'middle', gradeMax: 'middle' };
		const gross = await vacancyMarketPosition(
			database.db,
			{ ...base, salary: { min: 250_000, max: 324_000, currency: 'RUB', period: 'month', taxBase: 'gross' } },
			NOW
		);
		if (gross.status !== 'evaluated') throw new Error('no position');
		const [ranges] = gross.positions;
		expect(ranges).toMatchObject({
			indicator: 'vacancy_ranges',
			status: 'compared',
			percentToMedian: -18,
			categoryKey: { specialization: 'backend', grade: 'middle' }
		});
		if (!ranges) throw new Error('no position');
		expect(positionText(ranges, 'gross')).toBe('Середина вилки на 18 % ниже медианы вилок вакансий');

		const net = await vacancyMarketPosition(
			database.db,
			{ ...base, salary: { min: 250_000, max: 324_000, currency: 'RUB', period: 'month', taxBase: 'net' } },
			NOW
		);
		if (net.status !== 'evaluated') throw new Error('no position');
		const [netRanges] = net.positions;
		expect(netRanges).toMatchObject({ status: 'not_comparable', reason: 'tax_base' });
		if (!netRanges) throw new Error('no position');
		expect(positionText(netRanges, 'net')).toBe(
			'вилки вакансий: несравнимо — вилка указана на руки, показатель — до вычета НДФЛ'
		);
	});

	it('places no vacancy whose role is of no specialization', async () => {
		const salary = { min: 250_000, max: 324_000, currency: 'RUB', period: 'month', taxBase: 'gross' } as const;
		for (const roleKey of ['gamedev', null]) {
			expect(
				await vacancyMarketPosition(database.db, { roleKey, gradeMin: 'middle', gradeMax: 'middle', salary }, NOW)
			).toEqual({ status: 'no_specialization' });
		}
	});
});
