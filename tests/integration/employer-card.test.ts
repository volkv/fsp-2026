// The catalog card of a company (docs/domain.md, sections 7.4, 13.4, 14): the candidate of a pseudonym is found with the
// checks of the catalog search and `canShow` for that one candidate, and the match of that one pair is computed — the
// catalog is not ranked to open one card. Every candidate the company may not see is «not found», whatever the reason.
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	candidateCompanyBlocks,
	candidates,
	categorizationRulesets,
	evidenceRuns,
	consentEvents,
	documentAcceptances,
	grades,
	legalRepresentatives,
	matchRulesets,
	productPolicies,
	receiptTemplates,
	representations,
	roles,
	skillInferences,
	skills,
	sourceFacts,
	taxonomyVersions,
	vacancies
} from '$lib/server/db/schema';
import { findInCatalog, loadCatalogCard } from '$lib/server/employer/card';
import { listOwnVacancies } from '$lib/server/employer/vacancies';
import { createReceiptSigner, type ReceiptSigner } from '$lib/server/fsp/receipts';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { matchRulesetParamsSchema } from '$lib/server/matching/params';
import { searchCandidates } from '$lib/server/matching/search';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { ok } from '$lib/server/ml/result';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
import shippedTemplates from '../../taxonomy/receipt-templates.json';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	randomSha256
} from '../helpers/factories';

const DAY = 86_400_000;

let database: TestDatabase;
let taxonomyVersionId: string;
let categorizationRulesetId: string;
let documents: Record<'pd' | 'catalog' | 'minorTerms', string>;

const yearsAgo = (years: number) => {
	const date = new Date();
	date.setUTCFullYear(date.getUTCFullYear() - years);
	date.setUTCMonth(0, 15);
	return date.toISOString().slice(0, 10);
};

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	await db
		.insert(grades)
		.values(
			['intern', 'junior', 'middle', 'senior'].map((key, ordinal) => ({ taxonomyVersionId, key, ordinal, name: key }))
		);
	await db.insert(skills).values([
		{ taxonomyVersionId, key: 'go', kind: 'language', name: 'Go' },
		{ taxonomyVersionId, key: 'python', kind: 'language', name: 'Python' }
	]);
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
	await db.insert(matchRulesets).values({
		version: shippedMatchRuleset.version,
		taxonomyVersionId,
		params: matchRulesetParamsSchema.parse(shippedMatchRuleset.params)
	});
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
	await db.insert(productPolicies).values({
		kind: 'minor_policy',
		version: 1,
		params: { enabled: true, authority_methods: ['in_person'] },
		effectiveFrom: new Date(Date.now() - DAY)
	});
});

afterAll(async () => {
	await database.drop();
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

async function employer(options: { minorTerms?: boolean } = {}) {
	const { db } = database;
	const company = await createCompany(db);
	const member = await createMember(db, company.id);
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

/** A candidate of the catalog with a published run, `go` confirmed by an FSP result, and the category backend middle. */
async function candidate(
	setup: {
		birthYearsAgo?: number;
		skill?: string;
		visibility?: 'hidden' | 'catalog';
		searchStatus?: 'active' | 'open_to_offers' | 'not_looking';
		consents?: boolean;
	} = {}
) {
	const { db } = database;
	const row = await createCandidate(db, {
		birthDate: yearsAgo(setup.birthYearsAgo ?? 28),
		visibility: setup.visibility ?? 'catalog',
		searchStatus: setup.searchStatus ?? 'active',
		// The grade decision below moves the profile to revision 1, the one of the run.
		profileRevision: 0
	});
	if (setup.consents !== false) {
		await grant(row.id, row.userId, 'pd_processing');
		await grant(row.id, row.userId, 'catalog_visibility');
	}
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
	const skillKey = setup.skill ?? 'go';
	await db.insert(skillInferences).values({
		runId: run.id,
		candidateId: row.id,
		skillKey,
		strength: '0.800',
		strengthBand: 'strong',
		attestation: 'direct',
		badgeTrust: 'fsp_verified',
		contributions: [{ fact_id: fact.id, attestation: 'direct' }]
	});
	await decide(db, row.id, { specialization: 'backend', grade: 'middle' });
	return { ...row, factId: fact.id };
}

/** Models that record what they were asked: the card must score one pair, not the catalog. */
function recordingModels() {
	const reranked: number[] = [];
	const models: MatchingModels = {
		embed: () => Promise.reject(new Error('the card embeds nothing')),
		rerank: (request) => {
			reranked.push(request.documents.length);
			return Promise.resolve(
				ok({
					model: { modelId: 'test-reranker' },
					scores: request.documents.map((document) => ({ id: document.id, score: 0.9 })),
					latencyMs: 1
				})
			);
		}
	};
	return { models, reranked };
}

function deps(models: MatchingModels = recordingModels().models): MatchingDeps {
	return {
		db: database.db,
		models,
		pseudonym: (candidateId, companyId) => `${candidateId}@${companyId}`,
		now: () => new Date()
	};
}

const find = (subject: AccessSubject, pseudonym: string, vacancyId?: string, models?: MatchingModels) =>
	findInCatalog(deps(models), subject, pseudonym, vacancyId);

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('catalog card: finding the candidate', () => {
	it('finds one candidate by the company pseudonym and scores only that pair, as the list scores it', async () => {
		const { company, member, subject } = await employer();
		const vacancy = await createOwnVacancy(database.db, {
			companyId: company.id,
			memberId: member.id,
			taxonomyVersionId
		});
		const target = await candidate();
		await candidate();
		await candidate({ skill: 'python' });
		const pseudonym = `${target.id}@${company.id}`;

		const list = await searchCandidates(deps(), subject, { vacancyId: vacancy.id, limit: 100 });
		const listed = list.items.find((item) => item.candidateId === target.id);
		if (!listed?.match) throw new Error('the list has no match for the candidate');

		const recording = recordingModels();
		const found = await find(subject, pseudonym, vacancy.id, recording.models);
		expect(found).toMatchObject({ candidateId: target.id, pseudonym, projection: 'catalog', extras: [] });
		// One document to the reranker: the pair alone, not the catalog ranked to find it.
		expect(recording.reranked).toEqual([1]);
		// The first candidate of the list is reranked there too: the card shows the same match.
		expect(found?.match).toEqual(listed.match);
		expect(found?.match?.components.reranker).toMatchObject({ status: 'computed', value: 0.9 });
		expect(JSON.stringify(found?.match)).not.toContain(target.factId);

		// Outside a vacancy: the same candidate, no match, no model call.
		const outside = recordingModels();
		expect(await find(subject, pseudonym, undefined, outside.models)).toMatchObject({
			candidateId: target.id,
			match: null
		});
		expect(outside.reranked).toEqual([]);
	});

	it('does not know a pseudonym of another company or one that is made up', async () => {
		const own = await employer();
		const other = await employer();
		const person = await candidate();
		expect(await find(own.subject, `${person.id}@${own.company.id}`)).not.toBeNull();
		expect(await find(own.subject, `${person.id}@${other.company.id}`)).toBeNull();
		expect(await find(own.subject, 'AAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
	});
});

describe('catalog card: refusals', () => {
	it('answers «not found» for a candidate hidden, not looking, without consent, blocking or inactive', async () => {
		const { db } = database;
		const { company, subject } = await employer();
		const hidden = await candidate({ visibility: 'hidden' });
		const notLooking = await candidate({ searchStatus: 'not_looking' });
		const withoutConsent = await candidate({ consents: false });
		const revoked = await candidate();
		await grant(revoked.id, revoked.userId, 'catalog_visibility', { action: 'revoke', at: new Date() });
		const blocking = await candidate();
		await db.insert(candidateCompanyBlocks).values({ candidateId: blocking.id, companyId: company.id });
		const deleting = await candidate();
		await db.update(candidates).set({ status: 'deletion_pending' }).where(eq(candidates.id, deleting.id));

		for (const person of [hidden, notLooking, withoutConsent, revoked, blocking, deleting]) {
			expect(await find(subject, `${person.id}@${company.id}`)).toBeNull();
		}
	});

	it('refuses a vacancy that is not an open own one, and a member of a company the admission policy closed', async () => {
		const own = await employer();
		const other = await employer();
		const person = await candidate();
		const foreign = await createOwnVacancy(database.db, {
			companyId: other.company.id,
			memberId: other.member.id,
			taxonomyVersionId
		});
		const closed = await createOwnVacancy(
			database.db,
			{ companyId: own.company.id, memberId: own.member.id, taxonomyVersionId },
			{ status: 'closed', closedAt: new Date() }
		);
		const pseudonym = `${person.id}@${own.company.id}`;
		await expect(find(own.subject, pseudonym, foreign.id)).rejects.toMatchObject({ code: 'not_found' });
		await expect(find(own.subject, pseudonym, closed.id)).rejects.toMatchObject({ code: 'not_found' });

		const membership = own.subject.membership;
		if (!membership) throw new Error('employer without membership');
		await expect(
			find({ ...own.subject, membership: { ...membership, companyStatus: 'suspended' } }, pseudonym)
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('shows a candidate aged 14–17 only in the context of a suitable vacancy of the viewing company', async () => {
		const { db } = database;
		const own = await employer({ minorTerms: true });
		const other = await employer();
		const [acceptance] = await db
			.select({ id: documentAcceptances.id })
			.from(documentAcceptances)
			.where(eq(documentAcceptances.companyId, own.company.id));
		if (!acceptance) throw new Error('acceptance not inserted');
		const internship = await createOwnVacancy(
			db,
			{ companyId: own.company.id, memberId: own.member.id, taxonomyVersionId },
			{ gradeMin: 'intern', gradeMax: 'junior', minAge: 16, minorTermsAcceptanceId: acceptance.id }
		);
		const adultsOnly = await createOwnVacancy(db, {
			companyId: other.company.id,
			memberId: other.member.id,
			taxonomyVersionId
		});

		const minor = await candidate({ birthYearsAgo: 17 });
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

		const ownPseudonym = `${minor.id}@${own.company.id}`;
		const found = await find(own.subject, ownPseudonym, internship.id);
		expect(found).toMatchObject({ candidateId: minor.id, extras: [] });
		expect(found?.match).not.toBeNull();
		// Without a vacancy, in another company, for a vacancy without `min_age`: not shown.
		expect(await find(own.subject, ownPseudonym)).toBeNull();
		expect(await find(other.subject, `${minor.id}@${other.company.id}`)).toBeNull();
		expect(await find(other.subject, `${minor.id}@${other.company.id}`, adultsOnly.id)).toBeNull();
		// A vacancy no longer published removes the candidate from the company's cards.
		await db.update(vacancies).set({ status: 'paused' }).where(eq(vacancies.id, internship.id));
		expect(await find(own.subject, ownPseudonym, internship.id)).toBeNull();
	});
});

describe('own vacancies of the company', () => {
	it('lists the vacancies the test factory makes, with their clean text check', async () => {
		// The pool counter of the list takes its threshold from the catalog policy.
		await database.db.insert(productPolicies).values({
			kind: 'catalog_policy',
			version: 1,
			params: { small_count_threshold: 5 },
			effectiveFrom: new Date(Date.now() - DAY)
		});
		const own = await employer();
		const vacancy = await createOwnVacancy(database.db, {
			companyId: own.company.id,
			memberId: own.member.id,
			taxonomyVersionId
		});
		const listed = await listOwnVacancies(database.db, own.company.id, new Date());
		expect(listed.map((view) => view.id)).toEqual([vacancy.id]);
		expect(listed[0]?.textCheck).toMatchObject({ result: 'clean', warnings_confirmed: null, moderation: null });
	});
});

describe('catalog card: what the company reads on it', () => {
	const signing = { issuer: 'http://localhost:57173', keyId: 'test-1', seed: Buffer.alloc(32, 3) };
	const federation = createReceiptSigner(signing);
	const simulator = createReceiptSigner({ ...signing, fspSimulator: true });

	beforeAll(async () => {
		const { db } = database;
		const version = await createTaxonomyVersion(db);
		await db.insert(receiptTemplates).values(
			shippedTemplates.templates.map((template) => ({
				taxonomyVersionId: version.id,
				source: template.source,
				factType: template.factType,
				asserts: template.asserts,
				doesNotAssert: template.doesNotAssert
			}))
		);
		await db
			.update(taxonomyVersions)
			.set({ status: 'published', publishedAt: new Date() })
			.where(eq(taxonomyVersions.id, version.id));
	});

	/** An adult with one FSP result and the region stated in the preferences, if any. */
	async function withResult(regionCode?: string) {
		const { db } = database;
		const row = await createCandidate(db, {
			preferences: regionCode === undefined ? {} : { region_code: regionCode }
		});
		const competitionId = randomSha256().slice(0, 8);
		await db.insert(sourceFacts).values({
			candidateId: row.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:result:${randomSha256().slice(0, 12)}`,
			eventKey: `fsp:competition:${competitionId}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'operator_confirmed',
			payload: {
				result: { id: 'r-1', competitionId, place: 3, team: null, award: 'prize', status: 'official' },
				competition: {
					id: competitionId,
					ekpNumber: null,
					title: 'Кубок России по спортивному программированию',
					discipline: 'algorithmic',
					level: 'russian_cup',
					stage: 'final',
					format: 'individual',
					startDate: '2025-10-01',
					online: false
				}
			},
			payloadSha256: randomSha256(),
			sourceSnapshotSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			occurredOn: '2025-10-01',
			status: 'active'
		});
		return row;
	}

	const open = async (candidateId: string, signer: ReceiptSigner = federation) =>
		loadCatalogCard(database.db, {
			candidateId,
			companyId: (await createCompany(database.db)).id,
			pseudonym: 'k7q2x4m5n6p7r2s3t4v5w6x7yz',
			extras: [],
			now: new Date(),
			signer
		});

	it('names the stated region from the reference of regions beside its code', async () => {
		const stated = await open((await withResult('RU-TA')).id);
		expect(stated.card).toMatchObject({ region: 'RU-TA', regionName: 'Республика Татарстан' });
		const unstated = await open((await withResult()).id);
		expect(unstated.card).toMatchObject({ region: null, regionName: null });
		// Stored codes come from the same reference: a code outside it is a broken invariant, not a card without a name.
		await expect(open((await withResult('RU-XX')).id)).rejects.toThrow(/RU-XX .*reference of regions/u);
	});

	it('tells the receipts of the simulator of FSP apart from those of the federation', async () => {
		const person = await withResult();
		const simulated = await open(person.id, simulator);
		expect(simulated.receipts).toEqual([expect.objectContaining({ level: 'generalized', simulator: true })]);
		const federal = await open(person.id, federation);
		expect(federal.receipts).toEqual([expect.objectContaining({ level: 'generalized', simulator: false })]);
	});
});
