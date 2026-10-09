// The demo seed on a small world (docs/domain.md, sections 7.1, 12, 13.10, 19.2, 21, 23.3): candidates on real FSP
// competitions of the simulator through the survey, the declared grade and the seeded tests, companies with needs,
// shortlists and offers, vacancies, and the states the demo scenario starts from, all reached through the product's own
// actions and jobs. Every seeded record carries the batch id; a repeated seed, even of a batch whose
// completion was lost, adds nothing; a reset followed by a seed gives the same stand again.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { publishLegalDocuments, readLegalRelease } from '../../scripts/seed-legal';
import { publishPolicies, readPolicyRelease } from '../../scripts/seed-policies';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import { recommendedVacancies } from '$lib/server/candidates/vacancies';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	athleteLinks,
	candidateSurveys,
	candidates,
	companies,
	competitionPartnerships,
	consentEvents,
	emailTokens,
	hiringProcesses,
	hiringReports,
	invitations,
	invitationTerms,
	jobs,
	marketSnapshots,
	passwordCredentials,
	representations,
	sourceFacts,
	users,
	vacancies
} from '$lib/server/db/schema';
import { resetDemo } from '$lib/server/demo/reset';
import { batchId, publishedReconsents, releasedBanks, seedDemo, type SeedSummary } from '$lib/server/demo/seed';
import { readSeedData } from '$lib/server/demo/data';
import type { DemoServices } from '$lib/server/demo/services';
import { HttpAchievementsSource } from '$lib/server/fsp/adapter';
import { ServiceGrantIssuer } from '$lib/server/fsp/grant';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { handlerRegistry, type AnyJobHandler } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import type { JobType } from '$lib/server/jobs/registry';
import { startWorker } from '$lib/server/jobs/worker';
import type { MatchingModels } from '$lib/server/matching/semantic';
import type { ExtractResponse, ModelAdapter } from '$lib/server/ml/adapter';
import { fail, ok } from '$lib/server/ml/result';
import { readPartnerPool } from '$lib/server/partner-pool/pool';
import { openShortlist } from '$lib/server/shortlists/service';
import { PERIODIC_JOBS, periodicJobsFor } from '$lib/server/jobs/scheduler';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore, StoredObject } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { codePointLength, sliceByCodePoints } from '$lib/text/offsets';
import { getOwnVacancy } from '$lib/server/employer/vacancies';
import { vocabularyOf } from '$lib/server/employer/vocabulary';
import { loadVacancyTaxonomy } from '$lib/server/vacancies/taxonomy';
import { vacancyTestSpecOf } from '$lib/server/vacancies/test-spec';
import { DEFAULT_SEED } from '../../services/fsp-mock/src/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { releaseBankAhead } from '../helpers/demo-bank';
import { startParser, type StartedParser } from '../helpers/docparse';
import { modelsNotCalled, seedsWithParses } from '../helpers/demo-models';
import { exportParses, missingParses, type StoredParseEntry } from '../../scripts/demo-model-parses';
import { testEnvironment } from '../helpers/environment';
import { FSP_MOCK_CREDENTIALS, startFspMock, type FspMock } from '../helpers/fsp-mock';

const ROOT = new URL('../../', import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, ROOT));
const ATHLETES = 200;
const REDIS_DATABASE = 8;

// Modules the seed reaches read the configuration lazily; the environment points at this test's services.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

let database: TestDatabase;
let mock: FspMock;
let redis: Redis;
let services: DemoServices;

/** The bucket in memory: the seed uploads resumes, the parse reads them back, the reset removes them. */
class MemoryStore implements ObjectStore {
	readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
	put(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<void> {
		this.objects.set(key, { bytes, contentType });
		return Promise.resolve();
	}
	get(key: string): Promise<StoredObject | null> {
		const object = this.objects.get(key);
		if (!object) return Promise.resolve(null);
		const { bytes } = object;
		return Promise.resolve({
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				}
			}),
			sizeBytes: bytes.byteLength,
			contentType: object.contentType
		});
	}
	delete(key: string): Promise<void> {
		this.objects.delete(key);
		return Promise.resolve();
	}
	exists(key: string): Promise<boolean> {
		return Promise.resolve(this.objects.has(key));
	}
}

let parser: StartedParser;
/** The seed's log: the warning of the texts without a stored parse. */
const logLines: string[] = [];
const store = new MemoryStore();
const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});

beforeAll(async () => {
	parser = await startParser();
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(path('taxonomy'))));
		await publishLegalDocuments(client, await readLegalRelease(path('legal')));
		await publishPolicies(client, await readPolicyRelease(path('policies')));
	} finally {
		await client.end({ timeout: 5 });
	}
	await releaseBankAhead(database.db, 'backend');
	await releaseBankAhead(database.db, 'qa');
	mock = await startFspMock({ athletes: ATHLETES });
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
	Object.assign(
		env,
		testEnvironment({ DATABASE_URL: database.url, REDIS_URL: `${inject('redisUrl')}/${REDIS_DATABASE}` })
	);
	const credentials = FSP_MOCK_CREDENTIALS;
	services = {
		db: database.db,
		redis,
		crypto,
		store,
		parser: parser.client,
		models: modelsNotCalled,
		fsp: {
			source: new HttpAchievementsSource({ baseUrl: mock.origin, webhookSecret: credentials.webhookSecret }),
			grants: new ServiceGrantIssuer({
				issuer: mock.issuer,
				clientId: credentials.clientId,
				clientSecret: credentials.clientSecret,
				assertionSecret: credentials.assertionSecret
			}),
			signer: createReceiptSigner({ issuer: 'http://platform.test', keyId: 'test-1', seed: Buffer.alloc(32, 7) })
		},
		fspIdIssuer: mock.issuer,
		fspMockOrigin: mock.origin,
		settings: {
			candidates: 40,
			vacancies: 30,
			world: { seed: DEFAULT_SEED, athletes: ATHLETES },
			nightlyReset: true,
			review: false,
			seedModel: 'stored',
			fspMockControlToken: credentials.controlToken
		},
		appOrigin: 'http://localhost:57173',
		seedsDir: await seedsWithParses([]),
		log: createLogger({}, (_level, line) => logLines.push(line))
	};
}, 900_000);

afterAll(async () => {
	await mock.stop();
	redis.destroy();
	await Promise.all([database.drop(), parser.container.stop()]);
});

/** Rows of the tables the seed fills, to compare two states of the stand. */
async function census() {
	const tables = [
		'users',
		'candidates',
		'companies',
		'company_members',
		'vacancies',
		'athlete_links',
		'source_facts',
		'claims',
		'consent_events',
		'resume_documents',
		'candidate_surveys',
		'grade_declarations',
		'test_attempts',
		'grade_decisions',
		'candidate_categories',
		'hiring_needs',
		'shortlists',
		'shortlist_marks',
		'disclosures',
		'profile_experience_entries',
		'challenge_deliveries',
		'challenge_solutions',
		'applications',
		'confirmation_requests',
		'invitations',
		'invitation_terms',
		'hiring_processes',
		'hiring_reports',
		'assessment_objections',
		'representations',
		'competition_partnerships'
	];
	const counts: Record<string, number> = {};
	for (const table of tables) {
		const [row] = await database.sql<{ n: number }[]>`select count(*)::int as n from ${database.sql(table)}`;
		counts[table] = row?.n ?? 0;
	}
	return counts;
}

async function userByEmail(email: string) {
	const [row] = await database.db
		.select({ id: users.id, batch: users.seedBatchId })
		.from(users)
		.where(eq(users.emailHmac, crypto.lookupHmac('email', email)));
	if (!row) throw new Error(`no user ${email}`);
	return row;
}

async function candidateOf(email: string) {
	const user = await userByEmail(email);
	const [row] = await database.db.select().from(candidates).where(eq(candidates.userId, user.id));
	if (!row) throw new Error(`no candidate ${email}`);
	return row;
}

/** A hero's current resume as the parse and the extraction left it, with the claims read from it. */
async function resumeOf(email: string) {
	const candidate = await candidateOf(email);
	const [resume] = await database.sql<
		{
			mime: string;
			name: string;
			text: string;
			blocks: { id: string; kind: string; column: number | null; start: number; end: number }[];
			mode: string;
			failure: { code: string; details?: { reason?: string } } | null;
		}[]
	>`
		select f.detected_mime as mime, f.declared_name as name, e.text, e.blocks, m.processing_mode as mode, m.failure
		from resume_documents d
		join files f on f.id = d.file_id
		join document_extractions e on e.resume_document_id = d.id
		join ml_results m on m.operation = 'extract' and m.input_ref->>'id' = e.id::text
		where d.candidate_id = ${candidate.id} and d.is_current`;
	if (!resume) throw new Error(`${email} has no parsed and extracted resume`);
	const claims = await database.sql<
		{
			type: string;
			skill: string | null;
			extractor: string;
			quote: { block_id: string; start: number; end: number; text: string };
		}[]
	>`
		select claim_type as type, skill_key as skill, extractor, quote from claims
		where candidate_id = ${candidate.id} and status = 'active' and quote is not null`;
	return { ...resume, claims };
}

/** Every quote is the text of its block at its code point offsets. */
function expectQuotesInText(resume: Awaited<ReturnType<typeof resumeOf>>) {
	const blocks = new Map(resume.blocks.map((block) => [block.id, sliceByCodePoints(resume.text, block)]));
	expect(resume.claims.length).toBeGreaterThan(0);
	for (const { quote } of resume.claims) {
		expect(sliceByCodePoints(blocks.get(quote.block_id) ?? '', quote)).toBe(quote.text);
	}
}

const MODELS_OFF: MatchingModels = {
	embed: () => Promise.resolve(fail('disabled', 'embed: off', { reason: 'test' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: off', { reason: 'test' }))
};

let first: SeedSummary;
/** The warnings of the first seed about texts without a stored parse. */
let firstWarnings: string[] = [];
let before: Record<string, number>;

describe('nightly demo reset', () => {
	it('is scheduled for the coming night and only in demonstration mode', () => {
		const entry = PERIODIC_JOBS.find((job) => job.type === 'demo.reset');
		if (!entry) throw new Error('demo.reset is not a periodic job');
		expect(entry.due(new Date('2026-10-12T15:30:00Z'))).toEqual({
			payload: { kind: 'nightly', date: '2026-10-13' },
			inputVersion: '2026-10-13',
			runAfter: new Date('2026-10-13T00:00:00Z')
		});
		// The environment of this test has no DEMO_MODE: the worker does not schedule the reset.
		expect(periodicJobsFor(['demo.reset', 'market.refresh']).map((job) => job.type)).toEqual(['market.refresh']);
	});
});

describe('demo seed prerequisites', () => {
	it('names what the stand lacks before seeding anything, the storage policy of matches included', async () => {
		const empty = await createTestDatabase();
		try {
			await expect(seedDemo({ ...services, db: empty.db })).rejects.toThrow('product policy matching_policy');
			expect(await empty.db.select({ id: users.id }).from(users)).toEqual([]);
		} finally {
			await empty.drop();
		}
	});
});

describe('demo seed', () => {
	it('seeds the stand of the scenario through the product', { timeout: 300_000 }, async () => {
		const { db } = database;
		first = await seedDemo(services);
		firstWarnings = logLines.filter((line) => line.includes('demo seed: no stored model parse'));
		expect(first.status).toBe('seeded');
		expect(first.batch).toBe(
			batchId(
				await readSeedData(services.seedsDir),
				services.settings,
				await releasedBanks(services),
				await publishedReconsents(services)
			)
		);
		expect(first.counts.candidates).toBe(40);
		expect(first.counts.vacancies).toBeGreaterThanOrEqual(30);

		// Every seeded account, profile, company and vacancy carries the batch.
		for (const table of [users, candidates, companies, vacancies]) {
			const unlabelled = await db
				.select({ n: sql<number>`count(*)::int` })
				.from(table)
				.where(isNull(table.seedBatchId));
			expect(unlabelled[0]?.n).toBe(0);
		}

		// Nobody signs in to an account of the seed (visitors enter clones through /demo): none has a password.
		const withPassword = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(passwordCredentials)
			.innerJoin(users, eq(users.id, passwordCredentials.userId))
			.where(isNotNull(users.seedBatchId));
		expect(withPassword[0]?.n).toBe(0);

		// Achievements came from the simulator through the sync: the facts carry its dataset version.
		const facts = await db
			.select({ version: sourceFacts.sourceVersion })
			.from(sourceFacts)
			.where(eq(sourceFacts.source, 'fsp'));
		expect(facts.length).toBeGreaterThan(0);
		expect(new Set(facts.map((f) => f.version?.split('.')[0])).size).toBe(1);
		expect((await db.select().from(athleteLinks)).length).toBeGreaterThanOrEqual(first.counts.candidatesWithFsp);
		const [evidence] = await db.execute<{ n: number }>(
			sql`select count(*)::int as n from evidence_runs where status = 'published'`
		);
		expect(evidence?.n).toBeGreaterThan(0);
		const [matches] = await db.execute<{ n: number }>(sql`select count(*)::int as n from match_scores`);
		expect(matches?.n).toBeGreaterThan(0);
		expect(await db.select().from(marketSnapshots).limit(1)).toHaveLength(1);

		// Companies: the main employer and the partner verified, the third under review; the partner's competition.
		const statuses = await db
			.select({ name: companies.displayName, status: companies.status })
			.from(companies)
			.where(sql`${companies.displayName} in ('Северный код', 'Тёплый стек', 'Новая команда')`);
		expect(Object.fromEntries(statuses.map((c) => [c.name, c.status]))).toEqual({
			'Северный код': 'verified',
			'Тёплый стек': 'verified',
			'Новая команда': 'submitted'
		});
		const [partnership] = await db.select().from(competitionPartnerships);
		expect(partnership).toBeDefined();
		expect(await db.select().from(competitionPartnerships)).toHaveLength(1);
		// The partner's pool: finalists consented on their own screen, naming the partner open at that moment, and the
		// partner's recruiter reads each of them in the pool.
		const poolConsents = await db
			.select({
				candidateId: consentEvents.subjectCandidateId,
				action: consentEvents.action,
				signer: consentEvents.signerKind,
				choices: consentEvents.choices
			})
			.from(consentEvents)
			.where(eq(consentEvents.kind, 'partner_pool'));
		expect(poolConsents.length).toBeGreaterThan(0);
		for (const grant of poolConsents) {
			expect(grant).toMatchObject({
				action: 'grant',
				signer: 'subject',
				choices: { partner_company_ids: [partnership?.companyId] }
			});
		}
		const recruiter = await userByEmail('recruiter@teply-stek.example');
		const pool = await readPartnerPool(
			{
				db,
				models: MODELS_OFF,
				pseudonym: (candidateId, companyId) => crypto.pseudonym(candidateId, companyId),
				now: () => new Date(),
				testResults: GRADE_DECISION_RESULTS
			},
			await loadAccessSubject(db, {
				kind: 'session',
				userId: recruiter.id,
				sessionHash: 'demo-seed-test',
				authTime: new Date(),
				authMethod: 'password',
				csrfToken: ''
			}),
			partnership?.id ?? ''
		);
		expect(pool.members.map((member) => member.candidateId).sort()).toEqual(
			poolConsents.map((grant) => grant.candidateId).sort()
		);

		// The internship from 16 of the main employer.
		// The internship refers to the main employer's acceptance of the terms of work with minors.
		const [internship] = await db
			.select({
				minAge: vacancies.minAge,
				status: vacancies.status,
				acceptance: vacancies.minorTermsAcceptanceId,
				companyId: vacancies.companyId
			})
			.from(vacancies)
			.where(eq(vacancies.title, 'Стажёр frontend-разработки'));
		expect(internship).toMatchObject({ minAge: 16, status: 'published' });
		// Accepted by the owner on the company profile: the company refers to the version it accepted.
		const [minorTerms] = await database.sql<{ kind: string; companyId: string; referred: boolean }[]>`
			select l.kind, a.company_id as "companyId", c.minor_terms_document_id = a.document_id as referred
			from document_acceptances a
			join legal_documents l on l.id = a.document_id
			join companies c on c.id = a.company_id
			where a.id = ${internship?.acceptance ?? null}`;
		expect(minorTerms).toEqual({ kind: 'minor_employment_terms', companyId: internship?.companyId, referred: true });

		// The heroes' resumes are real PDF and DOCX files: parsed by docparse with their layout, read by the product's
		// extraction with a quote behind every claim. The heroes get the model's stored answer — `seeds/model-parses.json`
		// of the repository holds none for these texts here, so the rules read them under that reason and the seed names
		// their keys (tests/integration/demo-seed-parses.test.ts); background resumes are read by the rules.
		const stepan = await resumeOf('stepan.rodionov@fsp-career.example');
		expect(stepan).toMatchObject({ mime: 'application/pdf', name: 'Резюме Родионов Степан.pdf' });
		// Two columns: the sidebar and the experience are read column by column.
		expect(new Set(stepan.blocks.map((block) => block.column))).toEqual(new Set([1, 2]));
		const orlov = await resumeOf('dmitry.orlov@fsp-career.example');
		expect(orlov.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
		expect(orlov.blocks.filter((block) => block.kind === 'table_cell').length).toBeGreaterThanOrEqual(12);
		const petrov = await resumeOf('oleg.petrov@fsp-career.example');
		expect(petrov.mime).toBe('application/pdf');
		for (const [resume, skill] of [
			[stepan, 'go'],
			[orlov, 'kafka'],
			[petrov, 'fastapi']
		] as const) {
			expect(resume).toMatchObject({
				mode: 'rules_only',
				failure: { code: 'disabled', details: { reason: 'demo_seed_not_stored' } }
			});
			expectQuotesInText(resume);
			expect(resume.claims.every((claim) => claim.extractor === 'rules')).toBe(true);
			expect(resume.claims.map((claim) => claim.skill)).toContain(skill);
		}
		const background = await database.sql<{ reason: string; n: number }[]>`
			select m.failure->'details'->>'reason' as reason, count(*)::int as n from ml_results m
			join document_extractions e on m.input_ref->>'id' = e.id::text
			join resume_documents d on d.id = e.resume_document_id
			join candidates c on c.id = d.candidate_id
			join files f on f.id = d.file_id
			where m.operation = 'extract' and f.detected_mime like 'text/plain%'
			group by 1`;
		expect(background).toHaveLength(1);
		expect(background[0]?.reason).toBe('demo_seed_background');
		expect(background[0]?.n).toBeGreaterThan(0);

		// The heroes went through the survey, the declared grade and the seeded tests: К-1 confirmed Middle with the
		// margin, К-2 failed Senior and confirmed Middle below it, К-3 «не определено», К-5 confirmed Senior; К-4 has no
		// released test of her specialization and no survey.
		expect(first.tests?.open).toEqual(expect.arrayContaining(['backend', 'qa']));
		const testsOf = async (email: string) => {
			const candidate = await candidateOf(email);
			return database.sql<{ grade: string; outcome: string; confident: boolean; seeded: boolean }[]>`
				select a.grade, d.outcome, d.confident, a.seeded from test_attempts a
				join grade_decisions d on d.attempt_id = a.id and d.status = 'valid'
				where a.candidate_id = ${candidate.id} order by a.started_at`;
		};
		const category = async (email: string) => {
			const candidate = await candidateOf(email);
			return database.sql<{ specialization: string; grade: string }[]>`
				select specialization, grade from candidate_categories where candidate_id = ${candidate.id} and status = 'active'`;
		};
		expect(await testsOf('stepan.rodionov@fsp-career.example')).toEqual([
			{ grade: 'middle', outcome: 'confirmed', confident: true, seeded: true }
		]);
		expect(await category('stepan.rodionov@fsp-career.example')).toEqual([
			{ specialization: 'backend', grade: 'middle' }
		]);
		expect(await testsOf('dmitry.orlov@fsp-career.example')).toEqual([
			{ grade: 'senior', outcome: 'not_confirmed', confident: false, seeded: true },
			{ grade: 'middle', outcome: 'confirmed', confident: false, seeded: true }
		]);
		expect(await category('dmitry.orlov@fsp-career.example')).toEqual([{ specialization: 'backend', grade: 'middle' }]);
		expect(await testsOf('gleb.sokolov@fsp-career.example')).toEqual([
			{ grade: 'middle', outcome: 'undetermined', confident: false, seeded: true }
		]);
		expect(await category('gleb.sokolov@fsp-career.example')).toEqual([]);
		expect(await category('oleg.petrov@fsp-career.example')).toEqual([{ specialization: 'backend', grade: 'senior' }]);
		// К-6 holds two categories at once: Backend Middle and QA Middle, each confirmed by its own test after its own
		// survey and declaration — the policy of the grade counts each specialization apart.
		expect(await testsOf('anna.kovaleva@fsp-career.example')).toEqual([
			{ grade: 'middle', outcome: 'confirmed', confident: false, seeded: true },
			{ grade: 'middle', outcome: 'confirmed', confident: false, seeded: true }
		]);
		expect(
			(await category('anna.kovaleva@fsp-career.example')).sort((a, b) =>
				a.specialization.localeCompare(b.specialization)
			)
		).toEqual([
			{ specialization: 'backend', grade: 'middle' },
			{ specialization: 'qa', grade: 'middle' }
		]);
		const alisa = await candidateOf('alisa.zakharova@fsp-career.example');
		expect(await db.select().from(candidateSurveys).where(eq(candidateSurveys.candidateId, alisa.id))).toEqual([]);
		// Seeded attempts carry no code and run nothing in the sandbox.
		const [sandbox] = await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where type = 'test.run'`);
		expect(sandbox?.n).toBe(0);
		expect(first.counts.decisions.confirmed).toBeGreaterThan(0);
		expect(first.counts.decisions.not_confirmed).toBeGreaterThan(0);

		// К-5: the main employer's need, its shortlist, the offer from it accepted with the contacts disclosed.
		const oleg = await candidateOf('oleg.petrov@fsp-career.example');
		const [accepted] = await db.select().from(invitations).where(eq(invitations.candidateId, oleg.id));
		expect(accepted?.status).toBe('accepted');
		expect(accepted?.needId).not.toBeNull();
		const [opened] = await database.sql<{ n: number }[]>`
			select count(*)::int as n from disclosures where invitation_id = ${accepted?.id ?? null}`;
		expect(opened?.n).toBeGreaterThan(0);
		const [terms] = await db
			.select({ whyYou: invitationTerms.whyYou })
			.from(invitationTerms)
			.where(eq(invitationTerms.invitationId, accepted?.id ?? ''));
		expect(JSON.stringify(terms?.whyYou)).toContain('test_block');
		// К-1 is marked in that shortlist and waits for the offer the visitor sends on stage.
		const stepanProfile = await candidateOf('stepan.rodionov@fsp-career.example');
		const [marked] = await database.sql<{ n: number }[]>`
			select count(*)::int as n from shortlist_marks where candidate_id = ${stepanProfile.id}`;
		expect(marked?.n).toBe(1);
		expect(await db.select().from(invitations).where(eq(invitations.candidateId, stepanProfile.id))).toEqual([]);
		// The main employer's call waits for К-1 unanswered — he sends his approach on stage — while background
		// candidates answered it; К-1 applied nowhere, so the main employer holds none of his contacts before the offer
		// of the stage, and was asked to confirm a block.
		const [contacts] = await database.sql<
			{
				company: string;
				delivered: number;
				solutions: number;
				others: number;
				applications: number;
				requests: number;
			}[]
		>`
			select (select c.display_name from company_challenges h join companies c on c.id = h.company_id) as company,
				(select count(*)::int from challenge_deliveries where candidate_id = ${stepanProfile.id}) as delivered,
				(select count(*)::int from challenge_solutions s join challenge_deliveries d on d.id = s.delivery_id
					where d.candidate_id = ${stepanProfile.id}) as solutions,
				(select count(*)::int from challenge_solutions) as others,
				(select count(*)::int from applications where candidate_id = ${stepanProfile.id}) as applications,
				(select count(*)::int from confirmation_requests where candidate_id = ${stepanProfile.id}) as requests`;
		expect(contacts).toMatchObject({
			company: 'Северный код',
			delivered: 1,
			solutions: 0,
			applications: 0,
			requests: 1
		});
		expect(contacts?.others).toBeGreaterThan(0);
		// К-2 applied to the vacancy of the payment gateway: the main employer's applications are not empty before the stage.
		const dmitryProfile = await candidateOf('dmitry.orlov@fsp-career.example');
		const [gatewayApplication] = await database.sql<{ title: string }[]>`
			select v.title from applications a join vacancies v on v.id = a.vacancy_id where a.candidate_id = ${dmitryProfile.id}`;
		expect(gatewayApplication?.title).toBe('Middle Go-разработчик (платёжный шлюз)');

		// The shortlist of the scenario's need: on top the group that closes every required skill, К-1 and К-6 in it, and
		// a claim of the resume to check at the interview — Kafka of К-2.
		const severny = await userByEmail('recruiter@severny-kod.example');
		const severnySubject = await loadAccessSubject(db, {
			kind: 'session',
			userId: severny.id,
			sessionHash: 'demo-seed-test',
			authTime: new Date(),
			authMethod: 'password',
			csrfToken: ''
		});
		const [scenarioShortlist] = await database.sql<{ id: string }[]>`
			select s.id from shortlists s join hiring_needs n on n.id = s.need_id join companies c on c.id = n.company_id
			where c.display_name = 'Северный код' order by s.created_at limit 1`;
		const shortlist = await openShortlist(
			{
				db,
				models: MODELS_OFF,
				pseudonym: (candidateId, companyId) => crypto.pseudonym(candidateId, companyId),
				now: () => new Date(),
				testResults: GRADE_DECISION_RESULTS
			},
			severnySubject,
			scenarioShortlist?.id ?? '',
			{ limit: 100 }
		);
		expect(shortlist.groups.covers).toBeGreaterThan(0);
		const annaProfile = await candidateOf('anna.kovaleva@fsp-career.example');
		const groupOf = (candidateId: string) =>
			shortlist.items.find((item) => item.candidateId === candidateId)?.needMatch.coverage.group;
		expect(groupOf(stepanProfile.id)).toBe('covers');
		expect(groupOf(annaProfile.id)).toBe('covers');
		expect(shortlist.items.find((item) => item.candidateId === dmitryProfile.id)?.needMatch.toVerify).toContain(
			'kafka'
		);

		// К-6, a Python Middle without offers, finds a published vacancy of her profile with the main employer on the
		// first page of her vacancies: its requirements are covered by what her tests confirmed, not by her survey.
		const [payouts] = await db
			.select({ id: vacancies.id, status: vacancies.status })
			.from(vacancies)
			.where(eq(vacancies.title, 'Middle Python-разработчик (сервис выплат партнёрам)'));
		expect(payouts?.status).toBe('published');
		const anna = await userByEmail('anna.kovaleva@fsp-career.example');
		const annaVacancies = await recommendedVacancies(
			{ db },
			await loadAccessSubject(db, {
				kind: 'session',
				userId: anna.id,
				sessionHash: 'demo-seed-test',
				authTime: new Date(),
				authMethod: 'password',
				csrfToken: ''
			}),
			{}
		);
		const payoutsMatch = annaVacancies.items.find((item) => item.vacancyId === payouts?.id)?.match;
		expect(payoutsMatch?.components.required.value).toBe(1);
		expect(payoutsMatch?.components.grade.value).toBe(1);
		// The three written vacancies show their test: the block tests their texts add; Data Science is not released here.
		const taxonomy = await loadVacancyTaxonomy(db);
		const testOf = async (title: string) => {
			const [row] = await db
				.select({ id: vacancies.id, companyId: vacancies.companyId })
				.from(vacancies)
				.where(eq(vacancies.title, title));
			if (!row) throw new Error(`vacancy ${title} is not seeded`);
			const vacancy = await getOwnVacancy(db, row.companyId, row.id, new Date());
			const spec = await vacancyTestSpecOf(db, vacancy, await vocabularyOf(db, vacancy.taxonomyVersionId), taxonomy);
			return spec.plans.map((plan) =>
				plan.status === 'open' ? plan.vacancyBlocks.map((block) => block.block) : plan.reason
			);
		};
		expect(await testOf('Middle Java-разработчик (биллинг подписок)')).toEqual([['be.api']]);
		expect(await testOf('Junior QA-инженер (автотесты API)')).toEqual([['qa.auto', 'qa.api']]);
		expect(await testOf('Data Scientist (прогноз спроса)')).toEqual(['not_released', 'not_released']);
		// К-2: an offer of the company under review, unanswered.
		const dmitry = await candidateOf('dmitry.orlov@fsp-career.example');
		const [unverified] = await db
			.select({ status: invitations.status, company: companies.status })
			.from(invitations)
			.innerJoin(companies, eq(companies.id, invitations.companyId))
			.where(eq(invitations.candidateId, dmitry.id));
		expect(unverified).toEqual({ status: 'sent', company: 'submitted' });
		// The funnel of the background: offers from the shortlists of the needs (on a small world — a handful; every
		// status shows on the stand's thousand).
		const offers = Object.values(first.counts.invitations).reduce((sum, n) => sum + n, 0);
		expect(offers).toBeGreaterThan(2);
		expect(first.counts.needs).toBeGreaterThan(2);

		// К-4: the representative confirmed the address and waits for the operator; the profile is hidden.
		const eva = await candidateOf('alisa.zakharova@fsp-career.example');
		expect(eva.visibility).toBe('hidden');
		expect(
			(
				await db
					.select({ status: representations.status })
					.from(representations)
					.where(eq(representations.candidateId, eva.id))
			).map((r) => r.status)
		).toEqual(['contact_confirmed']);
		// Another minor's representative is verified: that minor shows the profile for internships.
		const verified = await db
			.select({ candidateId: representations.candidateId })
			.from(representations)
			.where(eq(representations.status, 'authority_verified'));
		expect(verified).toHaveLength(1);
		const [minor] = await db
			.select()
			.from(candidates)
			.where(eq(candidates.id, verified[0]?.candidateId ?? ''));
		expect(minor?.visibility).toBe('catalog');
		// The representatives sign by the link of the letter that follows the operator's check, as a person does; the
		// unverified one of К-4 signs nothing.
		const signatures = await db
			.select({
				candidateId: consentEvents.subjectCandidateId,
				kind: consentEvents.kind,
				method: consentEvents.method,
				evidence: consentEvents.evidence
			})
			.from(consentEvents)
			.where(eq(consentEvents.signerKind, 'representative'));
		expect(signatures.map((s) => [s.candidateId, s.kind, s.method]).sort()).toEqual(
			[
				[minor?.id, 'catalog_visibility', 'email_link'],
				[minor?.id, 'pd_processing', 'email_link']
			].sort()
		);
		for (const signature of signatures) expect(signature.evidence).toHaveProperty('email_token_id');
		const [link] = await db
			.select({ usedAt: emailTokens.usedAt })
			.from(emailTokens)
			.where(eq(emailTokens.purpose, 'representative_consent'));
		expect(link?.usedAt).not.toBeNull();

		// Hiring: processes on several stages, one with outcomes the sides reported differently; revoked consents.
		const processes = await db.select({ id: hiringProcesses.id }).from(hiringProcesses);
		expect(processes.length).toBeGreaterThanOrEqual(2);
		const outcomes = await db
			.select({ process: hiringReports.processId, party: hiringReports.party, outcome: hiringReports.outcome })
			.from(hiringReports)
			.where(eq(hiringReports.kind, 'outcome'));
		const byProcess = Map.groupBy(outcomes, (report) => report.process);
		const diverged = [...byProcess.values()].filter(
			(reports) =>
				reports.some((r) => r.party === 'company' && r.outcome === 'hired') &&
				reports.some((r) => r.party === 'candidate' && r.outcome === 'not_hired')
		);
		expect(diverged).toHaveLength(1);
		before = await census();
	});

	it('changes nothing when repeated, also after its completion record is lost', { timeout: 300_000 }, async () => {
		const again = await seedDemo(services);
		expect(again.status).toBe('already_seeded');
		expect(await census()).toEqual(before);

		// A seed stopped before its end has no completion record: it goes through every step and finds them done.
		await database.sql.begin(async (tx) => {
			await tx`set local role fsp_retention`;
			await tx`delete from audit_events where action = 'demo.seeded'`;
		});
		const resumed = await seedDemo(services);
		expect(resumed.status).toBe('seeded');
		expect(resumed.batch).toBe(first.batch);
		expect(await census()).toEqual(before);
	});

	it('gives the same stand after a reset', { timeout: 300_000 }, async () => {
		const reset = await resetDemo(
			{
				db: database.db,
				redis,
				store,
				fspMock: { origin: mock.origin, controlToken: FSP_MOCK_CREDENTIALS.controlToken }
			},
			{ requestId: 'demo-seed-test', trigger: 'manual' }
		);
		expect(reset.filesRemoved).toBeGreaterThan(0);
		expect(store.objects.size).toBe(0);
		expect((await census()).users).toBe(0);

		// A worker of the stand runs the same types all through the seed: the seed's jobs are not its to take. Its own
		// schedule (the market snapshot of the day) is its own.
		const chain: JobType[] = [
			'fsp.sync',
			'resume.parse',
			'resume.extract',
			'evidence.compute',
			'match.refresh',
			'company.registry_lookup',
			'market.refresh'
		];
		const taken: string[] = [];
		const trap = (type: JobType): AnyJobHandler => ({
			type,
			concurrency: 4,
			run: ({ job }) => {
				taken.push(job.id);
				return Promise.resolve({ isCurrent: () => Promise.resolve(true), write: () => Promise.resolve() });
			}
		});
		const stand = startWorker({
			db: database.db,
			handlers: handlerRegistry(chain.map(trap)),
			types: chain,
			pollIntervalMs: 50,
			log: createLogger({}, () => {})
		});
		let again: SeedSummary;
		try {
			again = await seedDemo(services);
		} finally {
			await stand.stop();
		}
		const takenFromSeed = await database.db
			.select({ type: jobs.type, createdBy: jobs.createdBy })
			.from(jobs)
			.where(and(inArray(jobs.id, taken), sql`${jobs.createdBy}->>'id' is distinct from 'scheduler'`));
		expect(takenFromSeed).toEqual([]);
		expect(again.status).toBe('seeded');
		expect(again.batch).toBe(first.batch);
		expect(await census()).toEqual(before);
		// Nothing of the seed's line is left waiting for a worker that will never come.
		expect(
			await database.db
				.select({ id: jobs.id })
				.from(jobs)
				.where(and(eq(jobs.owner, 'demo_seed'), inArray(jobs.status, ['queued', 'running'])))
		).toEqual([]);
	});
});

describe('the model parses of the demo seed (seeds/model-parses.json)', () => {
	const reset = () =>
		resetDemo(
			{
				db: database.db,
				redis,
				store,
				fspMock: { origin: mock.origin, controlToken: FSP_MOCK_CREDENTIALS.controlToken }
			},
			{ requestId: 'demo-seed-test', trigger: 'manual' }
		);

	/** A model that answers every reading with the first block quoted, and counts what reached it. */
	function countingModel() {
		const calls = { adapter: 0, extract: 0 };
		const extract: ModelAdapter['extract'] = (request) => {
			calls.extract++;
			const [block] = request.blocks;
			if (!block) throw new Error('a reading without blocks');
			const quote = { blockId: block.id, start: 0, end: codePointLength(block.text), text: block.text };
			const answer: ExtractResponse<unknown> = {
				model: { modelId: 'test-model', modelRevision: 'r1', runtime: 'api', params: { temperature: 0 } },
				items:
					request.schemaVersion === 'resume-extract/v3'
						? [
								{
									kind: 'achievement_mention',
									group: null,
									rawText: block.text,
									polarity: 'asserted',
									modelPolarity: 'asserted',
									periodFrom: null,
									periodTo: null,
									organization: null,
									level: null,
									quote
								}
							]
						: [],
				rejected: [{ item: { raw_text: 'Haskell' }, reason: 'quote_not_found' }],
				attempts: 1,
				latencyMs: 5
			};
			return Promise.resolve(ok(answer) as Awaited<ReturnType<ModelAdapter['extract']>>);
		};
		const models = () => {
			calls.adapter++;
			return { extract, extractModelKey: () => 'api:test-model' };
		};
		return { calls, models };
	}

	/** The readings of the heroes' resumes and of the scenario needs, as `ml_results` keeps them. */
	async function readings() {
		return database.sql<
			{ type: string; mode: string; model: Record<string, unknown> | null; output: unknown; reason: string | null }[]
		>`
			select m.input_ref->>'type' as type, m.processing_mode as mode, m.model, m.output,
				m.failure->'details'->>'reason' as reason
			from ml_results m
			left join document_extractions e on e.id::text = m.input_ref->>'id'
			left join resume_documents d on d.id = e.resume_document_id
			left join candidates c on c.id = d.candidate_id
			where m.operation = 'extract' and (c.demo_original or m.input_ref->>'type' = 'hiring_need')
				and (m.input_ref->>'type' <> 'hiring_need' or m.failure->>'reason' is distinct from 'demo_seed_background')
			order by 1, m.input_sha256`;
	}

	it('reads a text without a stored parse by the rules, without the model, and names its key', () => {
		// The first seed of this file: the copy of seeds/ stores no parse. Three heroes have a resume; two scenario needs.
		expect(first.parses).toMatchObject({ stored: 0, live: 0 });
		expect(first.parses?.missing).toHaveLength(5);
		expect(first.parses?.missing.filter((key) => key.startsWith('resume-extract/v3:'))).toHaveLength(3);
		// One line for the whole seed, naming every key.
		expect(firstWarnings).toHaveLength(1);
		for (const key of first.parses?.missing ?? []) expect(firstWarnings[0]).toContain(key);
	});

	let exported: StoredParseEntry[] = [];

	it('calls the model only when told to, and the stand keeps its answer', { timeout: 300_000 }, async () => {
		await reset();
		const model = countingModel();
		const live = await seedDemo({
			...services,
			models: model.models,
			settings: { ...services.settings, seedModel: 'live' }
		});
		expect(live.parses).toEqual({ stored: 0, live: 5, missing: [] });
		expect(model.calls.extract).toBe(5);
		const rows = await readings();
		expect(rows).toHaveLength(5);
		for (const row of rows) {
			expect(row.mode).toBe('model');
			expect(row.model).toMatchObject({ model_id: 'test-model', runtime: 'api' });
			expect(row.model).not.toHaveProperty('origin');
			expect(row.output).not.toBeNull();
		}

		const { file, added } = await exportParses(database.sql, { description: 'test', parses: [] }, services.seedsDir);
		expect(added).toHaveLength(5);
		expect(new Set(file.parses.map((entry) => entry.about))).toEqual(
			new Set([
				'resume «Резюме Родионов Степан.pdf»',
				expect.stringMatching(/^resume «.+\.docx»$/),
				expect.stringMatching(/^resume «.+\.pdf»$/),
				'need severny_kod.payments_backend',
				'need novaya_komanda.go_middle'
			])
		);
		exported = file.parses;
	});

	it('gives the stored answers again without a call, marked stored', { timeout: 300_000 }, async () => {
		expect(exported).toHaveLength(5);
		const seedsDir = await seedsWithParses([]);
		await writeFile(`${seedsDir}/model-parses.json`, JSON.stringify({ description: 'test', parses: exported }));
		await reset();
		logLines.length = 0;
		const model = countingModel();
		const replay = await seedDemo({ ...services, seedsDir, models: model.models });
		expect(replay.parses).toEqual({ stored: 5, live: 0, missing: [] });
		expect(model.calls).toEqual({ adapter: 0, extract: 0 });
		expect(logLines.filter((line) => line.includes('demo seed: no stored model parse'))).toEqual([]);
		const rows = await readings();
		expect(rows).toHaveLength(5);
		const outputs = new Set(exported.map((entry) => JSON.stringify(entry.output)));
		for (const row of rows) {
			expect(row.mode).toBe('model');
			expect(row.model).toMatchObject({ model_id: 'test-model', model_revision: 'r1', origin: 'stored' });
			expect(outputs.has(JSON.stringify(row.output))).toBe(true);
		}
		expect(await missingParses(database.sql, { description: 'test', parses: exported }, seedsDir)).toEqual({
			missing: [],
			unseededNeeds: []
		});
	});
});
