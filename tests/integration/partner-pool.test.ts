// The pool of a competition partner over a real database (docs/domain.md, sections 5.5, 6.3, 7.4, 19.3): the candidate
// consents to the partners of one competition where they are a finalist, the partner reads the pool through the API
// and the page module. The partner sees only the adult finalists who consented to it — with the result of the
// competition exact — and the view is journaled; another company, a company without a partnership, an ended
// partnership, a key without the rights, a revoked consent, a minor, a partner added after the consent and the
// profiles of other demo sessions are all refused. The clone of a partner in a demo session counts the consents given to
// its original — the same company within the session — and no others.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import type { Actor } from '$lib/server/access/actor';
import type { AccessSubject, Permission } from '$lib/server/access/permissions';
import { runOperation, type Operation } from '$lib/server/api/operation';
import type { ApiServices } from '$lib/server/api/services';
import * as companiesApi from '$lib/server/api/v1/companies';
import { listPartnerPoolCandidates } from '$lib/server/api/v1/partner-pools';
import {
	grantPartnerPoolConsent,
	partnerPoolOverview,
	revokePartnerPoolConsent
} from '$lib/server/candidates/consents';
import { authenticateApiKey } from '$lib/server/companies/api-keys';
import type { CompanyDeps } from '$lib/server/companies/context';
import { endPartnership, openPartnership } from '$lib/server/companies/partnerships';
import { registryNotConfigured } from '$lib/server/companies/registry';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	candidates,
	companies,
	competitionPartnerships,
	consentEvents,
	demoSessions,
	productPolicies,
	sourceFacts,
	taxonomyVersions
} from '$lib/server/db/schema';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import type { Competition, Result } from '$lib/server/fsp/types';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { fail } from '$lib/server/ml/result';
import { poolOffers, readPartnerPool } from '$lib/server/partner-pool/pool';
import type { Redis } from '$lib/server/redis';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createUser,
	randomSha256
} from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;
const REDIS_DATABASE = 11;
const meta = { requestId: 'partner-pool-test', ip: null, userAgent: 'test', sessionHash: null };

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 3)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 4)
});

let database: TestDatabase;
let redis: Redis;
let services: ApiServices;
let documents: { pool: string; catalog: string };
let operator: AccessSubject;
let taxonomyVersionId: string;

const matching = (): MatchingDeps => ({
	db: database.db,
	models: services.models,
	pseudonym: (candidateId, companyId) => crypto.pseudonym(candidateId, companyId),
	now: () => new Date(),
	testResults: GRADE_DECISION_RESULTS
});

const companyDeps = (): CompanyDeps => ({
	db: database.db,
	crypto,
	mailer: services.mailer,
	registry: registryNotConfigured,
	appOrigin: 'http://app.test',
	now: () => new Date()
});

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	redis = createClient({ url: inject('redisUrl'), database: REDIS_DATABASE });
	await redis.connect();
	const published = { publishedAt: new Date(Date.now() - 10 * DAY) };
	documents = {
		pool: (await createPublishedDocument(db, 'partner_pool', published)).id,
		catalog: (await createPublishedDocument(db, 'catalog_visibility', published)).id
	};
	await db.insert(productPolicies).values({
		kind: 'catalog_policy',
		version: 1,
		params: { small_count_threshold: 1 },
		effectiveFrom: new Date(Date.now() - 10 * DAY)
	});
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const [version] = await db.select({ id: taxonomyVersions.id }).from(taxonomyVersions);
	if (!version) throw new Error('taxonomy not published');
	taxonomyVersionId = version.id;
	services = {
		db,
		redis: () => Promise.resolve(redis),
		crypto,
		mailer: { send: () => Promise.resolve({ ok: true, value: { messageId: 'm' } }) },
		registry: registryNotConfigured,
		models: {
			embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
			rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' })),
			extract: () => Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' }))
		},
		receiptSigner: createReceiptSigner({ issuer: 'http://app.test', keyId: 'test-1', seed: Buffer.alloc(32, 5) }),
		appOrigin: 'http://app.test',
		now: () => new Date(),
		testResults: GRADE_DECISION_RESULTS
	};
	operator = await subjectOf((await createUser(db)).id, { operator: true });
});

afterAll(async () => {
	redis.destroy();
	await database.drop();
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

const sessionOf = (userId: string): Actor => ({
	kind: 'session',
	userId,
	sessionHash: randomSha256(),
	authTime: new Date(),
	authMethod: 'password',
	csrfToken: 'csrf'
});

async function subjectOf(userId: string, staff: { operator?: boolean } = {}): Promise<AccessSubject> {
	const subject = await loadAccessSubject(database.db, sessionOf(userId));
	return staff.operator ? { ...subject, staff: { operator: true, admin: false, extraPermissions: [] } } : subject;
}

let competitions = 0;

/** A competition of its own for each test: pools of different tests never meet. */
function competition(): { ref: string; title: string } {
	competitions++;
	return { ref: `cup-${competitions}-${randomBytes(3).toString('hex')}`, title: `Кубок России, финал ${competitions}` };
}

async function partner(session: string | null = null) {
	const company = await createCompany(database.db, { demoSessionId: session, displayName: 'Тёплый стек' });
	const owner = await createMember(database.db, company.id, {
		userId: (await createUser(database.db, { demoSessionId: session })).id
	});
	if (!owner.userId) throw new Error('member without user');
	return { company, owner, actor: sessionOf(owner.userId) };
}

async function open(companyId: string, ref: string): Promise<string> {
	return (
		await openPartnership(
			companyDeps(),
			{ subject: operator, meta },
			{
				companyId,
				competitionRef: ref,
				kind: 'case_provider',
				validFrom: new Date().toISOString().slice(0, 10),
				validTo: null,
				basis: 'Договор о кейсе финала'
			}
		)
	).partnershipId;
}

const yearsAgo = (years: number) => {
	const date = new Date();
	date.setUTCFullYear(date.getUTCFullYear() - years);
	return date.toISOString().slice(0, 10);
};

/** A candidate with an FSP result of the competition, as the import stores it. */
async function finalist(
	contest: { ref: string; title: string },
	options: {
		stage?: 'final' | 'qualifier';
		award?: 'winner' | 'prize' | 'finalist' | 'participant';
		place?: number;
		age?: number;
		session?: string | null;
		demoOriginal?: boolean;
	} = {}
) {
	const { db } = database;
	const user = await createUser(db, { demoSessionId: options.session ?? null });
	const candidate = await createCandidate(db, {
		userId: user.id,
		birthDate: yearsAgo(options.age ?? 25),
		demoSessionId: options.session ?? null,
		demoOriginal: options.demoOriginal ?? false
	});
	const payload: { result: Result; competition: Competition } = {
		result: {
			id: `r-${randomBytes(4).toString('hex')}`,
			competitionId: contest.ref,
			place: options.place ?? 5,
			award: options.award ?? 'finalist',
			status: 'official'
		},
		competition: {
			id: contest.ref,
			ekpNumber: null,
			title: contest.title,
			discipline: 'product',
			level: 'russian_cup',
			stage: options.stage ?? 'final',
			startDate: '2025-11-20',
			online: false
		}
	};
	await db.insert(sourceFacts).values({
		candidateId: candidate.id,
		source: 'fsp',
		factType: 'competition_result',
		sourceRecordRef: `fsp:result:${payload.result.id}`,
		eventKey: `fsp:competition:${contest.ref}`,
		trustLevel: 'fsp_verified',
		ownershipBasis: 'operator_confirmed',
		payload,
		payloadSha256: randomSha256(),
		sourceSnapshotSha256: randomSha256(),
		observedAt: new Date(),
		lastVerifiedAt: new Date(),
		status: 'active'
	});
	return { candidate, user, subject: await subjectOf(user.id) };
}

async function consent(person: { subject: AccessSubject }, ref: string) {
	return grantPartnerPoolConsent(database.db, person.subject, meta, {
		documentId: documents.pool,
		competitionRef: ref
	});
}

// --- Requests -------------------------------------------------------------------------------------------------------

interface Answer {
	status: number;
	json: Record<string, unknown> & { error?: { code: string; details?: { code: string }[] } };
	text: string;
}

let requests = 0;

async function call(
	operation: Operation,
	actor: Actor,
	params: Record<string, string>,
	query: Record<string, string> | URLSearchParams = {}
) {
	const path = operation.path.replace(/\{(\w+)\}/gu, (_, name: string) => params[name] ?? '');
	const url = new URL(`http://app.test/api/v1${path}`);
	for (const [name, value] of new URLSearchParams(query)) url.searchParams.append(name, value);
	const response = await runOperation(operation, services, {
		request: new Request(url, { method: operation.method }),
		url,
		params,
		locals: { requestId: `pool-${++requests}`, actor },
		getClientAddress: () => '127.0.0.1'
	});
	const text = await response.text();
	return { status: response.status, json: JSON.parse(text) as Answer['json'], text } satisfies Answer;
}

const readPool = (actor: Actor, partnershipId: string, query: Record<string, string> | URLSearchParams = {}) =>
	call(listPartnerPoolCandidates, actor, { partnership_id: partnershipId }, query);

function pseudonyms(answer: Answer): string[] {
	expect(answer.status, answer.text).toBe(200);
	return (answer.json.items as { pseudonym: string }[]).map((item) => item.pseudonym);
}

async function apiKey(owner: Actor, companyId: string, permissions: Permission[]): Promise<Actor> {
	const created = await runOperation(companiesApi.createCompanyApiKey, services, {
		request: new Request(`http://app.test/api/v1/companies/${companyId}/api-keys`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'ATS', permissions, expires_at: null })
		}),
		url: new URL(`http://app.test/api/v1/companies/${companyId}/api-keys`),
		params: { company_id: companyId },
		locals: { requestId: `key-${++requests}`, actor: owner },
		getClientAddress: () => '127.0.0.1'
	});
	const body = (await created.json()) as { token: string };
	expect(created.status).toBe(201);
	const actor = await authenticateApiKey(database.db, body.token, new Date());
	if (!actor) throw new Error('a fresh key is not accepted');
	return actor;
}

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('the pool a partner reads', () => {
	it('shows only the adult finalists who consented to this partner, the result exact, and journals the view', async () => {
		const contest = competition();
		const { company, actor } = await partner();
		const partnershipId = await open(company.id, contest.ref);
		const consented = await finalist(contest, { place: 4 });
		const silent = await finalist(contest);
		const qualifier = await finalist(contest, { stage: 'qualifier', award: 'finalist' });
		await consent(consented, contest.ref);
		// A result the pool rule does not admit gives nothing to consent to.
		await expect(consent(qualifier, contest.ref)).rejects.toMatchObject({ code: 'conflict' });
		// Nor does a consent written past the product bring a result the rule does not admit into the pool.
		await database.db.insert(consentEvents).values({
			subjectCandidateId: qualifier.candidate.id,
			kind: 'partner_pool',
			documentId: documents.pool,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: qualifier.user.id,
			scopeCompetitionRef: contest.ref,
			choices: { partner_company_ids: [company.id] },
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date()
		});

		const answer = await readPool(actor, partnershipId);
		expect(answer.status, answer.text).toBe(200);
		const pseudonym = crypto.pseudonym(consented.candidate.id, company.id);
		expect(pseudonyms(answer)).toEqual([pseudonym]);
		expect(answer.text).not.toContain(crypto.pseudonym(silent.candidate.id, company.id));
		expect(answer.json).toMatchObject({
			partnership: { id: partnershipId, competition_ref: contest.ref, competition_title: contest.title },
			items: [
				{
					result: { stage: 'final', place: 4, award: 'finalist' },
					card: {
						projection: 'catalog',
						fsp_achievements: [{ exact: { competition_ref: contest.ref, place: 4 } }]
					}
				}
			]
		});
		expect(answer.text).not.toContain(consented.candidate.id);
		const [journal] = await database.db
			.select({ details: auditEvents.details, objectId: auditEvents.objectId, company: auditEvents.actorCompanyId })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'partner_pool.viewed'), eq(auditEvents.objectId, partnershipId)));
		expect(journal).toEqual({
			details: { competition_ref: contest.ref, card_count: 1 },
			objectId: partnershipId,
			company: company.id
		});
	});

	it('does not depend on the catalog setting, while an offer goes only by the general rules of an offer', async () => {
		const contest = competition();
		const { company, owner } = await partner();
		const partnershipId = await open(company.id, contest.ref);
		const person = await finalist(contest);
		await consent(person, contest.ref);
		if (!owner.userId) throw new Error('member without user');
		const subject = await subjectOf(owner.userId);
		const pool = await readPartnerPool(matching(), subject, partnershipId);
		// The profile is hidden from the catalog: the pool still shows it, but no offer can reach it.
		expect(pool.members.map((member) => member.candidateId)).toEqual([person.candidate.id]);
		const vacancy = await createOwnVacancy(
			database.db,
			{ companyId: company.id, memberId: owner.id, taxonomyVersionId },
			{ status: 'published', publishedAt: new Date() }
		);
		const offers = async () =>
			(await poolOffers(database.db, subject, [person.candidate.id], new Date())).get(person.candidate.id);
		expect(await offers()).toEqual({ withoutVacancy: false, vacancies: [] });

		// In the catalog the offer goes from the card without a vacancy, or naming the vacancy.
		await database.db.update(candidates).set({ visibility: 'catalog' }).where(eq(candidates.id, person.candidate.id));
		await database.db.insert(consentEvents).values({
			subjectCandidateId: person.candidate.id,
			kind: 'catalog_visibility',
			documentId: documents.catalog,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: person.user.id,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date(Date.now() - 60_000)
		});
		expect(await offers()).toEqual({ withoutVacancy: true, vacancies: [{ id: vacancy.id, title: vacancy.title }] });
	});

	it('filters by the specialization and the grade of the category in force', async () => {
		const contest = competition();
		const { company, actor } = await partner();
		const partnershipId = await open(company.id, contest.ref);
		const person = await finalist(contest);
		await consent(person, contest.ref);
		await decide(database.db, person.candidate.id, { specialization: 'backend', grade: 'middle' });
		const read = async (query: [string, string][]) => {
			const url = new URL('http://app.test');
			for (const [name, value] of query) url.searchParams.append(name, value);
			return pseudonyms(await readPool(actor, partnershipId, url.searchParams));
		};
		expect(await read([['specialization', 'backend']])).toHaveLength(1);
		expect(await read([['specialization', 'frontend']])).toEqual([]);
		expect(await read([['grade', 'middle']])).toHaveLength(1);
		expect(await read([['grade', 'junior']])).toEqual([]);
		// Both together name one category: the grade is the grade of that specialization.
		expect(
			await read([
				['specialization', 'backend'],
				['grade', 'middle']
			])
		).toHaveLength(1);
		expect(
			await read([
				['specialization', 'frontend'],
				['specialization', 'backend'],
				['grade', 'senior']
			])
		).toEqual([]);
	});
});

describe('refusals', () => {
	it('answers 404 to another company and to a company that partners nothing', async () => {
		const contest = competition();
		const { company } = await partner();
		const partnershipId = await open(company.id, contest.ref);
		await consent(await finalist(contest), contest.ref);
		const stranger = await partner();
		expect((await readPool(stranger.actor, partnershipId)).json.error?.code).toBe('not_found');
		const otherPartner = await partner();
		await open(otherPartner.company.id, competition().ref);
		const foreign = await readPool(otherPartner.actor, partnershipId);
		expect(foreign.status).toBe(404);
	});

	it('closes the pool when the partnership ends', async () => {
		const contest = competition();
		const { company, actor } = await partner();
		const partnershipId = await open(company.id, contest.ref);
		await consent(await finalist(contest), contest.ref);
		expect(pseudonyms(await readPool(actor, partnershipId))).toHaveLength(1);
		await endPartnership(companyDeps(), { subject: operator, meta }, partnershipId);
		const closed = await readPool(actor, partnershipId);
		expect(closed.status, closed.text).toBe(403);
		expect(closed.json.error?.code).toBe('forbidden');
	});

	it('serves an API key only with both partner_pool.read and candidate.card.read', async () => {
		const contest = competition();
		const { company, actor } = await partner();
		const partnershipId = await open(company.id, contest.ref);
		await consent(await finalist(contest), contest.ref);
		const cardOnly = await readPool(await apiKey(actor, company.id, ['candidate.card.read']), partnershipId);
		expect(cardOnly.status).toBe(403);
		expect(cardOnly.json.error?.details?.[0]?.code).toBe('api_key_scope');
		const poolOnly = await readPool(await apiKey(actor, company.id, ['partner_pool.read']), partnershipId);
		expect(poolOnly.status).toBe(403);
		expect(poolOnly.json.error?.details?.[0]?.code).toBe('api_key_scope');
		const both = await readPool(
			await apiKey(actor, company.id, ['partner_pool.read', 'candidate.card.read']),
			partnershipId
		);
		expect(both.status, both.text).toBe(200);
		expect(pseudonyms(both)).toHaveLength(1);
	});

	it('takes a candidate out of the pool at once when the consent is revoked', async () => {
		const contest = competition();
		const { company, actor } = await partner();
		const partnershipId = await open(company.id, contest.ref);
		const person = await finalist(contest);
		await consent(person, contest.ref);
		expect(pseudonyms(await readPool(actor, partnershipId))).toHaveLength(1);
		await revokePartnerPoolConsent(database.db, person.subject, meta, contest.ref);
		expect(pseudonyms(await readPool(actor, partnershipId))).toEqual([]);
		await expect(revokePartnerPoolConsent(database.db, person.subject, meta, contest.ref)).rejects.toMatchObject({
			code: 'conflict'
		});
	});

	it('keeps a minor out: the consent is refused, a representative cannot sign it, and a stray grant does not count', async () => {
		const contest = competition();
		const { company, actor } = await partner();
		const partnershipId = await open(company.id, contest.ref);
		const minor = await finalist(contest, { age: 16 });
		await expect(consent(minor, contest.ref)).rejects.toMatchObject({ code: 'forbidden' });
		expect((await partnerPoolOverview(database.db, minor.candidate.id, new Date())).adult).toBe(false);
		// Only an adult signs the kind: the database refuses a representative's event.
		await expect(
			database.sql`insert into consent_events (subject_candidate_id, kind, document_id, action, signer_kind,
				representation_id, scope_competition_ref, method, evidence, occurred_at)
				values (${minor.candidate.id}, 'partner_pool', ${documents.pool}, 'grant', 'representative',
				${minor.candidate.id}, ${contest.ref}, 'email_link', '{}', now())`
		).rejects.toThrow();
		// A grant of the minor's own written past the product is not in effect for 14–17 and `canShow` admits adults only.
		await database.db.insert(consentEvents).values({
			subjectCandidateId: minor.candidate.id,
			kind: 'partner_pool',
			documentId: documents.pool,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: minor.user.id,
			scopeCompetitionRef: contest.ref,
			choices: { partner_company_ids: [company.id] },
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date()
		});
		expect(pseudonyms(await readPool(actor, partnershipId))).toEqual([]);
	});

	it('does not show a candidate to a partner added after the consent until the candidate consents again', async () => {
		const contest = competition();
		const first = await partner();
		const firstPool = await open(first.company.id, contest.ref);
		const person = await finalist(contest);
		expect((await consent(person, contest.ref)).partnerCompanyIds).toEqual([first.company.id]);
		const late = await partner();
		const latePool = await open(late.company.id, contest.ref);
		expect(pseudonyms(await readPool(late.actor, latePool))).toEqual([]);
		const offer = (await partnerPoolOverview(database.db, person.candidate.id, new Date())).offers.find(
			(item) => item.competitionRef === contest.ref
		);
		expect(offer).toMatchObject({
			consent: { effective: true, partners: ['Тёплый стек'] },
			newPartners: ['Тёплый стек']
		});
		await consent(person, contest.ref);
		expect(pseudonyms(await readPool(late.actor, latePool))).toHaveLength(1);
		expect(pseudonyms(await readPool(first.actor, firstPool))).toHaveLength(1);
	});
});

describe('demo sessions', () => {
	async function demoSession(): Promise<string> {
		const [row] = await database.db
			.insert(demoSessions)
			.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + DAY) })
			.returning({ id: demoSessions.id });
		if (!row) throw new Error('demo session not inserted');
		return row.id;
	}

	/** A consent as a clone carries it: the copy of the hero's consent names the clone of the partner. */
	async function clonedConsent(candidateId: string, userId: string, ref: string, companyId: string) {
		await database.db.insert(consentEvents).values({
			subjectCandidateId: candidateId,
			kind: 'partner_pool',
			documentId: documents.pool,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: userId,
			scopeCompetitionRef: ref,
			choices: { partner_company_ids: [companyId] },
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date(Date.now() - 1000)
		});
	}

	/** The copy of a partnership of the scenario, as the clone of its company holds it in the session. */
	async function clonedPartnership(companyId: string, ref: string, session: string): Promise<string> {
		const [partnership] = await database.db
			.insert(competitionPartnerships)
			.values({
				companyId,
				competitionRef: ref,
				competitionSource: 'fsp',
				kind: 'case_provider',
				poolRule: { min_award: 'finalist', stages: ['final'] },
				status: 'active',
				validFrom: new Date(Date.now() - DAY).toISOString().slice(0, 10),
				grantedBy: (await createUser(database.db, { demoSessionId: session })).id,
				basis: 'Копия партнёрства сценария'
			})
			.returning({ id: competitionPartnerships.id });
		if (!partnership) throw new Error('partnership not inserted');
		return partnership.id;
	}

	it('shows the clone of a partner the clones of its own session only', async () => {
		const contest = competition();
		const mine = await demoSession();
		const other = await demoSession();
		const clonePartner = await partner(mine);
		const partnership = { id: await clonedPartnership(clonePartner.company.id, contest.ref, mine) };
		const clone = await finalist(contest, { session: mine });
		const foreignClone = await finalist(contest, { session: other });
		const original = await finalist(contest, { demoOriginal: true });
		for (const person of [clone, foreignClone, original]) {
			await clonedConsent(person.candidate.id, person.user.id, contest.ref, clonePartner.company.id);
		}
		const answer = await readPool(clonePartner.actor, partnership.id);
		expect(answer.status, answer.text).toBe(200);
		expect(pseudonyms(answer)).toEqual([crypto.pseudonym(clone.candidate.id, clonePartner.company.id)]);
	});

	it('counts for the clone of a partner the consents given to its original, not to another company', async () => {
		const contest = competition();
		const mine = await demoSession();
		const other = await partner();
		await open(other.company.id, contest.ref);
		// Consented while only the other company partnered the competition: its list does not name the original.
		const toOther = await finalist(contest);
		expect((await consent(toOther, contest.ref)).partnerCompanyIds).toEqual([other.company.id]);
		const original = await partner();
		await database.db.update(companies).set({ demoOriginal: true }).where(eq(companies.id, original.company.id));
		await open(original.company.id, contest.ref);
		const toOriginal = await finalist(contest);
		expect((await consent(toOriginal, contest.ref)).partnerCompanyIds).toContain(original.company.id);

		const clone = await partner(mine);
		await database.db
			.update(companies)
			.set({ demoCloneOf: original.company.id })
			.where(eq(companies.id, clone.company.id));
		const partnershipId = await clonedPartnership(clone.company.id, contest.ref, mine);
		expect(pseudonyms(await readPool(clone.actor, partnershipId))).toEqual([
			crypto.pseudonym(toOriginal.candidate.id, clone.company.id)
		]);
		// The same company within the session, not a clone of another: without the link the consent names someone else.
		const stranger = await partner(mine);
		const strangerPool = await clonedPartnership(stranger.company.id, contest.ref, mine);
		expect(pseudonyms(await readPool(stranger.actor, strangerPool))).toEqual([]);
	});

	it('offers a clone candidate the partners of its session, not the originals', async () => {
		const contest = competition();
		const mine = await demoSession();
		const originalPartner = await partner();
		await database.db.update(companies).set({ demoOriginal: true }).where(eq(companies.id, originalPartner.company.id));
		await open(originalPartner.company.id, contest.ref);
		const clone = await finalist(contest, { session: mine });
		expect((await partnerPoolOverview(database.db, clone.candidate.id, new Date())).offers).toEqual([]);
		await expect(consent(clone, contest.ref)).rejects.toMatchObject({ code: 'conflict' });
	});
});
