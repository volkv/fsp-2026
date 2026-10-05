import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	candidates,
	categorizationRulesets,
	evidenceRuns,
	consentEvents,
	demoSessions,
	documentAcceptances,
	embeddingSpaces,
	embeddings,
	fspLevelAssignments,
	grades,
	jobs,
	legalRepresentatives,
	matchRulesets,
	matchScores,
	productPolicies,
	representations,
	roles,
	searchSettings,
	skillAliases,
	skillInferences,
	skills,
	sourceFacts,
	vacancies
} from '$lib/server/db/schema';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { findInCatalog } from '$lib/server/employer/card';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { recommendVacancies } from '$lib/server/matching/recommendations';
import { createMatchRefreshHandler } from '$lib/server/matching/refresh';
import { matchRulesetParamsSchema } from '$lib/server/matching/params';
import type { MatchRuleset } from '$lib/server/matching/ruleset';
import {
	compareCandidates,
	RankingCache,
	rankingWeight,
	searchCandidates,
	type CandidateSearchQuery
} from '$lib/server/matching/search';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { loadCatalogViewer } from '$lib/server/matching/visibility';
import { encodeComponents, loadMatchStoragePolicy, storedComponent } from '$lib/server/matching/storage';
import { fail, ok } from '$lib/server/ml/result';
import { loadPoolCounter } from '$lib/server/vacancies/pool';
import { matchView } from '$lib/components/employer/model';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
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
let ruleset: MatchRuleset;
let categorizationRulesetId: string;
let documents: Record<'pd' | 'catalog' | 'minorTerms', string>;
const SPACE = 'test-space/3';
/** `matching_policy.store_threshold` of these tests: pairs below it are not stored. */
const STORE_THRESHOLD = 0.3;

const DAY = 86_400_000;
const yearsAgo = (years: number) => {
	const date = new Date();
	date.setUTCFullYear(date.getUTCFullYear() - years);
	date.setUTCMonth(0, 15);
	return date.toISOString().slice(0, 10);
};

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	const taxonomy = await createTaxonomyVersion(db);
	taxonomyVersionId = taxonomy.id;
	await db.insert(grades).values(
		['intern', 'junior', 'middle', 'senior', 'lead', 'principal'].map((key, ordinal) => ({
			taxonomyVersionId,
			key,
			ordinal,
			name: key
		}))
	);
	await db.insert(skills).values([
		{ taxonomyVersionId, key: 'go', kind: 'language', name: 'Go' },
		{ taxonomyVersionId, key: 'postgresql', kind: 'database', name: 'PostgreSQL' },
		{ taxonomyVersionId, key: 'python', kind: 'language', name: 'Python' }
	]);
	await db.insert(skillAliases).values([{ taxonomyVersionId, aliasNormalized: 'golang', skillKey: 'go' }]);
	await db.insert(roles).values({
		taxonomyVersionId,
		key: 'backend',
		family: 'development',
		nameRu: 'Бэкенд-разработчик',
		coreSkillGroups: [],
		typicalSkills: ['go'],
		hhRoleId: [],
		habrSpec: [],
		profStandard: []
	});
	// Published like a release: names of the version in force are what a search document reads.
	await db.execute(
		sql`update taxonomy_versions set status = 'published', published_at = now() where id = ${taxonomyVersionId}`
	);
	// The rule set the product ships, bound to this hand-made taxonomy version.
	const params = matchRulesetParamsSchema.parse(shippedMatchRuleset.params);
	const [stored] = await db
		.insert(matchRulesets)
		.values({ version: shippedMatchRuleset.version, taxonomyVersionId, params })
		.returning();
	if (!stored) throw new Error('match rule set not inserted');
	ruleset = { id: stored.id, version: stored.version, params };
	const [categorizationRuleset] = await db
		.insert(categorizationRulesets)
		.values({ version: 1, taxonomyVersionId, params: {} })
		.returning();
	if (!categorizationRuleset) throw new Error('categorization rule set not inserted');
	categorizationRulesetId = categorizationRuleset.id;

	documents = {
		pd: (await createPublishedDocument(db, 'pd_processing')).id,
		catalog: (await createPublishedDocument(db, 'catalog_visibility')).id,
		minorTerms: (await createPublishedDocument(db, 'minor_employment_terms')).id
	};
	await db.insert(productPolicies).values([
		{
			kind: 'minor_policy',
			version: 1,
			params: { enabled: true, authority_methods: ['in_person'] },
			effectiveFrom: new Date(Date.now() - DAY)
		},
		{
			kind: 'matching_policy',
			version: 1,
			params: { store_threshold: STORE_THRESHOLD },
			effectiveFrom: new Date(Date.now() - DAY)
		}
	]);

	await db.insert(embeddingSpaces).values({
		id: SPACE,
		modelName: 'test-embedder',
		modelRevision: 'r1',
		dimension: 3,
		queryPrefix: '',
		documentPrefix: '',
		pooling: 'mean',
		normalization: 'l2',
		maxInputTokens: 512,
		chunkingVersion: 'v1',
		status: 'active',
		activatedAt: new Date()
	});
	await db.update(searchSettings).set({ activeEmbeddingSpaceId: SPACE });
});

afterAll(async () => {
	await database.drop();
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

/** A verified company with its owner; a clone company of a demo session when one is given. */
async function employer(options: { minorTerms?: boolean; demoSessionId?: string } = {}) {
	const { db } = database;
	const demoSessionId = options.demoSessionId ?? null;
	const company = await createCompany(db, { demoSessionId });
	const member = await createMember(db, company.id, { userId: (await createUser(db, { demoSessionId })).id });
	if (!member.userId) throw new Error('member without user');
	if (options.minorTerms) {
		await db.insert(documentAcceptances).values({
			documentId: documents.minorTerms,
			userId: member.userId,
			companyId: company.id,
			acceptedAt: new Date()
		});
	}
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
	return { company, member, subject };
}

/** The candidate's own session. */
function candidateSubject(person: { id: string; userId: string }): AccessSubject {
	return {
		userId: person.userId,
		via: 'session',
		candidate: { id: person.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

async function grant(
	candidateId: string,
	userId: string,
	kind: 'pd_processing' | 'catalog_visibility',
	extra: { representationId?: string; action?: 'grant' | 'revoke'; at?: Date } = {}
) {
	await database.db.insert(consentEvents).values({
		subjectCandidateId: candidateId,
		kind,
		documentId: kind === 'pd_processing' ? documents.pd : documents.catalog,
		action: extra.action ?? 'grant',
		...(extra.representationId
			? { signerKind: 'representative' as const, representationId: extra.representationId }
			: { signerKind: 'subject' as const, signerUserId: userId }),
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: extra.at ?? new Date(Date.now() - DAY)
	});
}

interface CandidateSetup {
	birthYearsAgo?: number;
	preferences?: Record<string, unknown>;
	desiredRoleKeys?: string[];
	/** Skills of a published evidence run; absent — no evidence run at all. */
	skills?: { key: string; band: 'weak' | 'moderate' | 'strong'; attestation: 'direct' | 'derived' | 'claimed' }[];
	/** The category a confirmed test decision gave; absent — the category is not confirmed. */
	category?: { specialization: SpecializationKey; grade: GradeKey };
	fspLevel?: { discipline: string; level: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' };
	vector?: number[];
	visibility?: 'hidden' | 'catalog';
	catalogConsent?: boolean;
	/** A clone of this demo session. */
	demoSessionId?: string;
}

async function candidate(setup: CandidateSetup = {}) {
	const { db } = database;
	const demoSessionId = setup.demoSessionId ?? null;
	const row = await createCandidate(db, {
		userId: (await createUser(db, { demoSessionId })).id,
		demoSessionId,
		birthDate: yearsAgo(setup.birthYearsAgo ?? 28),
		visibility: setup.visibility ?? 'catalog',
		preferences: setup.preferences ?? {},
		desiredRoleKeys: setup.desiredRoleKeys ?? [],
		// The decision of the test moves the revision to 1 itself.
		profileRevision: setup.category ? 0 : 1
	});
	if (setup.category) {
		await decide(db, row.id, setup.category);
		// The fixture leaves no jobs: each test runs the refreshes it means.
		await db
			.delete(jobs)
			.where(
				and(eq(jobs.status, 'queued'), inArray(jobs.dedupKey, [`evidence:${row.id}`, `match:candidate:${row.id}`]))
			);
	}
	await grant(row.id, row.userId, 'pd_processing');
	if (setup.catalogConsent !== false) await grant(row.id, row.userId, 'catalog_visibility');

	const [fact] = await db
		.insert(sourceFacts)
		.values({
			candidateId: row.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:result:${randomSha256().slice(0, 12)}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'operator_confirmed',
			payload: {},
			payloadSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			status: 'active'
		})
		.returning();
	if (!fact) throw new Error('fact not inserted');

	let runId: string | null = null;
	if (setup.skills) {
		const [run] = await db
			.insert(evidenceRuns)
			.values({
				candidateId: row.id,
				inputRevision: 1,
				inputSnapshotSha256: randomSha256(),
				inputRefs: { facts: [fact.id], claims: [] },
				taxonomyVersionId,
				rulesetId: categorizationRulesetId,
				asOf: new Date(),
				computedAt: new Date(),
				experienceSummary: {},
				status: 'published'
			})
			.returning();
		if (!run) throw new Error('run not inserted');
		runId = run.id;
		if (setup.skills.length) {
			await db.insert(skillInferences).values(
				setup.skills.map((skill) => ({
					runId: run.id,
					candidateId: row.id,
					skillKey: skill.key,
					strength: skill.band === 'strong' ? '0.800' : skill.band === 'moderate' ? '0.500' : '0.200',
					strengthBand: skill.band,
					attestation: skill.attestation,
					badgeTrust: skill.attestation === 'direct' ? ('fsp_verified' as const) : null,
					contributions: [{ fact_id: fact.id, attestation: skill.attestation }]
				}))
			);
		}
		if (setup.fspLevel) {
			await db.insert(fspLevelAssignments).values({
				runId: run.id,
				discipline: setup.fspLevel.discipline,
				level: setup.fspLevel.level,
				basisFactIds: [fact.id]
			});
		}
	}
	if (setup.vector) {
		await db.insert(embeddings).values({
			ownerType: 'candidate_section',
			ownerId: row.id,
			section: 'skills',
			inputSha256: randomSha256(),
			inputVersion: '1',
			spaceId: SPACE,
			vector: setup.vector
		});
	}
	return { ...row, factId: fact.id, runId };
}

/** What the withdrawal of evidence does in its transaction (domain 17.3): the fact out, revision and floor up. */
async function withdraw(candidateId: string, factId: string) {
	await database.db.transaction(async (tx) => {
		await tx.update(sourceFacts).set({ status: 'withdrawn' }).where(eq(sourceFacts.id, factId));
		await tx
			.update(candidates)
			.set({
				profileRevision: sql`${candidates.profileRevision} + 1`,
				evidenceFloorRevision: sql`${candidates.profileRevision} + 1`
			})
			.where(eq(candidates.id, candidateId));
	});
}

async function vacancyVector(vacancyId: string, vector: number[]) {
	await database.db.insert(embeddings).values({
		ownerType: 'vacancy',
		ownerId: vacancyId,
		inputSha256: randomSha256(),
		inputVersion: '1',
		spaceId: SPACE,
		vector
	});
}

/**
 * What the fake reranker answers, as the adapter does: `off` — switched off; `cooling` — its breaker is open; `failing`
 * — on, but its runtime times out.
 */
type FakeReranker = 'on' | 'off' | 'failing' | 'cooling';

function fakeModels(options: { embed?: boolean; rerank?: FakeReranker } = {}): MatchingModels & {
	reranker: FakeReranker;
	rerankCalls: number;
	rerankRequests: Parameters<MatchingModels['rerank']>[0][];
} {
	const models = {
		reranker: options.rerank ?? 'on',
		/** Requests with documents: a request without them only asks what the reranker would answer. */
		rerankCalls: 0,
		rerankRequests: [] as Parameters<MatchingModels['rerank']>[0][],
		embed: (request: Parameters<MatchingModels['embed']>[0]) =>
			Promise.resolve(
				options.embed === false
					? fail('disabled', 'embed: switched off', { reason: 'switched_off' })
					: ok({
							spaceId: request.spaceId,
							vectors: request.inputs.map((input) => ({ id: input.id, vector: [1, 0, 0] })),
							latencyMs: 1
						})
			),
		rerank: (request: Parameters<MatchingModels['rerank']>[0]) => {
			if (request.documents.length > 0) {
				models.rerankCalls++;
				models.rerankRequests.push(request);
			}
			switch (models.reranker) {
				case 'off':
					return Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' }));
				case 'cooling':
					return Promise.resolve(fail('unavailable', 'rerank: not called', { cause: 'cooling_down' }));
				case 'failing':
					if (request.documents.length > 0) return Promise.resolve(fail('timeout', 'rerank: deadline passed'));
			}
			return Promise.resolve(
				ok({
					model: { modelId: 'test-reranker' },
					scores: request.documents.map((document) => ({ id: document.id, score: 0.9 })),
					latencyMs: 1
				})
			);
		}
	};
	return models;
}

function deps(models: MatchingModels = fakeModels()): MatchingDeps {
	return {
		db: database.db,
		models,
		pseudonym: (candidateId, companyId) => `${candidateId}@${companyId}`,
		now: () => new Date(),
		testResults: GRADE_DECISION_RESULTS
	};
}

async function search(subject: AccessSubject, query: CandidateSearchQuery, models?: MatchingModels) {
	return searchCandidates(deps(models), subject, { limit: 100, ...query });
}

const ids = (result: { items: { candidateId: string }[] }) => result.items.map((item) => item.candidateId);

async function ownVacancy(companyId: string, memberId: string, overrides: Partial<typeof vacancies.$inferInsert> = {}) {
	return createOwnVacancy(database.db, { companyId, memberId, taxonomyVersionId }, overrides);
}

// --- Catalog search -------------------------------------------------------------------------------------------------

describe('catalog search: filters and visibility', () => {
	it('filters by category, FSP level, format and region, and finds a candidate without a category by its facet', async () => {
		const { subject } = await employer();
		const categorized = await candidate({
			skills: [{ key: 'go', band: 'strong', attestation: 'direct' }],
			category: { specialization: 'backend', grade: 'middle' },
			fspLevel: { discipline: 'algorithms', level: 'L4' },
			preferences: { work_formats: ['remote'], region_code: 'RU-MOW' }
		});
		const uncategorized = await candidate({ desiredRoleKeys: ['backend'], preferences: { work_formats: ['office'] } });

		const backend = ids(await search(subject, { filters: { specializations: ['backend'] } }));
		expect(backend).toContain(categorized.id);
		expect(backend).not.toContain(uncategorized.id);
		expect(ids(await search(subject, { filters: { specializations: ['qa'] } }))).not.toContain(categorized.id);
		// The confirmed stack is the skills of the passed blocks of the test (SQL among them), not the evidence skills.
		expect(ids(await search(subject, { filters: { confirmedSkillKeys: ['sql'] } }))).toContain(categorized.id);
		expect(ids(await search(subject, { filters: { confirmedSkillKeys: ['go'] } }))).not.toContain(categorized.id);
		expect(
			ids(await search(subject, { filters: { fspLevel: { discipline: 'algorithms', minLevel: 'L3' } } }))
		).toContain(categorized.id);
		expect(
			ids(await search(subject, { filters: { fspLevel: { discipline: 'algorithms', minLevel: 'L5' } } }))
		).not.toContain(categorized.id);
		const remote = ids(await search(subject, { filters: { workFormats: ['remote'], regionCodes: ['RU-MOW'] } }));
		expect(remote).toContain(categorized.id);
		expect(remote).not.toContain(uncategorized.id);

		const facet = ids(await search(subject, { filters: { uncategorized: true } }));
		expect(facet).toContain(uncategorized.id);
		expect(facet).not.toContain(categorized.id);
		// Also by words, without any category: desired role, with Russian morphology.
		expect(ids(await search(subject, { text: 'бэкенд разработчики' }, fakeModels({ embed: false })))).toContain(
			uncategorized.id
		);
	});

	it('finds a candidate without a category only without category filters, marked and after an equal one', async () => {
		const { subject } = await employer();
		const skills = [{ key: 'go', band: 'strong' as const, attestation: 'direct' as const }];
		const middle = await candidate({ skills, category: { specialization: 'backend', grade: 'middle' } });
		const junior = await candidate({ skills, category: { specialization: 'backend', grade: 'junior' } });
		const none = await candidate({ skills });

		const byGrade = ids(await search(subject, { filters: { grades: ['middle'] } }));
		expect(byGrade).toContain(middle.id);
		expect(byGrade).not.toContain(junior.id);
		expect(byGrade).not.toContain(none.id);
		// One category meets the specialization and the grade at once.
		const pair = ids(await search(subject, { filters: { specializations: ['backend'], grades: ['junior'] } }));
		expect(pair).toContain(junior.id);
		expect(pair).not.toContain(middle.id);
		await expect(search(subject, { filters: { uncategorized: true, grades: ['middle'] } })).rejects.toMatchObject({
			code: 'validation_failed'
		});

		// The whole base: everybody, the one without a category marked and, at an equal order, after those with one.
		const all = await search(subject, {});
		const order = ids(all);
		expect(all.items.find((i) => i.candidateId === none.id)?.categoryConfirmed).toBe(false);
		expect(all.items.find((i) => i.candidateId === middle.id)?.categoryConfirmed).toBe(true);
		expect(order.indexOf(none.id)).toBeGreaterThan(order.indexOf(middle.id));
		expect(order.indexOf(none.id)).toBeGreaterThan(order.indexOf(junior.id));
	});

	it('hides a candidate whose catalog consent was revoked', async () => {
		const { subject } = await employer();
		const shown = await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }] });
		const revoked = await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }] });
		await grant(revoked.id, revoked.userId, 'catalog_visibility', { action: 'revoke', at: new Date() });
		const never = await candidate({
			skills: [{ key: 'go', band: 'strong', attestation: 'direct' }],
			catalogConsent: false
		});

		const found = ids(await search(subject, {}));
		expect(found).toContain(shown.id);
		expect(found).not.toContain(revoked.id);
		expect(found).not.toContain(never.id);
	});

	it('shows a minor only in the context of a suitable vacancy of the viewing company', async () => {
		const { db } = database;
		const own = await employer({ minorTerms: true });
		const other = await employer();
		const [acceptance] = await db
			.select({ id: documentAcceptances.id })
			.from(documentAcceptances)
			.where(eq(documentAcceptances.companyId, own.company.id));
		if (!acceptance) throw new Error('acceptance not inserted');
		const internship = await ownVacancy(own.company.id, own.member.id, {
			title: 'Стажёр-разработчик',
			gradeMin: 'intern',
			gradeMax: 'junior',
			minAge: 16,
			minorTermsAcceptanceId: acceptance.id
		});
		const adultsOnly = await ownVacancy(other.company.id, other.member.id);

		const minor = await candidate({
			birthYearsAgo: 17,
			skills: [{ key: 'go', band: 'moderate', attestation: 'direct' }]
		});
		const [representative] = await db
			.insert(legalRepresentatives)
			.values({ fullNameEnc: randomBytes(32), emailEnc: randomBytes(32), emailHmac: randomSha256() })
			.returning();
		if (!representative) throw new Error('representative not inserted');
		const [representation] = await db
			.insert(representations)
			.values({
				candidateId: minor.id,
				representativeId: representative.id,
				relation: 'parent',
				status: 'authority_verified',
				invitedAt: new Date(Date.now() - 2 * DAY),
				contactConfirmedAt: new Date(Date.now() - 2 * DAY)
			})
			.returning();
		if (!representation) throw new Error('representation not inserted');
		await grant(minor.id, minor.userId, 'pd_processing', { representationId: representation.id });
		await grant(minor.id, minor.userId, 'catalog_visibility', { representationId: representation.id });

		expect(ids(await search(own.subject, { vacancyId: internship.id }))).toContain(minor.id);
		// Without a vacancy, in another company, or for a vacancy without `min_age`: not shown.
		expect(ids(await search(own.subject, {}))).not.toContain(minor.id);
		expect(ids(await search(other.subject, {}))).not.toContain(minor.id);
		expect(ids(await search(other.subject, { vacancyId: adultsOnly.id }))).not.toContain(minor.id);
		// A vacancy of another company cannot be used as a context at all.
		await expect(search(other.subject, { vacancyId: internship.id })).rejects.toMatchObject({ code: 'not_found' });
		// A vacancy that is no longer published removes the minor from the company's results (domain 22, #31).
		await db.update(vacancies).set({ status: 'paused' }).where(eq(vacancies.id, internship.id));
		expect(ids(await search(own.subject, { vacancyId: internship.id }))).not.toContain(minor.id);
	});

	it('counts the acceptance of the terms of work with minors only while no newer version asks to accept again', async () => {
		const { db } = database;
		const accepted = await employer({ minorTerms: true });
		const minorTermsAccepted = async (subject: AccessSubject, at: Date) =>
			(await loadCatalogViewer(db, subject, at))?.company.minorTermsAccepted;
		expect(await minorTermsAccepted(accepted.subject, new Date())).toBe(true);
		expect(await minorTermsAccepted((await employer()).subject, new Date())).toBe(false);
		// A new version that asks to accept again, published tomorrow: from then on the old acceptance is not enough.
		await createPublishedDocument(db, 'minor_employment_terms', {
			requiresReconsent: true,
			publishedAt: new Date(Date.now() + DAY)
		});
		expect(await minorTermsAccepted(accepted.subject, new Date())).toBe(true);
		expect(await minorTermsAccepted(accepted.subject, new Date(Date.now() + 2 * DAY))).toBe(false);
	});

	it('opens the catalog to a company without a check and refuses a suspended or rejected one', async () => {
		const { subject } = await employer();
		const membership = subject.membership;
		if (!membership) throw new Error('employer without membership');
		await expect(
			search({ ...subject, membership: { ...membership, companyStatus: 'submitted' } }, {})
		).resolves.toBeDefined();
		for (const companyStatus of ['suspended', 'rejected'] as const) {
			await expect(search({ ...subject, membership: { ...membership, companyStatus } }, {})).rejects.toMatchObject({
				code: 'forbidden'
			});
		}
	});

	it('pages with a cursor bound to its query', async () => {
		const { subject } = await employer();
		for (let i = 0; i < 3; i++) await candidate({ skills: [{ key: 'python', band: 'weak', attestation: 'claimed' }] });
		const first = await searchCandidates(deps(), subject, { limit: 2 });
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();
		const second = await searchCandidates(deps(), subject, { limit: 2, cursor: first.nextCursor ?? '' });
		expect(ids(second).some((id) => ids(first).includes(id))).toBe(false);
		await expect(
			searchCandidates(deps(), subject, { limit: 2, cursor: first.nextCursor ?? '', text: 'go' })
		).rejects.toMatchObject({ code: 'validation_failed' });
	});
});

describe('catalog search: match with a vacancy', () => {
	it('ranks by matchScore with semantic and reranker components and explains without internal fact ids', async () => {
		const { subject, company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go', 'postgresql'] });
		await vacancyVector(vacancy.id, [1, 0, 0]);
		const strong = await candidate({
			skills: [
				{ key: 'go', band: 'strong', attestation: 'direct' },
				{ key: 'postgresql', band: 'moderate', attestation: 'claimed' }
			],
			category: { specialization: 'backend', grade: 'middle' },
			vector: [1, 0, 0]
		});
		const weak = await candidate({
			skills: [{ key: 'python', band: 'strong', attestation: 'direct' }],
			vector: [0, 1, 0]
		});

		const models = fakeModels();
		const result = await search(subject, { vacancyId: vacancy.id }, models);
		expect(result.mode).toMatchObject({
			searchMode: 'hybrid',
			embeddingSpaceId: SPACE,
			reranker: { status: 'used' }
		});
		expect(models.rerankCalls).toBe(1);
		// Without a query no document is built for the words; the reranker still reads the catalog document.
		const sent = models.rerankRequests[0]?.documents.find((document) => document.id === strong.id);
		expect(sent?.text).toContain('postgresql');
		const order = ids(result);
		expect(order.indexOf(strong.id)).toBeLessThan(order.indexOf(weak.id));
		const top = result.items.find((item) => item.candidateId === strong.id);
		expect(top?.match?.components.semantic).toMatchObject({ status: 'computed', details: { space_id: SPACE } });
		expect(top?.match?.components.reranker).toMatchObject({ status: 'computed', value: 0.9 });
		expect(top?.match?.explanation.matches).toContainEqual({
			kind: 'skill',
			requirement: 'required',
			skill_key: 'go',
			band: 'strong',
			attestation: 'direct',
			badge_trust: 'fsp_verified'
		});
		expect(JSON.stringify(top?.match?.explanation)).not.toContain(strong.factId);

		const comparison = await compareCandidates(deps(), subject, vacancy.id, [
			`${strong.id}@${company.id}`,
			`${weak.id}@${company.id}`
		]);
		expect(comparison.requirements.slice(0, 2)).toEqual([
			{ kind: 'skill', requirement: 'required', skillKey: 'go' },
			{ kind: 'skill', requirement: 'required', skillKey: 'postgresql' }
		]);
		const strongRow = comparison.candidates.find((c) => c.pseudonym === `${strong.id}@${company.id}`);
		expect(strongRow?.cells.slice(0, 2)).toEqual([
			{ kind: 'skill', status: 'confirmed', band: 'strong' },
			{ kind: 'skill', status: 'claimed', band: 'moderate' }
		]);
	});

	it('shows a candidate without a category as insufficient data, the unread evidence in the shares of the score', async () => {
		const { subject, company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'], niceSkillKeys: ['docker'] });
		await vacancyVector(vacancy.id, [1, 0, 0]);
		const unread = await candidate({ desiredRoleKeys: ['backend'], vector: [1, 0, 0] });
		const result = await search(subject, { vacancyId: vacancy.id }, fakeModels());
		const match = result.items.find((item) => item.candidateId === unread.id)?.match;
		if (!match) throw new Error('the candidate without a category is not found for the vacancy');
		// The row of the catalog reads this code to say «insufficient data» instead of a percent.
		expect(match.explanation.to_verify).toContainEqual({ code: 'profile_insufficient_data' });
		for (const key of ['required', 'nice', 'trust'] as const) {
			expect(match.components[key]).toMatchObject({ status: 'unavailable', details: { reason: 'no_published_run' } });
		}

		// The shares the company sees add up to what the score rests on: the unread evidence at the rule set's value.
		const view = matchView(match, { roles: {}, specializations: {}, grades: {}, skills: {} });
		const params = matchRulesetParamsSchema.parse(shippedMatchRuleset.params);
		const rebuilt = view.components.reduce(
			(sum, component) => sum + (component.weight ?? 0) * (component.value ?? params.unavailableEvidenceValue),
			0
		);
		expect(view.components.filter((c) => c.weight !== undefined).map((c) => c.key)).toEqual(
			expect.arrayContaining(['required', 'nice', 'trust'])
		);
		expect(match.score).toBeGreaterThan(0);
		expect(rebuilt).toBeCloseTo(match.score, 3);
	});

	it('runs in the explicit FTS-only mode with the models off, marking their components unavailable', async () => {
		const { subject, company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id);
		const found = await candidate({
			skills: [{ key: 'go', band: 'strong', attestation: 'direct' }],
			vector: [1, 0, 0]
		});

		const byText = await search(subject, { text: 'golang' }, fakeModels({ embed: false }));
		expect(byText.mode).toMatchObject({ searchMode: 'fts_only', embeddingSpaceId: null, semanticReason: 'disabled' });
		expect(ids(byText)).toContain(found.id);

		// The vacancy has no vector: semantic is unavailable for every pair; the reranker is off.
		const matched = await search(subject, { vacancyId: vacancy.id }, fakeModels({ rerank: 'off' }));
		expect(matched.mode).toMatchObject({
			searchMode: 'fts_only',
			semanticReason: 'vacancy_vector_missing',
			reranker: { status: 'unavailable', reason: 'disabled' }
		});
		const item = matched.items.find((i) => i.candidateId === found.id);
		expect(item?.match?.components.semantic).toMatchObject({ status: 'unavailable', value: null });
		expect(item?.match?.components.reranker).toMatchObject({
			status: 'unavailable',
			details: { reason: 'disabled' }
		});
	});

	it('fails the search on a skill inference whose contributions are malformed instead of scoring without them', async () => {
		const { subject, company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		const broken = await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }] });
		const malformed: [unknown, RegExp][] = [
			[[{ attestation: 'direct' }], /does not contain key "fact_id"/],
			[{ fact_id: randomUUID() }, /can only be applied to an array/],
			[[{ fact_id: 'not-a-uuid' }], /contributions of inference go in run .* are malformed/]
		];
		const setContributions = (contributions: unknown) =>
			database.db.update(skillInferences).set({ contributions }).where(eq(skillInferences.candidateId, broken.id));
		const [valid] = await database.db
			.select({ contributions: skillInferences.contributions })
			.from(skillInferences)
			.where(eq(skillInferences.candidateId, broken.id));
		if (!valid) throw new Error('inference not inserted');
		try {
			for (const [contributions, error] of malformed) {
				await setContributions(contributions);
				const failure = await search(subject, { vacancyId: vacancy.id }, fakeModels()).then(
					() => null,
					(reason: unknown) => reason
				);
				expect(String(failure instanceof Error ? (failure.cause ?? failure) : failure)).toMatch(error);
			}
		} finally {
			// The catalog is shared by the tests of this file: the candidate gets its valid evidence back.
			await setContributions(valid.contributions);
		}
	});

	it('excludes withdrawn evidence at once: skills, words and vector of the old revision stop counting', async () => {
		const { subject, company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id);
		await vacancyVector(vacancy.id, [1, 0, 0]);
		const person = await candidate({
			skills: [{ key: 'go', band: 'strong', attestation: 'direct' }],
			category: { specialization: 'backend', grade: 'middle' },
			vector: [1, 0, 0]
		});

		const before = (await search(subject, { vacancyId: vacancy.id })).items.find((i) => i.candidateId === person.id);
		expect(before?.match?.components.required).toMatchObject({ status: 'computed', value: 1 });
		expect(before?.match?.components.semantic.status).toBe('computed');
		expect(ids(await search(subject, { text: 'golang' }, fakeModels({ embed: false })))).toContain(person.id);

		// The run is still `published`: only the floor has moved, as in the withdrawal transaction.
		await withdraw(person.id, person.factId);

		const after = (await search(subject, { vacancyId: vacancy.id })).items.find((i) => i.candidateId === person.id);
		expect(after?.match?.components.required).toMatchObject({
			status: 'unavailable',
			details: { reason: 'run_below_evidence_floor' }
		});
		expect(after?.match?.components.trust.status).toBe('unavailable');
		expect(after?.match?.components.semantic).toMatchObject({
			status: 'unavailable',
			details: { reason: 'candidate_vector_missing' }
		});
		expect(after?.match?.explanation.matches.some((m) => m.kind === 'skill')).toBe(false);
		expect(ids(await search(subject, { text: 'golang' }, fakeModels({ embed: false })))).not.toContain(person.id);
		// The category comes from the tests, not from the evidence: the candidate stays in it.
		expect(ids(await search(subject, { filters: { specializations: ['backend'] } }))).toContain(person.id);
		expect(ids(await search(subject, { filters: { uncategorized: true } }))).not.toContain(person.id);
	});
});

describe('catalog search: the kept ranking and the comparison', () => {
	/** Models counting their calls, for a ranking computed once and served from then on. */
	function countingModels(options: { embed?: boolean; rerank?: FakeReranker } = {}) {
		const models = fakeModels(options);
		const counted = {
			embedCalls: 0,
			get rerankCalls() {
				return models.rerankCalls;
			},
			set reranker(state: FakeReranker) {
				models.reranker = state;
			},
			rerankRequests: models.rerankRequests,
			embed: (request: Parameters<MatchingModels['embed']>[0]) => {
				counted.embedCalls++;
				return models.embed(request);
			},
			rerank: (request: Parameters<MatchingModels['rerank']>[0]) => models.rerank(request)
		};
		return counted;
	}

	it('keeps the ranking of a query until its inputs change: revisions, vectors, the vacancy, the clock', async () => {
		const { subject, company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		await vacancyVector(vacancy.id, [1, 0, 0]);
		const person = await candidate({
			skills: [{ key: 'go', band: 'strong', attestation: 'direct' }],
			vector: [1, 0, 0]
		});
		const models = countingModels();

		const first = await search(subject, { vacancyId: vacancy.id }, models);
		expect(models.rerankCalls).toBe(1);
		// Another page and the same query again are served from the ranking already made.
		const page = await searchCandidates(deps(models), subject, { vacancyId: vacancy.id, limit: 1 });
		expect(page.items[0]).toEqual(first.items[0]);
		expect(await search(subject, { vacancyId: vacancy.id }, models)).toEqual(first);
		expect(models.rerankCalls).toBe(1);

		// A new revision of a candidate is another ranking.
		await database.db
			.update(candidates)
			.set({ profileRevision: sql`${candidates.profileRevision} + 1` })
			.where(eq(candidates.id, person.id));
		await search(subject, { vacancyId: vacancy.id }, models);
		expect(models.rerankCalls).toBe(2);

		// So is a vector rebuilt at the same revision.
		const semanticOf = async () =>
			(await search(subject, { vacancyId: vacancy.id }, models)).items.find((i) => i.candidateId === person.id)?.match
				?.components.semantic.value;
		const close = await semanticOf();
		await database.db
			.update(embeddings)
			.set({ vector: [0, 1, 0], inputSha256: randomSha256() })
			.where(eq(embeddings.ownerId, person.id));
		expect(await semanticOf()).not.toBe(close);
		expect(models.rerankCalls).toBe(3);

		// So is a new revision of the vacancy.
		await database.db
			.update(vacancies)
			.set({ revision: sql`${vacancies.revision} + 1` })
			.where(eq(vacancies.id, vacancy.id));
		await search(subject, { vacancyId: vacancy.id }, models);
		expect(models.rerankCalls).toBe(4);

		// And the ranking does not outlive its lifetime.
		const later = { ...deps(models), now: () => new Date(Date.now() + 121_000) };
		await searchCandidates(later, subject, { vacancyId: vacancy.id });
		expect(models.rerankCalls).toBe(5);
	});

	it('keeps a ranking per company and does not keep one a model failed', async () => {
		const first = await employer();
		const second = await employer();
		await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }], vector: [1, 0, 0] });
		const models = countingModels();

		await search(first.subject, { text: 'golang' }, models);
		await search(first.subject, { text: 'golang' }, models);
		expect(models.embedCalls).toBe(1);
		await search(second.subject, { text: 'golang' }, models);
		expect(models.embedCalls).toBe(2);

		// The reranker failed: the next request asks it again instead of serving the ranking without it.
		const vacancy = await ownVacancy(first.company.id, first.member.id);
		const failing = countingModels({ rerank: 'failing' });
		await search(first.subject, { vacancyId: vacancy.id }, failing);
		const failed = await search(first.subject, { vacancyId: vacancy.id }, failing);
		expect(failed.mode.reranker).toEqual({ status: 'unavailable', reason: 'timeout' });
		expect(failing.rerankCalls).toBe(2);
	});

	it('keeps a ranking without the reranker while it is off, and makes a new one once it is back', async () => {
		const { subject, company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }], vector: [1, 0, 0] });
		const models = countingModels({ rerank: 'off' });

		const off = await search(subject, { vacancyId: vacancy.id }, models);
		expect(off.mode.reranker).toEqual({ status: 'unavailable', reason: 'disabled' });
		expect(await search(subject, { vacancyId: vacancy.id }, models)).toEqual(off);
		expect(models.rerankCalls).toBe(1);
		// Still kept close to the end of its lifetime: being off does not pass by itself.
		const later = { ...deps(models), now: () => new Date(Date.now() + 100_000) };
		await searchCandidates(later, subject, { vacancyId: vacancy.id });
		expect(models.rerankCalls).toBe(1);

		// Switched on: the very next request ranks with it.
		models.reranker = 'on';
		const on = await search(subject, { vacancyId: vacancy.id }, models);
		expect(on.mode.reranker).toEqual({ status: 'used', reason: null });
		expect(models.rerankCalls).toBe(2);
	});

	it('keeps a ranking by words with the embedder off only briefly: nothing tells when it is back', async () => {
		const { subject } = await employer();
		await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }], vector: [1, 0, 0] });
		const models = countingModels({ embed: false });

		expect((await search(subject, { text: 'golang' }, models)).mode.semanticReason).toBe('disabled');
		await search(subject, { text: 'golang' }, models);
		expect(models.embedCalls).toBe(1);
		const later = { ...deps(models), now: () => new Date(Date.now() + 11_000) };
		await searchCandidates(later, subject, { text: 'golang' });
		expect(models.embedCalls).toBe(2);
	});

	it('bounds the kept rankings by their weight, the least recently used going first', () => {
		const ranking = (candidates: number) => ({
			entries: Array.from({ length: candidates }, (_, index) => ({
				candidateId: `candidate-${index}`,
				fts: 0.5,
				semantic: null,
				match: null,
				needMatch: null
			})),
			mode: {
				searchMode: 'fts_only' as const,
				embeddingSpaceId: null,
				semanticReason: 'no_active_space',
				reranker: { status: 'not_applicable' as const, reason: null }
			}
		});
		const small = ranking(10);
		const large = ranking(200);
		expect(rankingWeight(large)).toBeGreaterThan(3 * rankingWeight(small));

		const cache = new RankingCache(rankingWeight(small) * 3);
		cache.set('a', small, 0, 60_000);
		cache.set('b', small, 0, 60_000);
		cache.set('c', small, 0, 60_000);
		expect(cache.size).toBe(3);
		expect(cache.get('a', 1)).toBe(small);
		// One more pushes out the least recently used: «b», since «a» was just read.
		cache.set('d', small, 1, 60_000);
		expect([cache.get('a', 2), cache.get('b', 2)]).toEqual([small, null]);
		expect(cache.bytes).toBe(rankingWeight(small) * 3);
		// A ranking heavier than the whole bound is not kept and pushes nothing out.
		cache.set('e', large, 2, 60_000);
		expect(cache.get('e', 3)).toBeNull();
		expect(cache.size).toBe(3);
		// Expired rankings are dropped when another is kept, read or not.
		cache.set('f', small, 60_001, 60_000);
		expect(cache.size).toBe(1);
		expect(cache.bytes).toBe(rankingWeight(small));
	});

	it('keeps a ranking made while the reranker cools down only briefly and only until it is called again', async () => {
		const { subject, company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }], vector: [1, 0, 0] });
		const models = countingModels({ rerank: 'cooling' });

		const cooling = await search(subject, { vacancyId: vacancy.id }, models);
		expect(cooling.mode.reranker).toEqual({ status: 'unavailable', reason: 'unavailable' });
		await search(subject, { vacancyId: vacancy.id }, models);
		expect(models.rerankCalls).toBe(1);
		// Kept briefly: the cooldown ends by itself.
		const later = { ...deps(models), now: () => new Date(Date.now() + 11_000) };
		await searchCandidates(later, subject, { vacancyId: vacancy.id });
		expect(models.rerankCalls).toBe(2);

		// The cooldown is over: the next request asks the reranker instead of serving the kept ranking.
		models.reranker = 'on';
		expect((await search(subject, { vacancyId: vacancy.id }, models)).mode.reranker.status).toBe('used');
		expect(models.rerankCalls).toBe(3);
	});

	it('compares only the chosen candidates, and none the viewer cannot see', async () => {
		const { subject, company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		const skills = [{ key: 'go', band: 'strong' as const, attestation: 'direct' as const }];
		const [a, b] = [await candidate({ skills }), await candidate({ skills })];
		const hidden = await candidate({ skills, visibility: 'hidden' });
		// Visible and not chosen: not scored.
		await candidate({ skills });
		const models = countingModels();

		const comparison = await compareCandidates(
			deps(models),
			subject,
			vacancy.id,
			[a, b, hidden].map((person) => `${person.id}@${company.id}`)
		);
		expect(comparison.candidates.map((row) => row.pseudonym).sort()).toEqual(
			[a, b].map((person) => `${person.id}@${company.id}`).sort()
		);
		expect(models.rerankRequests).toHaveLength(1);
		expect(models.rerankRequests[0]?.documents.map((document) => document.id).sort()).toEqual([a.id, b.id].sort());
	});
});

// --- The candidate's side -------------------------------------------------------------------------------------------

describe('recommendations to the candidate', () => {
	it('ranks own and external vacancies with the same explanation, also for a hidden profile', async () => {
		const { company, member } = await employer();
		const own = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		const external = await createExternalVacancy(database.db, taxonomyVersionId, {
			title: 'Python developer',
			requiredSkillKeys: ['python']
		});
		const person = await candidate({
			visibility: 'hidden',
			skills: [{ key: 'go', band: 'strong', attestation: 'direct' }],
			category: { specialization: 'backend', grade: 'middle' }
		});
		const subject = candidateSubject(person);

		const result = await recommendVacancies({ db: database.db }, subject, { limit: 100 });
		const vacancyIds = result.items.map((item) => item.vacancyId);
		expect(vacancyIds.indexOf(own.id)).toBeLessThan(vacancyIds.indexOf(external.id));
		const top = result.items.find((item) => item.vacancyId === own.id);
		expect(top?.match.explanation.matches).toContainEqual(
			expect.objectContaining({ kind: 'skill', skill_key: 'go', fact_ids: [person.factId] })
		);
		expect(top?.match.components.reranker).toMatchObject({
			status: 'unavailable',
			details: { reason: 'pair_not_reranked' }
		});
		const other = result.items.find((item) => item.vacancyId === external.id);
		expect(other?.match.explanation.gaps).toContainEqual({ code: 'required_skill_missing', skill_key: 'python' });
		expect(other?.match.components.grade).toMatchObject({
			status: 'unknown',
			details: { reason: 'vacancy_grade_unknown' }
		});
	});

	it('does not compare an expectation in another tax base with the vacancy range', async () => {
		const { company, member } = await employer();
		const own = await ownVacancy(company.id, member.id);
		const person = await candidate({
			skills: [{ key: 'go', band: 'strong', attestation: 'direct' }],
			preferences: {
				salary_expectation: { min: 300_000, max: null, currency: 'RUB', period: 'month', tax_base: 'net' }
			}
		});
		const subject = candidateSubject(person);
		const result = await recommendVacancies({ db: database.db }, subject, { limit: 100 });
		const item = result.items.find((i) => i.vacancyId === own.id);
		expect(item?.match.components.salary).toMatchObject({ status: 'not_comparable', value: null });
		expect(item?.match.explanation.to_verify).toContainEqual({ code: 'salary_not_comparable' });
	});
});

// --- match.refresh --------------------------------------------------------------------------------------------------

async function runRefresh(models: MatchingModels, beforeWrite?: () => Promise<void>) {
	const { db } = database;
	const claimed = await claimJob(db, 'test-worker', ['match.refresh']);
	if (claimed?.type !== 'match.refresh') throw new Error('no match.refresh job to run');
	const job: ClaimedJob<'match.refresh'> = {
		...claimed,
		type: 'match.refresh',
		payload: JOB_TYPES['match.refresh'].payload.parse(claimed.payload)
	};
	const result = await createMatchRefreshHandler(() => models).run({
		job,
		db,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log: createLogger({}, () => undefined)
	});
	await beforeWrite?.();
	return completeJob(db, job, result);
}

async function enqueueRefresh(
	payload: { scope: 'vacancy'; vacancy_id: string } | { scope: 'candidate'; candidate_id: string }
) {
	await database.db.transaction((tx) =>
		enqueueJob(tx, 'match.refresh', payload, { inputVersion: '1', createdBy: { kind: 'system' } })
	);
}

async function storedRows(vacancyId: string, candidateId: string) {
	return database.db
		.select()
		.from(matchScores)
		.where(and(eq(matchScores.vacancyId, vacancyId), eq(matchScores.candidateId, candidateId)));
}

describe('match.refresh', () => {
	afterEach(async () => {
		// Pool changes enqueue vacancy refreshes; every test starts without waiting jobs.
		await database.db.delete(jobs).where(eq(jobs.status, 'queued'));
	});

	it('stores the decomposition by revisions and counts the pool of confirmed candidates', async () => {
		const { db } = database;
		const { company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		const confirmed = await candidate({
			skills: [{ key: 'go', band: 'strong', attestation: 'direct' }],
			category: { specialization: 'backend', grade: 'middle' }
		});
		const claimedOnly = await candidate({
			skills: [{ key: 'go', band: 'strong', attestation: 'claimed' }],
			category: { specialization: 'backend', grade: 'middle' }
		});

		await enqueueRefresh({ scope: 'vacancy', vacancy_id: vacancy.id });
		expect(await runRefresh(fakeModels())).toBe('succeeded');

		const [row] = await storedRows(vacancy.id, confirmed.id);
		expect(row).toMatchObject({
			vacancyRevision: 1,
			candidateRevision: 1,
			matchRulesetId: ruleset.id,
			evidenceRunId: confirmed.runId
		});
		if (!row) throw new Error('no stored row');
		expect(storedComponent(row, 'reranker')).toEqual({ status: 'computed', value: 0.9 });
		expect(storedComponent(row, 'trust')).toEqual({ status: 'computed', value: 1 });
		expect(row.rerankerModelId).toBe('test-reranker');
		expect(await storedRows(vacancy.id, claimedOnly.id)).toHaveLength(1);
		const [counted] = await db.select().from(vacancies).where(eq(vacancies.id, vacancy.id));
		// Other tests' candidates with a direct Go may also be in the pool; the claimed-only one never is.
		expect(counted?.poolCount).toBeGreaterThanOrEqual(1);
		expect(counted?.poolCountedAt).not.toBeNull();
	});

	it('does not store a row computed from evidence withdrawn before the write', async () => {
		const { company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		const person = await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }] });

		await enqueueRefresh({ scope: 'vacancy', vacancy_id: vacancy.id });
		expect(
			await runRefresh(fakeModels(), async () => {
				await withdraw(person.id, person.factId);
			})
		).toBe('succeeded');
		expect(await storedRows(vacancy.id, person.id)).toHaveLength(0);

		// The candidate's own refresh at the new revision computes the pair without the withdrawn skill: nothing of the
		// rule set is computed, the score is below the store threshold and no row is kept; the read explains it anyway.
		await enqueueRefresh({ scope: 'candidate', candidate_id: person.id });
		expect(await runRefresh(fakeModels())).toBe('succeeded');
		expect(await storedRows(vacancy.id, person.id)).toHaveLength(0);
		const recommended = await recommendVacancies({ db: database.db }, candidateSubject(person), { limit: 100 });
		expect(recommended.items.find((i) => i.vacancyId === vacancy.id)?.match.components.required).toMatchObject({
			status: 'unavailable',
			details: { reason: 'run_below_evidence_floor' }
		});
	});

	it('discards a candidate refresh whose revision moved on', async () => {
		const person = await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }] });
		await enqueueRefresh({ scope: 'candidate', candidate_id: person.id });
		expect(
			await runRefresh(fakeModels(), async () => {
				await withdraw(person.id, person.factId);
			})
		).toBe('discarded_stale');
	});
});

// --- Stored matches -------------------------------------------------------------------------------------------------

async function rowVersion(id: string) {
	const [row] = await database.db.execute<{ xmin: string }>(
		sql`select xmin::text as xmin from match_scores where id = ${id}`
	);
	return row?.xmin;
}

describe('stored matches', () => {
	/** One refresh on an empty queue: pool changes of earlier refreshes enqueue refreshes of other vacancies. */
	async function refresh(
		payload: { scope: 'vacancy'; vacancy_id: string } | { scope: 'candidate'; candidate_id: string },
		models: MatchingModels = fakeModels()
	) {
		await database.db.delete(jobs).where(eq(jobs.status, 'queued'));
		await enqueueRefresh(payload);
		return runRefresh(models);
	}

	afterEach(async () => {
		await database.db.delete(jobs).where(eq(jobs.status, 'queued'));
	});

	it('keeps only pairs at the store threshold and explains a pair without a row the same way when read', async () => {
		const { company, member, subject } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		const fits = await candidate({
			skills: [{ key: 'go', band: 'strong', attestation: 'direct' }],
			category: { specialization: 'backend', grade: 'middle' }
		});
		// Another specialization, none of the required skills: nothing of the vacancy fits.
		const misses = await candidate({
			skills: [{ key: 'python', band: 'strong', attestation: 'direct' }],
			category: { specialization: 'data_ml', grade: 'junior' }
		});

		expect(await refresh({ scope: 'vacancy', vacancy_id: vacancy.id })).toBe('succeeded');
		const [stored] = await storedRows(vacancy.id, fits.id);
		if (!stored) throw new Error('the fitting pair is not stored');
		expect(Number(stored.score)).toBeGreaterThanOrEqual(STORE_THRESHOLD);
		expect(await storedRows(vacancy.id, misses.id)).toHaveLength(0);

		// The company reads one pair the way `GET /vacancies/{id}/matches/{pseudonym}` does.
		const read = async (candidateId: string) => {
			const found = await findInCatalog(deps(), subject, `${candidateId}@${company.id}`, vacancy.id);
			if (!found?.match) throw new Error('the pair is not explained');
			return found.match;
		};
		const fitting = await read(fits.id);
		expect(fitting.score).toBe(Number(stored.score));
		const decomposition = encodeComponents(fitting.components);
		expect(stored).toMatchObject(decomposition);

		// Without a row: the same decomposition and explanation, with what is missing.
		const missing = await read(misses.id);
		expect(missing.score).toBeLessThan(STORE_THRESHOLD);
		expect(Object.keys(missing.components)).toEqual(Object.keys(fitting.components));
		expect(missing.components.required).toMatchObject({ status: 'computed', value: 0 });
		expect(missing.components.role).toMatchObject({
			status: 'computed',
			value: 0,
			details: { basis: 'other_specialization' }
		});
		expect(missing.explanation.gaps).toEqual([
			{ code: 'required_skill_missing', skill_key: 'go' },
			{ code: 'specialization_other' }
		]);
		// And the candidate sees why the vacancy does not fit.
		const own = await recommendVacancies({ db: database.db }, candidateSubject(misses), { limit: 100 });
		expect(own.items.find((i) => i.vacancyId === vacancy.id)?.match.explanation.gaps).toContainEqual({
			code: 'required_skill_missing',
			skill_key: 'go'
		});
	});

	it('rewrites nothing for unchanged inputs and removes rows that are no longer current or significant', async () => {
		const { db } = database;
		const { company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		// No category: it would keep the pair significant after the evidence is withdrawn.
		const person = await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }] });

		expect(await refresh({ scope: 'vacancy', vacancy_id: vacancy.id })).toBe('succeeded');
		const [first] = await storedRows(vacancy.id, person.id);
		if (!first) throw new Error('no stored row');
		const version = await rowVersion(first.id);

		// The same inputs: the row is not rewritten, from either side.
		expect(await refresh({ scope: 'vacancy', vacancy_id: vacancy.id })).toBe('succeeded');
		expect(await refresh({ scope: 'candidate', candidate_id: person.id })).toBe('succeeded');
		expect(await storedRows(vacancy.id, person.id)).toEqual([first]);
		expect(await rowVersion(first.id)).toBe(version);

		// Another result for the same snapshot (the reranker is off now) replaces the row in place.
		expect(await refresh({ scope: 'vacancy', vacancy_id: vacancy.id }, fakeModels({ rerank: 'off' }))).toBe(
			'succeeded'
		);
		const [replaced] = await storedRows(vacancy.id, person.id);
		expect(replaced?.id).toBe(first.id);
		expect(replaced && storedComponent(replaced, 'reranker').status).toBe('unavailable');
		expect(replaced?.rerankerModelId).toBeNull();

		// A new revision of the vacancy: the row of the old one goes.
		await db
			.update(vacancies)
			.set({ revision: sql`${vacancies.revision} + 1` })
			.where(eq(vacancies.id, vacancy.id));
		expect(await refresh({ scope: 'vacancy', vacancy_id: vacancy.id })).toBe('succeeded');
		const current = await storedRows(vacancy.id, person.id);
		expect(current.map((row) => row.vacancyRevision)).toEqual([2]);

		// The pair falls below the threshold: its rows go. An offer of the company keeps no row — «why you» is a snapshot
		// in its terms (domain 13.5).
		const other = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		expect(await refresh({ scope: 'vacancy', vacancy_id: other.id })).toBe('succeeded');
		expect(await storedRows(other.id, person.id)).toHaveLength(1);
		await withdraw(person.id, person.factId);
		expect(await refresh({ scope: 'candidate', candidate_id: person.id })).toBe('succeeded');
		expect(await storedRows(vacancy.id, person.id)).toHaveLength(0);
		expect(await storedRows(other.id, person.id)).toHaveLength(0);
	});

	it('removes the rows of a closed vacancy', async () => {
		const { company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, { requiredSkillKeys: ['go'] });
		const person = await candidate({ skills: [{ key: 'go', band: 'strong', attestation: 'direct' }] });
		expect(await refresh({ scope: 'vacancy', vacancy_id: vacancy.id })).toBe('succeeded');
		expect(await storedRows(vacancy.id, person.id)).toHaveLength(1);
		await database.db
			.update(vacancies)
			.set({ status: 'closed', closedAt: new Date() })
			.where(eq(vacancies.id, vacancy.id));
		expect(await refresh({ scope: 'vacancy', vacancy_id: vacancy.id })).toBe('succeeded');
		expect(await storedRows(vacancy.id, person.id)).toHaveLength(0);
	});

	it('refuses a store threshold above the pool threshold of the rule set', async () => {
		await expect(
			database.db.transaction(async (tx) => {
				await tx.insert(productPolicies).values({
					kind: 'matching_policy',
					version: 2,
					params: { store_threshold: ruleset.params.poolThreshold + 0.1 },
					effectiveFrom: new Date(Date.now() - 1000)
				});
				await loadMatchStoragePolicy(tx, ruleset, new Date());
			})
		).rejects.toMatchObject({ code: 'threshold_above_pool' });
	});
});

describe('pool counter', () => {
	it('is refused without catalog_policy: the small-count threshold is a decision of the policy', async () => {
		const { db } = database;
		const { company, member } = await employer();
		const vacancy = await ownVacancy(company.id, member.id, {
			requiredSkillKeys: ['go'],
			poolCount: 3,
			poolCountedAt: new Date()
		});
		await expect(loadPoolCounter(db, vacancy.id, new Date())).rejects.toThrow('no catalog_policy is in force');

		await db.insert(productPolicies).values({
			kind: 'catalog_policy',
			version: 1,
			params: { small_count_threshold: 2 },
			effectiveFrom: new Date(Date.now() - DAY)
		});
		expect(await loadPoolCounter(db, vacancy.id, new Date())).toMatchObject({ status: 'counted', count: 3 });
	});
});

// --- Demo sessions --------------------------------------------------------------------------------------------------

describe('demo sessions', () => {
	async function session() {
		const [row] = await database.db
			.insert(demoSessions)
			.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + DAY) })
			.returning();
		if (!row) throw new Error('demo session not inserted');
		return row.id;
	}

	afterEach(async () => {
		await database.db.delete(jobs).where(eq(jobs.status, 'queued'));
	});

	it('keeps the catalog, the cards and the vacancies of each session to itself', async () => {
		const [s1, s2] = [await session(), await session()];
		const real = await employer();
		const first = await employer({ demoSessionId: s1 });
		const second = await employer({ demoSessionId: s2 });
		const skills = [{ key: 'go', band: 'strong' as const, attestation: 'direct' as const }];
		// A region of this test only: the page of the search holds them whatever other tests left in the catalog.
		const preferences = { region_code: 'RU-DEMO' };
		const person = await candidate({ skills, preferences });
		const clone1 = await candidate({ skills, preferences, demoSessionId: s1 });
		const clone2 = await candidate({ skills, preferences, demoSessionId: s2 });

		// The catalog: a session sees its clones and the candidates outside sessions; outside, no clone at all.
		const seen = async (viewer: Awaited<ReturnType<typeof employer>>) => {
			const found = new Set(ids(await search(viewer.subject, { filters: { regionCodes: ['RU-DEMO'] } })));
			return [person.id, clone1.id, clone2.id].filter((id) => found.has(id));
		};
		expect(await seen(real)).toEqual([person.id]);
		expect(await seen(first)).toEqual([person.id, clone1.id]);
		expect(await seen(second)).toEqual([person.id, clone2.id]);

		// A card is not opened across sessions even by its pseudonym.
		const card = (viewer: Awaited<ReturnType<typeof employer>>, candidateId: string) =>
			findInCatalog(deps(), viewer.subject, `${candidateId}@${viewer.company.id}`, undefined);
		expect(await card(first, clone1.id)).not.toBeNull();
		expect(await card(second, clone1.id)).toBeNull();
		expect(await card(real, clone1.id)).toBeNull();

		// Vacancies for a candidate: a clone sees those of its session and outside sessions; a real person no clone's.
		const own = await ownVacancy(real.company.id, real.member.id);
		const v1 = await ownVacancy(first.company.id, first.member.id);
		const v2 = await ownVacancy(second.company.id, second.member.id);
		const offered = async (who: { id: string; userId: string }) => {
			const result = await recommendVacancies({ db: database.db }, candidateSubject(who), { limit: 100 });
			const found = new Set(result.items.map((item) => item.vacancyId));
			return [own.id, v1.id, v2.id].filter((id) => found.has(id));
		};
		expect(await offered(person)).toEqual([own.id]);
		expect(await offered(clone1)).toEqual([own.id, v1.id]);
		expect(await offered(clone2)).toEqual([own.id, v2.id]);
	});

	it('matches and counts the pool of a vacancy only with the candidates its company can see', async () => {
		const s1 = await session();
		const real = await employer();
		const first = await employer({ demoSessionId: s1 });
		const skills = [{ key: 'go', band: 'strong' as const, attestation: 'direct' as const }];
		const person = await candidate({ skills, category: { specialization: 'backend', grade: 'middle' } });
		const clone = await candidate({
			skills,
			category: { specialization: 'backend', grade: 'middle' },
			demoSessionId: s1
		});
		const own = await ownVacancy(real.company.id, real.member.id, { requiredSkillKeys: ['go'] });
		const cloned = await ownVacancy(first.company.id, first.member.id, { requiredSkillKeys: ['go'] });

		await enqueueRefresh({ scope: 'vacancy', vacancy_id: own.id });
		expect(await runRefresh(fakeModels())).toBe('succeeded');
		await enqueueRefresh({ scope: 'vacancy', vacancy_id: cloned.id });
		expect(await runRefresh(fakeModels())).toBe('succeeded');
		expect(await storedRows(own.id, person.id)).toHaveLength(1);
		expect(await storedRows(own.id, clone.id)).toHaveLength(0);
		expect(await storedRows(cloned.id, person.id)).toHaveLength(1);
		expect(await storedRows(cloned.id, clone.id)).toHaveLength(1);
		const pool = async (vacancyId: string) =>
			(await database.db.select({ n: vacancies.poolCount }).from(vacancies).where(eq(vacancies.id, vacancyId)))[0]?.n;
		// The clone is in the pool of its session's vacancy only.
		expect(await pool(cloned.id)).toBe(((await pool(own.id)) ?? 0) + 1);

		// The candidate side makes the same pairs: the clone's refresh keeps no pair with the vacancy outside sessions.
		await database.db.delete(jobs).where(eq(jobs.status, 'queued'));
		await enqueueRefresh({ scope: 'candidate', candidate_id: clone.id });
		expect(await runRefresh(fakeModels())).toBe('succeeded');
		expect(await storedRows(own.id, clone.id)).toHaveLength(0);
		expect(await storedRows(cloned.id, clone.id)).toHaveLength(1);
	});
});
