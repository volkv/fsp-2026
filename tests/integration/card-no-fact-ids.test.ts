// What a company receives about a catalog candidate — the data of its cabinet pages as SvelteKit serializes them and
// the answer of the API — carries no id of the candidate's facts (docs/domain.md, 9.6, 14): fact ids are the same for
// every company and would link the pseudonyms of one person across companies. The check runs the routes as they run
// and looks for every fact id of the candidate in the database, not for a field name.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { Actor } from '$lib/server/access/actor';
import {
	categorizationRulesets,
	categorizationRuns,
	categoryAssignments,
	consentEvents,
	productPolicies,
	skillInferences,
	sourceFacts,
	taxonomyVersions
} from '$lib/server/db/schema';
import type { Competition, Result } from '$lib/server/fsp/types';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	randomSha256
} from '../helpers/factories';

// The routes read `config()`: its environment points at this file's database once it exists.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const { closeDb } = await import('$lib/server/db');
const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { testEnvironment } = await import('../helpers/environment');
const { load: catalogPage } = await import('../../src/routes/(app)/company/(member)/candidates/+page.server');
const { load: cardPage } = await import('../../src/routes/(app)/company/(member)/candidates/[pseudonym]/+page.server');
const { load: vacancyCatalogPage } =
	await import('../../src/routes/(app)/company/(member)/vacancies/[id]/candidates/+page.server');
const { load: vacancyCardPage } =
	await import('../../src/routes/(app)/company/(member)/vacancies/[id]/candidates/[pseudonym]/+page.server');
const { GET: cardApi } = await import('../../src/routes/api/v1/candidates/[pseudonym]/+server');

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;

let database: TestDatabase;
let taxonomyVersionId: string;
let documents: Record<'pd' | 'catalog', string>;

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl') }));
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const { db } = database;
	const [version] = await db.select({ id: taxonomyVersions.id }).from(taxonomyVersions);
	if (!version) throw new Error('taxonomy not published');
	taxonomyVersionId = version.id;
	const published = { publishedAt: new Date(Date.now() - 10 * DAY) };
	documents = {
		pd: (await createPublishedDocument(db, 'pd_processing', published)).id,
		catalog: (await createPublishedDocument(db, 'catalog_visibility', published)).id
	};
	await db.insert(productPolicies).values({
		kind: 'catalog_policy',
		version: 1,
		params: { small_count_threshold: 1 },
		effectiveFrom: new Date(Date.now() - 10 * DAY)
	});
});

afterAll(async () => {
	await closeDb();
	await database.drop();
});

const session = (userId: string): Actor => ({
	kind: 'session',
	userId,
	sessionHash: randomSha256(),
	authTime: new Date(),
	authMethod: 'password',
	csrfToken: 'csrf'
});

async function employer() {
	const { db } = database;
	const company = await createCompany(db, { status: 'verified' });
	const owner = await createMember(db, company.id);
	if (!owner.userId) throw new Error('member without user');
	const vacancy = await createOwnVacancy(
		db,
		{ companyId: company.id, memberId: owner.id, taxonomyVersionId },
		{
			description: 'Разработка сервисов расчёта рейтингов соревнований',
			textCheck: {
				validator_version: 'test',
				phrases: [],
				result: 'clean',
				warnings_confirmed: null,
				moderation: null
			},
			employmentForm: 'full',
			contractTypes: ['labor'],
			requiredSkillKeys: ['go']
		}
	);
	return { company, vacancy, actor: session(owner.userId) };
}

function competitionResult(title: string, discipline: Competition['discipline'], startDate: string) {
	const competitionId = `c-${randomBytes(3).toString('hex')}`;
	const payload: { result: Result; competition: Competition } = {
		result: { id: `r-${randomBytes(3).toString('hex')}`, competitionId, place: 2, award: 'prize', status: 'official' },
		competition: {
			id: competitionId,
			ekpNumber: null,
			title,
			discipline,
			level: 'russian_championship',
			startDate,
			online: false
		}
	};
	return payload;
}

/** An adult candidate in the catalog with a published category and two FSP results. */
async function catalogCandidate() {
	const { db } = database;
	const candidate = await createCandidate(db, {
		birthDate: '1998-04-10',
		visibility: 'catalog',
		profileRevision: 1,
		preferences: { work_formats: ['remote'], region_code: 'RU-MOW' }
	});
	const occurredAt = new Date(Date.now() - DAY);
	await db.insert(consentEvents).values(
		(['pd_processing', 'catalog_visibility'] as const).map((kind) => ({
			subjectCandidateId: candidate.id,
			kind,
			documentId: kind === 'pd_processing' ? documents.pd : documents.catalog,
			action: 'grant' as const,
			signerKind: 'subject' as const,
			signerUserId: candidate.userId,
			method: 'separate_screen_button' as const,
			evidence: {},
			occurredAt
		}))
	);
	const facts = await db
		.insert(sourceFacts)
		.values(
			[
				competitionResult('Чемпионат России по программированию', 'algorithmic', '2025-10-01'),
				competitionResult('Кубок России по продуктовому программированию', 'product', '2024-11-12')
			].map((payload) => ({
				candidateId: candidate.id,
				source: 'fsp' as const,
				factType: 'competition_result' as const,
				sourceRecordRef: `fsp:result:${payload.result.id}`,
				eventKey: `fsp:competition:${payload.competition.id}`,
				trustLevel: 'fsp_verified' as const,
				ownershipBasis: 'operator_confirmed' as const,
				payload,
				payloadSha256: randomSha256(),
				sourceSnapshotSha256: randomSha256(),
				observedAt: occurredAt,
				lastVerifiedAt: occurredAt,
				status: 'active' as const
			}))
		)
		.returning({ id: sourceFacts.id });
	const factIds = facts.map((fact) => fact.id);

	const [ruleset] = await db.select({ id: categorizationRulesets.id }).from(categorizationRulesets);
	if (!ruleset) throw new Error('no categorization rule set');
	const [run] = await db
		.insert(categorizationRuns)
		.values({
			candidateId: candidate.id,
			inputRevision: 1,
			inputSnapshotSha256: randomSha256(),
			inputRefs: { facts: factIds, claims: [] },
			taxonomyVersionId,
			rulesetId: ruleset.id,
			asOf: occurredAt,
			computedAt: occurredAt,
			origin: 'automatic',
			outcome: 'partial',
			missing: { role: [], grade: [{ code: 'role_experience_missing' }], stack: [] },
			experienceSummary: {
				total: { min_months: 0, max_months: 0 },
				by_role: {},
				by_skill: {},
				counted_entry_ids: [],
				excluded: []
			},
			status: 'published'
		})
		.returning();
	if (!run) throw new Error('run not inserted');
	await db.insert(skillInferences).values({
		runId: run.id,
		candidateId: candidate.id,
		skillKey: 'go',
		strength: '0.800',
		strengthBand: 'strong',
		attestation: 'direct',
		badgeTrust: 'fsp_verified',
		contributions: factIds.map((id) => ({ fact_id: id, attestation: 'direct' }))
	});
	await db.insert(categoryAssignments).values({
		runId: run.id,
		rank: 'primary',
		roleStatus: 'established',
		roleKey: 'backend',
		score: '0.8',
		gradeStatus: 'insufficient_data',
		stackStatus: 'established',
		stackSkillKeys: ['go'],
		explanation: {
			ruleset_version: 1,
			taxonomy_version: 'test',
			role: {
				role_key: 'backend',
				score: 0.8,
				skill_fit: 0.8,
				role_evidence: 0.8,
				core_groups: [],
				unconfirmed_core_groups: [],
				contributions: factIds.map((id) => ({ fact_id: id }))
			},
			grade: {
				status: 'insufficient_data',
				scope: 'role',
				signals: [],
				ignored: [{ code: 'fsp_result_not_grade_signal', fact_ids: factIds }],
				disagreements: [],
				missing: [{ code: 'role_experience_missing' }],
				next_grade: null
			},
			stack: { status: 'established', skills: [], missing: [] },
			desired_roles: [],
			fsp_markers: []
		}
	});
	return candidate;
}

let requests = 0;

/** The event of a request of a signed-in member, as the hooks leave it for a route. */
function event(actor: Actor, path: string, params: Record<string, string>) {
	const url = new URL(`http://localhost:57173${path}`);
	return {
		url,
		params,
		request: new Request(url),
		locals: { requestId: `req-${++requests}`, actor },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {}
	};
}

type Load = (event: never) => unknown;
const run = async (load: Load, input: ReturnType<typeof event>) => JSON.stringify(await load(input as never));

describe('fact ids in what a company receives', () => {
	it('are absent from the card and catalog pages and from the API card, for every company', async () => {
		const person = await catalogCandidate();
		const factIds = (
			await database.db.select({ id: sourceFacts.id }).from(sourceFacts).where(eq(sourceFacts.candidateId, person.id))
		).map((fact) => fact.id);
		expect(factIds).toHaveLength(2);

		for (const { company, vacancy, actor } of [await employer(), await employer()]) {
			const pseudonym = fieldCrypto().pseudonym(person.id, company.id);
			const answers: Record<string, string> = {
				card: await run(cardPage, event(actor, `/company/candidates/${pseudonym}`, { pseudonym })),
				vacancyCard: await run(
					vacancyCardPage,
					event(actor, `/company/vacancies/${vacancy.id}/candidates/${pseudonym}`, { id: vacancy.id, pseudonym })
				),
				catalog: await run(catalogPage, event(actor, '/company/candidates', {})),
				vacancyCatalog: await run(
					vacancyCatalogPage,
					event(actor, `/company/vacancies/${vacancy.id}/candidates`, { id: vacancy.id })
				),
				api: await (await cardApi(event(actor, `/api/v1/candidates/${pseudonym}`, { pseudonym }) as never)).text()
			};
			for (const [name, text] of Object.entries(answers)) {
				for (const id of [...factIds, person.id]) expect(text, `${name} carries ${id}`).not.toContain(id);
			}
			// The pages and the API do show the candidate, the achievements and the company's receipts.
			for (const [name, text] of Object.entries(answers)) expect(text, name).toContain(pseudonym);
			for (const name of ['card', 'vacancyCard', 'api']) {
				expect(answers[name], name).toContain('russian_championship');
				expect(answers[name], name).toMatch(/"receipt_?[Hh]andles":\["[a-z0-9]+/u);
			}
		}
	});
});
