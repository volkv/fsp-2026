// The demo seed on a small world (docs/domain.md, sections 7.1, 12.5, 19.2, 21): candidates on real FSP competitions of
// the simulator, companies and vacancies, and the states the demo scenario starts from, all reached through the
// product's own actions and jobs. Every seeded record carries the batch id; a repeated seed, even of a batch whose
// completion was lost, adds nothing; a reset followed by a seed gives the same stand again.
import { fileURLToPath } from 'node:url';
import { eq, isNotNull, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { publishLegalDocuments, readLegalRelease } from '../../scripts/seed-legal';
import { publishPolicies, readPolicyRelease } from '../../scripts/seed-policies';
import { readAssessmentBank } from '$lib/server/assessments/bank';
import { publishAssessmentBank } from '$lib/server/assessments/publish';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	athleteLinks,
	candidates,
	categoryDisputes,
	companies,
	competitionPartnerships,
	consentEvents,
	emailTokens,
	hiringProcesses,
	hiringReports,
	invitations,
	invitationTerms,
	marketSnapshots,
	passwordCredentials,
	representations,
	sourceFacts,
	users,
	vacancies,
	vacancyPostings
} from '$lib/server/db/schema';
import { resetDemo } from '$lib/server/demo/reset';
import { batchId, seedDemo, type SeedSummary } from '$lib/server/demo/seed';
import { QUIZ_SKILLS, readSeedData } from '$lib/server/demo/data';
import type { DemoServices } from '$lib/server/demo/services';
import { HttpAchievementsSource } from '$lib/server/fsp/adapter';
import { ServiceGrantIssuer } from '$lib/server/fsp/grant';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { createLogger } from '$lib/server/jobs/log';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { fail } from '$lib/server/ml/result';
import { readPartnerPool } from '$lib/server/partner-pool/pool';
import { PERIODIC_JOBS, periodicJobsFor } from '$lib/server/jobs/scheduler';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore, StoredObject } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { sliceByCodePoints } from '$lib/text/offsets';
import { DEFAULT_SEED } from '../../services/fsp-mock/src/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { startParser, type StartedParser } from '../helpers/docparse';
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
		await publishAssessmentBank(client, await readAssessmentBank(path('assessments')));
	} finally {
		await client.end({ timeout: 5 });
	}
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
			fspMockControlToken: credentials.controlToken
		},
		appOrigin: 'http://localhost:57173',
		seedsDir: path('seeds'),
		log: createLogger({}, () => undefined)
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
		'vacancy_postings',
		'athlete_links',
		'source_facts',
		'claims',
		'consent_events',
		'resume_documents',
		'assessment_attempts',
		'invitations',
		'invitation_terms',
		'hiring_processes',
		'hiring_reports',
		'category_disputes',
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
let before: Record<string, number>;

describe('nightly demo reset', () => {
	it('is scheduled for the coming night and only in demonstration mode', () => {
		const entry = PERIODIC_JOBS.find((job) => job.type === 'demo.reset');
		if (!entry) throw new Error('demo.reset is not a periodic job');
		expect(entry.due(new Date('2026-10-12T15:30:00Z'))).toEqual({
			payload: { date: '2026-10-13' },
			inputVersion: '2026-10-13',
			runAfter: new Date('2026-10-13T00:00:00Z')
		});
		// The environment of this test has no DEMO_MODE: the worker does not schedule the reset.
		expect(periodicJobsFor(['demo.reset', 'market.refresh']).map((job) => job.type)).toEqual(['market.refresh']);
	});
});

describe('demo seed prerequisites', () => {
	it('knows every quiz of the bank, so candidates of any stack with a quiz take one', async () => {
		const bank = await readAssessmentBank(path('assessments'));
		const quizSkills = bank.filter((entry) => entry.kind === 'quiz').flatMap((entry) => entry.skillKeys);
		expect([...QUIZ_SKILLS].sort()).toEqual(quizSkills.sort());
	});

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
		expect(first.status).toBe('seeded');
		expect(first.batch).toBe(batchId(await readSeedData(path('seeds')), services.settings));
		expect(first.counts.candidates).toBe(40);
		expect(first.counts.vacancies).toBeGreaterThanOrEqual(25);

		// Every seeded account, profile, company, vacancy and posting carries the batch.
		for (const table of [users, candidates, companies, vacancies, vacancyPostings]) {
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
		const [category] = await db.execute<{ n: number }>(
			sql`select count(*)::int as n from categorization_runs where status = 'published'`
		);
		expect(category?.n).toBeGreaterThan(0);
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
				now: () => new Date()
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

		// The internship from 16 of the main employer and the external listing with duplicates clustered.
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
		const [clustered] = await db.execute<{ n: number }>(
			sql`select count(*)::int as n from (select vacancy_id from vacancy_postings group by vacancy_id having count(*) > 1) c`
		);
		expect(clustered?.n).toBeGreaterThan(0);

		// The heroes' resumes are real PDF and DOCX files: parsed by docparse with their layout, read by the product's
		// extraction with a quote behind every claim. The heroes go to the model adapter — without a configured model it
		// answers why, and the result is the rules' one under that reason; background resumes are read by the rules.
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
				failure: { code: 'disabled', details: { reason: 'not_configured' } }
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

		// К-5: an open invitation of the main employer; К-2: the first offer accepted, the second one lower.
		const oleg = await candidateOf('oleg.petrov@fsp-career.example');
		expect(
			(
				await db.select({ status: invitations.status }).from(invitations).where(eq(invitations.candidateId, oleg.id))
			).map((i) => i.status)
		).toEqual(['sent']);
		const dmitry = await candidateOf('dmitry.orlov@fsp-career.example');
		const [offer] = await db.select().from(invitations).where(eq(invitations.candidateId, dmitry.id));
		expect(offer?.status).toBe('accepted');
		const versions = await db
			.select({ version: invitationTerms.version, min: invitationTerms.salaryMin })
			.from(invitationTerms)
			.where(eq(invitationTerms.invitationId, offer?.id ?? ''))
			.orderBy(invitationTerms.version);
		expect(versions.map((v) => v.version)).toEqual([1, 2]);
		expect(Number(versions[1]?.min)).toBeLessThan(Number(versions[0]?.min));

		// К-3: an open dispute of the category.
		const timur = await candidateOf('gleb.sokolov@fsp-career.example');
		const disputes = await db.select({ status: categoryDisputes.status }).from(categoryDisputes);
		expect(disputes).toEqual([{ status: 'open' }]);
		const [timurDispute] = await db
			.select({ id: categoryDisputes.id })
			.from(categoryDisputes)
			.where(eq(categoryDisputes.candidateId, timur.id));
		expect(timurDispute).toBeDefined();

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
			{ requestId: 'demo-seed-test' }
		);
		expect(reset.filesRemoved).toBeGreaterThan(0);
		expect(store.objects.size).toBe(0);
		expect((await census()).users).toBe(0);

		const again = await seedDemo(services);
		expect(again.status).toBe('seeded');
		expect(again.batch).toBe(first.batch);
		expect(await census()).toEqual(before);
	});
});
