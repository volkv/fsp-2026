// The public API over a real database and Redis: operations are run exactly as their routes run them, with the actor
// the hooks establish — a browser session or an API key resolved by `authenticateApiKey`. Covered: authentication by
// session and key with the scope of the key, another company's objects as `404`, a missing right as `403`, validation
// as `400` with the envelope, cursor pagination, idempotent creation, the catalog projection without facts or personal
// data with the receipts issued to the company on the view, the market of a category for a company and for a candidate
// (their own category only), and the anonymous verification of a receipt that does not reveal the person.
import { createPrivateKey, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import type { Actor } from '$lib/server/access/actor';
import type { Permission } from '$lib/server/access/permissions';
import { runOperation, type Operation } from '$lib/server/api/operation';
import type { ApiServices } from '$lib/server/api/services';
import * as v1 from '$lib/server/api/v1';
import * as catalog from '$lib/server/api/v1/catalog';
import * as categories from '$lib/server/api/v1/categories';
import * as companies from '$lib/server/api/v1/companies';
import * as companyProfile from '$lib/server/api/v1/company-profile';
import * as invitations from '$lib/server/api/v1/invitations';
import * as needs from '$lib/server/api/v1/needs';
import * as me from '$lib/server/api/v1/me';
import * as vacancies from '$lib/server/api/v1/vacancies';
import { verifyReceiptOperation } from '$lib/server/api/v1/verify';
import { authenticateApiKey } from '$lib/server/companies/api-keys';
import { registryNotConfigured } from '$lib/server/companies/registry';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	categorizationRulesets,
	companies as companiesTable,
	evidenceRuns,
	consentEvents,
	productPolicies,
	skillInferences,
	sourceFacts,
	taxonomyVersions,
	users,
	verificationReceipts
} from '$lib/server/db/schema';
import { createReceiptSigner, issueSelfReceipt } from '$lib/server/fsp/receipts';
import type { Competition, Result } from '$lib/server/fsp/types';
import { canonicalJson } from '$lib/server/json/canonical';
import type { MailMessage } from '$lib/server/mail/mailer';
import { fail } from '$lib/server/ml/result';
import type { Redis } from '$lib/server/redis';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { releaseFixtureBank } from '../helpers/bank';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	randomSha256
} from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;
const RECEIPT_SEED = Buffer.alloc(32, 5);
const receiptSigner = createReceiptSigner({ issuer: 'http://app.test', keyId: 'test-1', seed: RECEIPT_SEED });

let database: TestDatabase;
let redis: Redis;
let services: ApiServices;
let taxonomyVersionId: string;
let documents: Record<'pd' | 'catalog' | 'disclosure', string>;
const letters: MailMessage[] = [];

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 3)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 4)
});

beforeAll(async () => {
	database = await createTestDatabase();
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
	// A need may name a specialization only with a released bank.
	await releaseFixtureBank(db, 'backend');

	redis = createClient({ url: inject('redisUrl') });
	await redis.connect();

	const published = { publishedAt: new Date(Date.now() - 10 * DAY) };
	documents = {
		pd: (await createPublishedDocument(db, 'pd_processing', published)).id,
		catalog: (await createPublishedDocument(db, 'catalog_visibility', published)).id,
		disclosure: (await createPublishedDocument(db, 'contact_disclosure', published)).id
	};
	const effectiveFrom = new Date(Date.now() - 10 * DAY);
	await db.insert(productPolicies).values([
		{
			kind: 'invitation_policy',
			version: 1,
			params: {
				response_window_hours: 72,
				decline_reason_codes: ['salary', 'other'],
				reason_required: false,
				max_open_per_company_per_day: 50,
				reopen_cooldown_days: 14,
				max_reopens: 2
			},
			effectiveFrom
		},
		{
			kind: 'hiring_policy',
			version: 1,
			params: {
				outcome_due_days: 30,
				reminder_intervals_days: [7],
				max_reminders: 2,
				stages: ['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'],
				outcome_reason_codes: ['other']
			},
			effectiveFrom
		},
		{ kind: 'notification_policy', version: 1, params: { response_due_reminder_hours: [24] }, effectiveFrom },
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 1 }, effectiveFrom },
		{ kind: 'market_policy', version: 1, params: { window_days: 30, min_sample: 3 }, effectiveFrom }
	]);

	services = {
		db,
		redis: () => Promise.resolve(redis),
		crypto,
		mailer: {
			send: (message) => {
				letters.push(message);
				return Promise.resolve({ ok: true, value: { messageId: `m-${letters.length}` } });
			}
		},
		registry: registryNotConfigured,
		models: {
			embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
			rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' })),
			extract: () => Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' }))
		},
		receiptSigner,
		appOrigin: 'http://app.test',
		now: () => new Date(),
		testResults: GRADE_DECISION_RESULTS
	};
});

afterAll(async () => {
	redis.destroy();
	await database.drop();
});

// --- Requests -------------------------------------------------------------------------------------------------------

interface Call {
	actor?: Actor;
	params?: Record<string, string>;
	query?: Record<string, string | string[]>;
	body?: unknown;
	headers?: Record<string, string>;
}

interface Answer {
	status: number;
	headers: Headers;
	// The body is JSON of the answer; a test reads the members it checks.
	json: Record<string, unknown> & {
		error?: { code: string; request_id: string; details?: { path?: string; code: string }[] };
	};
	text: string;
}

let requests = 0;

/** Runs the operation the way its route does, after the hooks have set the request id and the actor. */
async function call(operation: Operation, input: Call = {}): Promise<Answer> {
	const path = operation.path.replace(/\{(\w+)\}/gu, (_, name: string) => {
		const value = input.params?.[name];
		if (value === undefined) throw new Error(`parameter ${name} of ${operation.id} is missing`);
		return value;
	});
	const url = new URL(`http://app.test/api/v1${path}`);
	for (const [name, value] of Object.entries(input.query ?? {})) {
		for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, item);
	}
	const request = new Request(url, {
		method: operation.method,
		headers: {
			...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
			...input.headers
		},
		...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
	});
	const requestId = `req-${++requests}`;
	const response = await runOperation(operation, services, {
		request,
		url,
		params: input.params ?? {},
		locals: { requestId, actor: input.actor ?? { kind: 'anonymous' } },
		getClientAddress: () => '127.0.0.1'
	});
	const text = await response.text();
	return {
		status: response.status,
		headers: response.headers,
		json: text.length === 0 ? {} : (JSON.parse(text) as Answer['json']),
		text
	};
}

function expectError(answer: Answer, status: number, code: string): void {
	expect(answer.status, answer.text).toBe(status);
	expect(answer.json.error?.code).toBe(code);
	expect(answer.json.error?.request_id).toBe(answer.headers.get('x-request-id'));
}

// --- Fixtures -------------------------------------------------------------------------------------------------------

const session = (userId: string): Actor => ({
	kind: 'session',
	userId,
	sessionHash: randomSha256(),
	authTime: new Date(),
	authMethod: 'password',
	csrfToken: 'csrf'
});

async function employer(status: 'verified' | 'submitted' = 'verified') {
	const { db } = database;
	const company = await createCompany(db, { status });
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
	return { company, owner, actor: session(owner.userId), vacancy };
}

async function recruiterOf(companyId: string): Promise<Actor> {
	const member = await createMember(database.db, companyId, { role: 'recruiter' });
	if (!member.userId) throw new Error('member without user');
	return session(member.userId);
}

/** The key created by the owner, as the hooks resolve `Authorization: Bearer` with it. */
async function issueKey(owner: Actor, companyId: string, permissions: Permission[]): Promise<string> {
	const created = await call(companies.createCompanyApiKey, {
		actor: owner,
		params: { company_id: companyId },
		body: { name: 'Интеграция ATS', permissions, expires_at: null }
	});
	expect(created.status, created.text).toBe(201);
	return String(created.json.token);
}

async function apiKey(owner: Actor, companyId: string, permissions: Permission[]): Promise<Actor> {
	const actor = await authenticateApiKey(database.db, await issueKey(owner, companyId, permissions), new Date());
	if (!actor) throw new Error('a fresh key is not accepted');
	return actor;
}

const yearsAgo = (years: number) => {
	const date = new Date();
	date.setUTCFullYear(date.getUTCFullYear() - years);
	return date.toISOString().slice(0, 10);
};

const LAST_NAME = 'Самойлова';
const EMAIL_PREFIX = 'samoylova';

/**
 * An adult candidate in the catalog with the category backend middle, a published run, an FSP result and a receipt of
 * their own.
 */
async function catalogCandidate(options: { catalogConsent?: boolean } = {}) {
	const { db } = database;
	const email = `${EMAIL_PREFIX}-${randomBytes(4).toString('hex')}@example.org`;
	const [user] = await db
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email)
		})
		.returning();
	if (!user) throw new Error('user not inserted');
	const candidate = await createCandidate(db, {
		userId: user.id,
		birthDate: yearsAgo(27),
		visibility: 'catalog',
		lastNameEnc: crypto.encrypt(LAST_NAME, 'candidates.last_name'),
		// The grade decision below moves the profile to revision 1, the one of the run.
		profileRevision: 0,
		preferences: { work_formats: ['remote'], region_code: 'RU-MOW' }
	});
	const occurredAt = new Date(Date.now() - DAY);
	const consent = (kind: 'pd_processing' | 'catalog_visibility', documentId: string) => ({
		subjectCandidateId: candidate.id,
		kind,
		documentId,
		action: 'grant' as const,
		signerKind: 'subject' as const,
		signerUserId: user.id,
		method: 'separate_screen_button' as const,
		evidence: {},
		occurredAt
	});
	await db.insert(consentEvents).values(consent('pd_processing', documents.pd));
	if (options.catalogConsent !== false) {
		await db.insert(consentEvents).values(consent('catalog_visibility', documents.catalog));
	}

	const payload: { result: Result; competition: Competition } = {
		result: {
			id: `r-${randomBytes(3).toString('hex')}`,
			competitionId: 'c-1',
			place: 2,
			award: 'prize',
			status: 'official'
		},
		competition: {
			id: 'c-1',
			ekpNumber: null,
			title: 'Чемпионат России по программированию',
			discipline: 'algorithmic',
			level: 'russian_championship',
			startDate: '2025-10-01',
			online: false
		}
	};
	const [fact] = await db
		.insert(sourceFacts)
		.values({
			candidateId: candidate.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:result:${payload.result.id}`,
			eventKey: `fsp:competition:${payload.competition.id}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'operator_confirmed',
			payload,
			payloadSha256: randomSha256(),
			sourceSnapshotSha256: randomSha256(),
			observedAt: occurredAt,
			lastVerifiedAt: occurredAt,
			status: 'active'
		})
		.returning();
	if (!fact) throw new Error('fact not inserted');

	const [ruleset] = await db.select({ id: categorizationRulesets.id }).from(categorizationRulesets);
	if (!ruleset) throw new Error('no categorization rule set');
	const [run] = await db
		.insert(evidenceRuns)
		.values({
			candidateId: candidate.id,
			inputRevision: 1,
			inputSnapshotSha256: randomSha256(),
			inputRefs: { facts: [fact.id], claims: [] },
			taxonomyVersionId,
			rulesetId: ruleset.id,
			asOf: occurredAt,
			computedAt: occurredAt,
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
		contributions: [{ fact_id: fact.id, attestation: 'direct' }]
	});
	await decide(db, candidate.id, { specialization: 'backend', grade: 'middle' });

	await db.transaction((tx) =>
		issueSelfReceipt(
			tx,
			receiptSigner,
			{
				generalized: ['discipline', 'competitionLevel', 'season', 'resultGroup'],
				doesNotAssert: { all: ['коммерческий опыт'], team: ['личный вклад'], individual: [], byRole: {} }
			},
			{
				id: fact.id,
				fact: { factType: 'competition_result', payload },
				sourceRecordRef: fact.sourceRecordRef,
				payloadSha256: fact.payloadSha256,
				sourceSnapshotSha256: fact.sourceSnapshotSha256 ?? randomSha256(),
				lastVerifiedAt: fact.lastVerifiedAt
			}
		)
	);
	return { candidate, user, email, fact, run, actor: session(user.id) };
}

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('authentication', () => {
	it('answers an operation of an account without a session or key with 401 in the envelope', async () => {
		const { company } = await employer();
		expectError(await call(companies.getCompany, { params: { company_id: company.id } }), 401, 'unauthenticated');
	});

	it('serves an owner in a browser session', async () => {
		const { company, actor } = await employer();
		const answer = await call(companies.getCompany, { actor, params: { company_id: company.id } });
		expect(answer.status, answer.text).toBe(200);
		expect(answer.json).toMatchObject({ id: company.id, status: 'verified', verification: null });
	});

	it('serves an API key within its scope and refuses outside of it', async () => {
		const { company, actor: owner } = await employer();
		await catalogCandidate();
		const key = await apiKey(owner, company.id, ['catalog.search', 'candidate.card.read']);
		const found = await call(catalog.searchCatalog, { actor: key, query: { limit: '5' } });
		expect(found.status, found.text).toBe(200);
		expect((found.json.items as unknown[]).length).toBeGreaterThan(0);

		// A permission outside the scope of the key.
		const narrow = await apiKey(owner, company.id, ['catalog.search']);
		const refused = await call(catalog.getCandidateCard, {
			actor: narrow,
			params: { pseudonym: String((found.json.items as { pseudonym: string }[])[0]?.pseudonym) }
		});
		expectError(refused, 403, 'forbidden');
		expect(refused.json.error?.details?.[0]?.code).toBe('api_key_scope');
	});

	it('never lets an API key act where only a session may: key management, candidate operations', async () => {
		const { company, actor: owner } = await employer();
		const key = await apiKey(owner, company.id, ['catalog.search', 'vacancy.write']);
		expectError(
			await call(companies.listCompanyApiKeys, { actor: key, params: { company_id: company.id } }),
			403,
			'forbidden'
		);
		expectError(await call(categories.listMyCategories, { actor: key }), 403, 'forbidden');
	});

	it('loses the key with the membership of its creator', async () => {
		const { company, actor: owner } = await employer();
		const recruiter = await recruiterOf(company.id);
		// A recruiter does not manage keys at all.
		expectError(
			await call(companies.createCompanyApiKey, {
				actor: recruiter,
				params: { company_id: company.id },
				body: { name: 'Ключ рекрутера', permissions: ['catalog.search'], expires_at: null }
			}),
			403,
			'forbidden'
		);
		const second = await createMember(database.db, company.id, { role: 'owner' });
		if (!second.userId) throw new Error('member without user');
		const token = await issueKey(session(second.userId), company.id, ['catalog.search', 'candidate.card.read']);
		expect(await authenticateApiKey(database.db, token, new Date())).not.toBeNull();
		const removed = await call(companies.removeCompanyMember, {
			actor: owner,
			params: { company_id: company.id, member_id: second.id }
		});
		expect(removed.status, removed.text).toBe(204);
		expect(await authenticateApiKey(database.db, token, new Date())).toBeNull();
	});
});

describe('objects of another company and missing rights', () => {
	it('answers 404 for another company, its vacancy and its invitation', async () => {
		const mine = await employer();
		const theirs = await employer();
		expectError(
			await call(companies.getCompany, { actor: mine.actor, params: { company_id: theirs.company.id } }),
			404,
			'not_found'
		);
		expectError(
			await call(vacancies.updateVacancy, {
				actor: mine.actor,
				params: { vacancy_id: theirs.vacancy.id },
				body: { title: 'Чужая вакансия' }
			}),
			404,
			'not_found'
		);
		expectError(
			await call(vacancies.listCompanyVacancies, { actor: mine.actor, params: { company_id: theirs.company.id } }),
			404,
			'not_found'
		);
		const { candidate } = await catalogCandidate();
		const sent = await call(invitations.sendInvitation, {
			actor: theirs.actor,
			body: {
				...OFFER,
				vacancy_id: theirs.vacancy.id,
				candidate_pseudonym: crypto.pseudonym(candidate.id, theirs.company.id)
			}
		});
		expect(sent.status, sent.text).toBe(201);
		expectError(
			await call(invitations.getOneInvitation, { actor: mine.actor, params: { invitation_id: String(sent.json.id) } }),
			404,
			'not_found'
		);
	});

	it('answers 403 when the object is the actor’s own but the role lacks the right', async () => {
		const { company } = await employer();
		const recruiter = await recruiterOf(company.id);
		expectError(
			await call(companies.listCompanyMembers, { actor: recruiter, params: { company_id: company.id } }),
			403,
			'forbidden'
		);
		const { actor: candidate } = await catalogCandidate();
		expectError(await call(catalog.searchCatalog, { actor: candidate }), 403, 'forbidden');
	});

	it('does not show a candidate the company may not see, whatever the reason', async () => {
		const { company, actor } = await employer();
		const { candidate } = await catalogCandidate({ catalogConsent: false });
		expectError(
			await call(catalog.getCandidateCard, {
				actor,
				params: { pseudonym: crypto.pseudonym(candidate.id, company.id) }
			}),
			404,
			'not_found'
		);
	});
});

describe('validation', () => {
	it('answers 400 with field details, in the names of the API', async () => {
		const { actor, vacancy } = await employer();
		const unknownField = await call(invitations.sendInvitation, {
			actor,
			body: {
				...OFFER,
				vacancy_id: vacancy.id,
				candidate_pseudonym: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
				salary_period: 'year'
			}
		});
		expectError(unknownField, 400, 'validation_failed');
		expect(unknownField.json.error?.details?.map((d) => d.code)).toContain('unrecognized_keys');

		const badQuery = await call(vacancies.searchVacancies, { query: { limit: '1000' } });
		expectError(badQuery, 400, 'validation_failed');
		expect(badQuery.json.error?.details?.[0]?.path).toBe('limit');

		// A refusal of the domain module is renamed to the field of the API: `roleKey` → `role_key`.
		const unknownRole = await call(vacancies.updateVacancy, {
			actor,
			params: { vacancy_id: vacancy.id },
			body: { role_key: 'astronaut' }
		});
		expectError(unknownRole, 400, 'validation_failed');
		expect(unknownRole.json.error?.details?.[0]?.path).toBe('role_key');
	});

	it('refuses a region code the reference of regions does not know instead of finding nobody', async () => {
		const { company, actor } = await employer();
		const { candidate } = await catalogCandidate();
		const pseudonym = crypto.pseudonym(candidate.id, company.id);
		const known = await call(catalog.searchCatalog, { actor, query: { region_code: ['RU-MOW'], limit: '100' } });
		expect(known.status, known.text).toBe(200);
		expect((known.json.items as { pseudonym: string }[]).map((item) => item.pseudonym)).toContain(pseudonym);

		for (const code of ['RU-XX', 'ru-mow', 'Москва']) {
			const unknown = await call(catalog.searchCatalog, { actor, query: { region_code: ['RU-MOW', code] } });
			expectError(unknown, 400, 'validation_failed');
			expect(unknown.json.error?.details).toEqual([expect.objectContaining({ path: 'region_code', code: 'unknown' })]);
		}
	});

	it('refuses a body that is not JSON', async () => {
		const { actor, vacancy } = await employer();
		const answer = await call(vacancies.publishVacancy, {
			actor,
			params: { vacancy_id: vacancy.id },
			headers: { 'content-type': 'text/plain' },
			body: 'publish'
		});
		expectError(answer, 400, 'validation_failed');
	});
});

describe('pagination', () => {
	it('walks a list with the cursor and refuses a cursor of another query', async () => {
		const { company, owner } = await employer();
		for (let i = 0; i < 5; i++) {
			await createOwnVacancy(
				database.db,
				{ companyId: company.id, memberId: owner.id, taxonomyVersionId },
				{ title: `Pagination ${i}`, roleKey: 'frontend', publishedAt: new Date(Date.now() - i * 1000) }
			);
		}
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const query: Record<string, string> = { role_key: 'frontend', limit: '2' };
			if (cursor !== null) query.cursor = cursor;
			const answer = await call(vacancies.searchVacancies, { query });
			expect(answer.status, answer.text).toBe(200);
			seen.push(...(answer.json.items as { id: string }[]).map((item) => item.id));
			cursor = answer.json.next_cursor as string | null;
			pages++;
		} while (cursor !== null && pages < 10);
		expect(pages).toBe(3);
		expect(new Set(seen).size).toBe(5);

		const first = await call(vacancies.searchVacancies, { query: { role_key: 'frontend', limit: '2' } });
		const foreign = await call(vacancies.searchVacancies, {
			query: { role_key: 'backend', limit: '2', cursor: String(first.json.next_cursor) }
		});
		expectError(foreign, 400, 'validation_failed');
		expect(foreign.json.error?.details?.[0]?.code).toBe('invalid_cursor');
	});
});

describe('idempotency', () => {
	it('answers a repeated key with the stored answer and a changed request with 409', async () => {
		const { company, actor } = await employer();
		const key = `invite-${randomBytes(4).toString('hex')}`;
		const body = { email: `team-${randomBytes(3).toString('hex')}@example.org`, role: 'recruiter' };
		const first = await call(companies.inviteCompanyMember, {
			actor,
			params: { company_id: company.id },
			body,
			headers: { 'idempotency-key': key }
		});
		expect(first.status, first.text).toBe(201);
		const lettersAfterFirst = letters.length;
		const repeated = await call(companies.inviteCompanyMember, {
			actor,
			params: { company_id: company.id },
			body,
			headers: { 'idempotency-key': key }
		});
		expect(repeated.status).toBe(201);
		expect(repeated.headers.get('idempotent-replayed')).toBe('true');
		expect(repeated.json).toEqual(first.json);
		expect(letters.length).toBe(lettersAfterFirst);

		const changed = await call(companies.inviteCompanyMember, {
			actor,
			params: { company_id: company.id },
			body: { ...body, role: 'owner' },
			headers: { 'idempotency-key': key }
		});
		expectError(changed, 409, 'idempotency_conflict');
	});
});

describe('catalog projection', () => {
	it('shows the catalog card without personal data, internal ids or facts, and journals the view', async () => {
		const { company, actor } = await employer();
		const { candidate, user, email, fact, run } = await catalogCandidate();
		const pseudonym = crypto.pseudonym(candidate.id, company.id);
		const answer = await call(catalog.getCandidateCard, { actor, params: { pseudonym } });
		expect(answer.status, answer.text).toBe(200);
		expect(answer.json).toMatchObject({
			pseudonym,
			projection: 'catalog',
			evidence_state: 'available',
			region: 'RU-MOW',
			region_name: 'Москва',
			categories: [{ specialization: 'backend', grade: 'middle', bank_release_id: 'test-release' }],
			skills: [{ skill_key: 'go', attestation: 'direct' }],
			fsp_achievements: [
				{ generalized: { discipline: 'algorithmic', competition_level: 'russian_championship', season: 2025 } }
			]
		});
		// Exact achievements are shown only when the adult candidate chose them.
		expect((answer.json.fsp_achievements as { exact?: unknown }[])[0]?.exact).toBeUndefined();
		// The view issues the company its own generalized receipt of the result, checkable by its handle.
		const receipts = answer.json.receipts as { handle: string; level: string; status: string }[];
		// The test signer is the federation's: the receipt does not say its source is the simulator.
		expect(receipts).toEqual([
			expect.objectContaining({ level: 'generalized', status: 'valid', source_simulator: false })
		]);
		const [issued] = await database.db
			.select({ handle: verificationReceipts.handle })
			.from(verificationReceipts)
			.where(eq(verificationReceipts.audienceCompanyId, company.id));
		expect(receipts[0]?.handle).toBe(issued?.handle);
		expect(answer.json.fsp_achievements).toEqual([expect.objectContaining({ receipt_handles: [issued?.handle] })]);
		const checked = await call(verifyReceiptOperation, { params: { handle: receipts[0]?.handle ?? '' } });
		// Signed by the signer of the services the operation runs with.
		expect(checked.json).toMatchObject({ status: 'valid', signing_key_id: 'test-1' });
		for (const secret of [
			candidate.id,
			user.id,
			fact.id,
			run.id,
			email,
			LAST_NAME,
			EMAIL_PREFIX,
			fact.sourceRecordRef
		]) {
			expect(answer.text).not.toContain(secret);
		}
		const [viewed] = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.action, 'card.viewed'));
		expect(viewed?.details).toMatchObject({ projection: 'catalog' });
	});

	it('explains a match to the company without the facts behind it, and to the candidate with them', async () => {
		const { company, actor, vacancy } = await employer();
		const { candidate, fact, actor: candidateActor } = await catalogCandidate();
		const pseudonym = crypto.pseudonym(candidate.id, company.id);
		const companySide = await call(catalog.getVacancyMatch, {
			actor,
			params: { vacancy_id: vacancy.id, pseudonym }
		});
		expect(companySide.status, companySide.text).toBe(200);
		expect(companySide.text).toContain('"skill_key":"go"');
		for (const secret of [fact.id, candidate.id]) expect(companySide.text).not.toContain(secret);

		const own = await call(me.listMyMatches, { actor: candidateActor, query: {} });
		expect(own.status, own.text).toBe(200);
		const mine = (own.json.items as { vacancy_id: string }[]).find((item) => item.vacancy_id === vacancy.id);
		expect(JSON.stringify(mine)).toContain(fact.id);
	});

	it('compares candidates with the role and the trust of each pair', async () => {
		const { company, actor, vacancy } = await employer();
		const { candidate } = await catalogCandidate();
		const pseudonym = crypto.pseudonym(candidate.id, company.id);
		const answer = await call(catalog.compareCatalogCandidates, {
			actor,
			query: { vacancy_id: vacancy.id, pseudonym: [pseudonym] }
		});
		expect(answer.status, answer.text).toBe(200);
		const [compared] = answer.json.candidates as { pseudonym: string; role: unknown; trust: unknown }[];
		expect(compared?.pseudonym).toBe(pseudonym);
		// Category backend middle, Go confirmed directly by FSP, the grade inside the vacancy's middle–senior.
		expect(compared?.role).toEqual({
			status: 'computed',
			value: 1,
			details: {
				vacancy: 'backend',
				specializations: ['backend'],
				candidate: ['backend'],
				basis: 'same_specialization'
			}
		});
		expect(compared?.trust).toMatchObject({
			status: 'computed',
			details: { direct: 1, total: 1, public_profile: 0, grade_agreement: 1 }
		});
		expect(answer.text).not.toContain(candidate.id);
	});
});

describe('market of a category', () => {
	it('is read by a verified company for any category, three indicators apart', async () => {
		const { actor } = await employer();
		const answer = await call(catalog.getCategoryMarket, {
			actor,
			query: { specialization: 'frontend', grade: 'middle' }
		});
		expect(answer.status, answer.text).toBe(200);
		expect(answer.json).toEqual({
			category_key: { specialization: 'frontend', grade: 'middle' },
			candidate_expectations: expect.any(Array) as unknown,
			vacancy_ranges: expect.any(Array) as unknown,
			external_reference: expect.any(Array) as unknown
		});
		expectError(
			await call(catalog.getCategoryMarket, { query: { specialization: 'backend' } }),
			401,
			'unauthenticated'
		);
	});

	it('is read by a candidate only for their own category', async () => {
		const { actor } = await catalogCandidate();
		// The category in force: backend middle, and the specialization as a whole.
		const own: Call['query'][] = [{ specialization: 'backend' }, { specialization: 'backend', grade: 'middle' }];
		for (const query of own) {
			const answer = await call(catalog.getCategoryMarket, { actor, query });
			expect(answer.status, answer.text).toBe(200);
		}
		const foreign: Call['query'][] = [
			{ specialization: 'frontend' },
			{ specialization: 'frontend', grade: 'middle' },
			{ specialization: 'backend', grade: 'senior' }
		];
		for (const query of foreign) {
			expectError(await call(catalog.getCategoryMarket, { actor, query }), 403, 'forbidden');
		}
	});

	it('answers the draft from text with the position of its range, honestly when there is none', async () => {
		const { actor } = await employer();
		const answer = await call(vacancies.draftVacancyFromText, {
			actor,
			body: { text: 'Go-разработчик\nЗарплата 200–230 тыс. ₽ на руки' }
		});
		expect(answer.status, answer.text).toBe(200);
		// The model is off here: the rules read the role and the range, so the range is placed against its category.
		expect(answer.json).toMatchObject({
			mode: 'rules',
			fields: { role_key: 'backend', salary: { value: { min: 200_000, max: 230_000, currency: 'RUB' } } },
			market_position: { status: 'evaluated' }
		});
	});
});

/** The terms of an offer as the API takes them (contracts 9.2). */
const OFFER = {
	title: 'Backend-разработчик на Go',
	description: 'Развиваем платёжный шлюз: Go, PostgreSQL, Kafka. Команда из шести инженеров, релизы каждую неделю.',
	salary_min: 260_000,
	salary_max: 320_000,
	salary_currency: 'RUB',
	salary_tax_base: 'gross',
	work_format: 'remote',
	contact_method: { kind: 'email', value: 'hr@example.ru' },
	why_you: [
		{ text: 'Удалённый формат совпадает с предпочтениями', source: { kind: 'preference', ref: 'work_formats' } }
	]
};

describe('invitation through the API', () => {
	it('invites by pseudonym, refuses a paused vacancy and discloses contacts only after acceptance', async () => {
		const { company, actor: ownerSession, vacancy } = await employer();
		const key = await apiKey(ownerSession, company.id, [
			'invitation.create',
			'invitation.read',
			'catalog.search',
			'candidate.card.read'
		]);
		const { candidate, email, actor: candidateActor } = await catalogCandidate();
		const pseudonym = crypto.pseudonym(candidate.id, company.id);

		const paused = await createOwnVacancy(
			database.db,
			{ companyId: company.id, memberId: (await createMember(database.db, company.id)).id, taxonomyVersionId },
			{ status: 'paused' }
		);
		const refused = await call(invitations.sendInvitation, {
			actor: key,
			body: { ...OFFER, vacancy_id: paused.id, candidate_pseudonym: pseudonym }
		});
		expectError(refused, 422, 'policy_violation');
		expect(refused.json.error?.details?.[0]?.code).toBe('vacancy_not_invitable');

		const notRub = await call(invitations.sendInvitation, {
			actor: key,
			body: { ...OFFER, salary_currency: 'USD', candidate_pseudonym: pseudonym }
		});
		expectError(notRub, 422, 'policy_violation');
		expect(notRub.json.error?.details?.[0]?.code).toBe('salary_not_rub');

		const sent = await call(invitations.sendInvitation, {
			actor: key,
			body: { ...OFFER, vacancy_id: vacancy.id, candidate_pseudonym: pseudonym }
		});
		expect(sent.status, sent.text).toBe(201);
		expect(sent.json).toMatchObject({ viewer: 'company', candidate_pseudonym: pseudonym, status: 'sent' });
		const invitationId = String(sent.json.id);

		expectError(
			await call(invitations.disclosedContacts, { actor: key, params: { invitation_id: invitationId } }),
			404,
			'not_found'
		);

		const seen = await call(invitations.getOneInvitation, {
			actor: candidateActor,
			params: { invitation_id: invitationId }
		});
		expect(seen.status, seen.text).toBe(200);
		expect(seen.json).toMatchObject({ viewer: 'candidate', candidate_pseudonym: null });
		const accepted = await call(invitations.respondInvitation, {
			actor: candidateActor,
			params: { invitation_id: invitationId },
			body: {
				terms_id: seen.json.current_terms_id,
				decision: 'accept',
				disclose_fields: ['full_name', 'email'],
				disclosure_document_id: seen.json.disclosure_document_id
			}
		});
		expect(accepted.status, accepted.text).toBe(200);
		expect(accepted.json).toMatchObject({ status: 'accepted', disclosed_fields: ['full_name', 'email'] });

		const contacts = await call(invitations.disclosedContacts, { actor: key, params: { invitation_id: invitationId } });
		expect(contacts.status, contacts.text).toBe(200);
		expect(contacts.json).toMatchObject({ email, full_name: { last: LAST_NAME } });
		expect(contacts.json.phone).toBeUndefined();
	});
});

describe('company profile and hiring needs through the API', () => {
	it('lets the owner fill in the profile, refuses an offer without it, and closes it to a suspended company', async () => {
		const { company, actor: owner } = await employer('submitted');
		const read = await call(companyProfile.getCompanyProfile, { actor: owner });
		expect(read.status, read.text).toBe(200);
		expect(read.json).toMatchObject({ verification: 'unverified', complete: true });

		const cleared = await call(companyProfile.patchCompanyProfile, {
			actor: owner,
			body: { description: null, contacts: { telegram: '@severny_hr', website: 'https://example.ru' } }
		});
		expect(cleared.status, cleared.text).toBe(200);
		expect(cleared.json).toMatchObject({
			description: null,
			complete: false,
			contacts: { telegram: '@severny_hr', website: 'https://example.ru' }
		});
		const { candidate } = await catalogCandidate();
		const incomplete = await call(invitations.sendInvitation, {
			actor: owner,
			body: { ...OFFER, candidate_pseudonym: crypto.pseudonym(candidate.id, company.id) }
		});
		expectError(incomplete, 422, 'policy_violation');
		expect(incomplete.json.error?.details?.[0]?.code).toBe('company_profile_incomplete');

		const recruiter = await recruiterOf(company.id);
		expectError(
			await call(companyProfile.patchCompanyProfile, { actor: recruiter, body: { activity: 'Финтех' } }),
			403,
			'forbidden'
		);
		await database.db.update(companiesTable).set({ status: 'rejected' }).where(eq(companiesTable.id, company.id));
		const closed = await call(companyProfile.patchCompanyProfile, { actor: owner, body: { activity: 'Финтех' } });
		expectError(closed, 403, 'forbidden');
		expect(closed.json.error?.details?.[0]?.code).toBe('company_rejected');
	});

	it('parses a need by the rules and counts the candidates of its categories', async () => {
		const { actor } = await employer();
		const created = await call(needs.createHiringNeed, {
			actor,
			body: {
				text: 'Ищем бэкенд-разработчика уровня middle в команду платежей.\nНужны Go и PostgreSQL. Kafka будет плюсом. Удалённо.'
			}
		});
		expect(created.status, created.text).toBe(201);
		expect(created.json).toMatchObject({
			status: 'draft',
			form: { specialization: 'backend', grade: { min: 'middle', max: 'middle' }, work_format: 'remote' },
			parse: { mode: 'rules', model_failure: 'disabled' }
		});
		const form = created.json.form as { skill_keys: string[]; nice_skill_keys: string[] };
		expect(form.skill_keys).toEqual(expect.arrayContaining(['go', 'postgresql']));
		expect(form.nice_skill_keys).toContain('kafka');
		const needId = String(created.json.id);

		// Each category counts the candidates of a category in force the company sees: a visible candidate adds one, a
		// candidate without the catalog consent adds nothing (other suites of this file may hold categories too).
		const count = async () => {
			const counted = await call(needs.needRecommendedCategories, { actor, params: { need_id: needId } });
			expect(counted.status, counted.text).toBe(200);
			return counted.json.categories as { grade: string; basis: string; candidates: { value?: number } }[];
		};
		const before = await count();
		expect(before.map((c) => [c.grade, c.basis])).toEqual([
			['middle', 'form'],
			['junior', 'neighbour_grade'],
			['senior', 'neighbour_grade']
		]);
		const { candidate } = await catalogCandidate();
		const hidden = await catalogCandidate({ catalogConsent: false });
		for (const id of [candidate.id, hidden.candidate.id]) {
			await decide(database.db, id, { specialization: 'backend', grade: 'middle' });
		}
		const after = await count();
		// The catalog policy of this suite shows numbers from 1 (`small_count_threshold: 1`).
		expect(after[0]?.candidates.value).toBe((before[0]?.candidates.value ?? 0) + 1);
		expect(after[1]?.candidates).toEqual(before[1]?.candidates);

		const confirmed = await call(needs.updateHiringNeed, {
			actor,
			params: { need_id: needId },
			body: { status: 'active' }
		});
		expect(confirmed.status, confirmed.text).toBe(200);
		expect(confirmed.json.status).toBe('active');
		const other = await employer();
		expectError(await call(needs.getHiringNeed, { actor: other.actor, params: { need_id: needId } }), 404, 'not_found');
	});
});

describe('receipt verification', () => {
	it('verifies a receipt without signing in and reveals nothing about the person', async () => {
		const { candidate, user, email, fact } = await catalogCandidate();
		const [receipt] = await database.db
			.select({ handle: verificationReceipts.handle })
			.from(verificationReceipts)
			.where(eq(verificationReceipts.factId, fact.id));
		if (!receipt) throw new Error('receipt not issued');

		const answer = await call(verifyReceiptOperation, { params: { handle: receipt.handle } });
		expect(answer.status, answer.text).toBe(200);
		expect(answer.json).toMatchObject({
			status: 'valid',
			signing_key_id: 'test-1',
			statement: { source: 'fsp', asserts: { discipline: 'algorithmic', season: 2025 } }
		});
		for (const secret of [candidate.id, user.id, fact.id, email, LAST_NAME, fact.sourceRecordRef]) {
			expect(answer.text).not.toContain(secret);
		}
		// The signature holds over the canonical statement with the public key of the platform.
		const publicKey = createPublicKey(
			createPrivateKey({
				key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), RECEIPT_SEED]),
				format: 'der',
				type: 'pkcs8'
			})
		);
		expect(
			verifySignature(
				null,
				Buffer.from(canonicalJson(answer.json.statement), 'utf8'),
				publicKey,
				Buffer.from(String(answer.json.signature), 'base64url')
			)
		).toBe(true);

		await database.db.update(sourceFacts).set({ status: 'superseded' }).where(eq(sourceFacts.id, fact.id));
		const superseded = await call(verifyReceiptOperation, { params: { handle: receipt.handle } });
		expect(superseded.json.status).toBe('superseded');

		expectError(
			await call(verifyReceiptOperation, { params: { handle: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' } }),
			404,
			'not_found'
		);
	});
});

describe('document', () => {
	it('is served at /api/v1/openapi.json', async () => {
		const answer = await call(v1.getOpenApiDocument);
		expect(answer.status).toBe(200);
		expect(answer.json.openapi).toBe('3.1.0');
		expect(Object.keys(answer.json.paths as object)).toContain('/api/v1/catalog/candidates');
	});
});
