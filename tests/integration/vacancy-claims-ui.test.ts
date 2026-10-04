// External vacancies and «this is our vacancy» from the employer cabinet (docs/domain.md, 13.2–13.3; CONCEPT,
// promise 5): the page searches as the general search does — external vacancies only, by words, role and format —
// and shows each with its source and the pool counter; the claim action files the claim with the rule of the API: a
// verified company's claim goes to an FSP operator, an unverified one's waits for the verification, a rejected company
// files none.
// An open claim is taken back from the list of the company's vacancies, from the card of the external vacancy and by
// `POST /api/v1/vacancies/{id}/claims/{claim_id}/withdrawal`, with the right of filing it and a record in the journal.
// The candidate's «vacancies for me» narrows by the filters of `GET /api/v1/me/matches` and keeps the match of each
// vacancy. The pages and the action run as their routes run them.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { Actor } from '$lib/server/access/actor';
import {
	auditEvents,
	companies,
	productPolicies,
	taxonomyVersions,
	vacancies,
	vacancyClaims,
	vacancyImportRuns,
	vacancyPostings
} from '$lib/server/db/schema';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { PENDING_NORMALIZATION, PENDING_VERSION } from '$lib/server/vacancies/clusters';
import { HABR_SOURCE_KEY, registerVacancySources, SOURCE_DEFINITIONS } from '$lib/server/vacancies/sources/definitions';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createExternalVacancy,
	createMember,
	createOwnVacancy,
	randomSha256
} from '../helpers/factories';

// The routes read `config()`: its environment points at this file's database once it exists.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const { closeDb } = await import('$lib/server/db');
const { testEnvironment } = await import('../helpers/environment');
const externalPage = await import('../../src/routes/(app)/company/(member)/vacancies/external/+page.server');
const vacanciesPage = await import('../../src/routes/(app)/company/(member)/vacancies/+page.server');
const { POST: claimApi } = await import('../../src/routes/api/v1/vacancies/[vacancy_id]/claims/+server');
const { POST: withdrawalApi } =
	await import('../../src/routes/api/v1/vacancies/[vacancy_id]/claims/[claim_id]/withdrawal/+server');
const { load: candidatePage } = await import('../../src/routes/(app)/me/vacancies/+page.server');

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;
const HABR_ATTRIBUTION = SOURCE_DEFINITIONS.find((source) => source.key === HABR_SOURCE_KEY)?.terms.attribution;

let database: TestDatabase;
let taxonomyVersionId: string;
let requests = 0;

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
	await registerVacancySources(database.sql);
	await db.insert(productPolicies).values({
		kind: 'catalog_policy',
		version: 1,
		params: { small_count_threshold: 5 },
		effectiveFrom: new Date(Date.now() - 10 * DAY)
	});
});

afterAll(async () => {
	await closeDb();
	await database.drop();
});

/** An external vacancy with the posting it was imported from: an external vacancy exists only through its postings. */
async function externalVacancy(overrides: Parameters<typeof createExternalVacancy>[2] = {}) {
	const { db } = database;
	const vacancy = await createExternalVacancy(db, taxonomyVersionId, overrides);
	const at = new Date();
	const [run] = await db
		.insert(vacancyImportRuns)
		.values({
			source: HABR_SOURCE_KEY,
			adapterVersion: 'test/1',
			mode: 'full',
			startedAt: at,
			finishedAt: at,
			status: 'succeeded',
			completeness: 'complete',
			counts: {}
		})
		.returning({ id: vacancyImportRuns.id });
	if (!run) throw new Error('import run not inserted');
	const externalId = String(randomBytes(4).readUInt32BE());
	await db.insert(vacancyPostings).values({
		vacancyId: vacancy.id,
		source: HABR_SOURCE_KEY,
		externalId,
		url: `https://career.habr.com/vacancies/${externalId}`,
		organization: { name: 'Пример', inn: null, source_org_id: null },
		title: vacancy.title,
		originalTerms: {},
		rawSha256: randomSha256(),
		normalized: PENDING_NORMALIZATION,
		normalizationVersion: PENDING_VERSION,
		firstFetchedAt: at,
		lastFetchedAt: at,
		lastCheckedAt: at,
		freshness: 'active',
		dedup: { method: 'exact', score: 1 },
		lastImportRunId: run.id
	});
	return vacancy;
}

function sessionActor(userId: string): Actor {
	return {
		kind: 'session',
		userId,
		sessionHash: randomSha256(),
		authTime: new Date(),
		authMethod: 'password',
		csrfToken: `csrf-${randomBytes(4).toString('hex')}`
	};
}

async function member(status: 'verified' | 'draft' | 'rejected') {
	const company = await createCompany(database.db, { status });
	const row = await createMember(database.db, company.id);
	if (row.userId === null) throw new Error('member without an account');
	return { company, member: row, actor: sessionActor(row.userId) };
}

function event(actor: Actor, request: Request, params: Record<string, string> = {}) {
	return {
		url: new URL(request.url),
		params,
		request,
		locals: { requestId: `req-claims-${++requests}`, actor },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		depends: () => {}
	};
}

interface Card {
	id: string;
	title: string;
	postings: { attribution: string; url: string; lastCheckedAt: Date }[];
	pool: { status: string; count?: number };
	claim: { id: string; status: string } | null;
	claimedBy: 'none' | 'this_company' | 'other_company';
}

async function load(actor: Actor, query = '') {
	return (await externalPage.load(
		event(actor, new Request(`http://localhost/company/vacancies/external${query}`)) as never
	)) as { page: { items: Card[]; nextCursor: string | null } };
}

type ClaimAnswer =
	| { vacancyId: string; claimed: { status: string }; problem: null }
	| { status: number; data: { vacancyId: string; claimed: null; problem: { code: string; message: string } } };

async function claim(actor: Actor, vacancyId: string): Promise<ClaimAnswer> {
	const action = externalPage.actions.claim;
	if (!action) throw new Error('the page has no claim action');
	const form = new FormData();
	form.set('vacancy_id', vacancyId);
	const request = new Request('http://localhost/company/vacancies/external?/claim', { method: 'POST', body: form });
	return (await action(event(actor, request) as never)) as ClaimAnswer;
}

const ids = (cards: Card[]) => cards.map((card) => card.id);

describe('external vacancies in the employer cabinet', () => {
	it('lists external vacancies only, each with its source and the pool counter', async () => {
		const { actor, company, member: author } = await member('verified');
		const counted = await externalVacancy({
			title: 'Бэкенд-разработчик платёжного шлюза',
			roleKey: 'backend',
			requiredSkillKeys: ['go'],
			workFormat: 'remote',
			poolCount: 7,
			poolCountedAt: new Date()
		});
		const own = await createOwnVacancy(database.db, {
			companyId: company.id,
			memberId: author.id,
			taxonomyVersionId
		});
		const hidden = await externalVacancy({ status: 'hidden' });

		const { page } = await load(actor);
		expect(ids(page.items)).toContain(counted.id);
		expect(ids(page.items)).not.toContain(own.id);
		expect(ids(page.items)).not.toContain(hidden.id);
		const card = page.items.find((item) => item.id === counted.id);
		expect(card?.postings).toHaveLength(1);
		expect(card?.postings[0]?.attribution).toBe(HABR_ATTRIBUTION);
		expect(card?.postings[0]?.url).toMatch(/^https:\/\/career\.habr\.com\/vacancies\//u);
		expect(card?.pool).toMatchObject({ status: 'counted', count: 7 });
		expect(card?.claim).toBeNull();
		expect(card?.claimedBy).toBe('none');
	});

	it('narrows by words, role and work format, as the general search does', async () => {
		const { actor } = await member('verified');
		const marker = `маркер${randomBytes(3).toString('hex')}`;
		const remoteBackend = await externalVacancy({
			title: `Go-разработчик ${marker}`,
			roleKey: 'backend',
			workFormat: 'remote'
		});
		const officeBackend = await externalVacancy({
			title: `Разработчик сервисов ${marker}`,
			roleKey: 'backend',
			workFormat: 'office'
		});
		const frontend = await externalVacancy({
			title: `Фронтенд-разработчик ${marker}`,
			roleKey: 'frontend',
			workFormat: 'remote'
		});

		const byText = await load(actor, `?q=${encodeURIComponent(marker)}`);
		expect(ids(byText.page.items).sort()).toEqual([remoteBackend.id, officeBackend.id, frontend.id].sort());
		const byRole = await load(actor, `?q=${encodeURIComponent(marker)}&role=backend`);
		expect(ids(byRole.page.items).sort()).toEqual([remoteBackend.id, officeBackend.id].sort());
		const byFormat = await load(actor, `?q=${encodeURIComponent(marker)}&role=backend&format=remote`);
		expect(ids(byFormat.page.items)).toEqual([remoteBackend.id]);
	});

	it('a verified company files the claim to the operator, once while it is open', async () => {
		const { actor, company } = await member('verified');
		const vacancy = await externalVacancy();

		const answer = await claim(actor, vacancy.id);
		expect(answer).toEqual({ vacancyId: vacancy.id, claimed: { status: 'pending_review' }, problem: null });
		const [row] = await database.db
			.select()
			.from(vacancyClaims)
			.where(and(eq(vacancyClaims.vacancyId, vacancy.id), eq(vacancyClaims.companyId, company.id)));
		expect(row?.status).toBe('pending_review');
		const journal = await database.db
			.select({ action: auditEvents.action })
			.from(auditEvents)
			.where(and(eq(auditEvents.objectType, 'vacancy_claim'), eq(auditEvents.objectId, row?.id ?? '')));
		expect(journal).toEqual([{ action: 'vacancy_claim.submitted' }]);

		const card = (await load(actor)).page.items.find((item) => item.id === vacancy.id);
		expect(card?.claim).toMatchObject({ status: 'pending_review' });

		const again = await claim(actor, vacancy.id);
		expect(again).toMatchObject({ status: 422, data: { vacancyId: vacancy.id, problem: { code: 'claim_exists' } } });
	});

	it('an unverified company files a claim that waits for the verification of the company', async () => {
		const { actor } = await member('draft');
		const vacancy = await externalVacancy();
		expect(await claim(actor, vacancy.id)).toMatchObject({ claimed: { status: 'awaiting_company_verification' } });
	});

	it('a rejected company files no claim', async () => {
		const { actor, company } = await member('rejected');
		const vacancy = await externalVacancy();
		expect(await claim(actor, vacancy.id)).toMatchObject({ status: 403, data: { problem: { code: 'forbidden' } } });
		expect(await database.db.select().from(vacancyClaims).where(eq(vacancyClaims.companyId, company.id))).toEqual([]);
	});

	it('a vacancy confirmed for another company is shown so and refuses the claim', async () => {
		const other = await createCompany(database.db);
		const vacancy = await externalVacancy({ claimedCompanyId: other.id });
		const { actor } = await member('verified');
		const card = (await load(actor)).page.items.find((item) => item.id === vacancy.id);
		expect(card?.claimedBy).toBe('other_company');
		expect(await claim(actor, vacancy.id)).toMatchObject({
			status: 422,
			data: { problem: { code: 'claim_already_approved' } }
		});
	});

	it('an own vacancy or a malformed id is not a vacancy to claim', async () => {
		const { actor, company, member: author } = await member('verified');
		const own = await createOwnVacancy(database.db, {
			companyId: company.id,
			memberId: author.id,
			taxonomyVersionId
		});
		expect(await claim(actor, own.id)).toMatchObject({ status: 404, data: { problem: { code: 'not_found' } } });
		expect(await claim(actor, 'not-an-id')).toMatchObject({ status: 404, data: { problem: { code: 'not_found' } } });
		const [stored] = await database.db.select().from(vacancies).where(eq(vacancies.id, own.id));
		expect(stored?.claimedCompanyId).toBeNull();
	});
});

type WithdrawAnswer =
	| { claimId: string; withdrawn: true; problem: null }
	| { status: number; data: { claimId: string; withdrawn: false; problem: { code: string; message: string } } };

/** «Отозвать заявку» on the list of the company's vacancies. */
async function withdrawFromList(actor: Actor, vacancyId: string, claimId: string): Promise<WithdrawAnswer> {
	const action = vacanciesPage.actions.withdrawClaim;
	if (!action) throw new Error('the page has no withdrawal action');
	const form = new FormData();
	form.set('vacancy_id', vacancyId);
	form.set('claim_id', claimId);
	const request = new Request('http://localhost/company/vacancies?/withdrawClaim', { method: 'POST', body: form });
	return (await action(event(actor, request) as never)) as WithdrawAnswer;
}

/** «Отозвать заявку» on the card of the external vacancy. */
async function withdrawFromCard(actor: Actor, vacancyId: string, claimId: string): Promise<ClaimAnswer> {
	const action = externalPage.actions.withdrawClaim;
	if (!action) throw new Error('the page has no withdrawal action');
	const form = new FormData();
	form.set('vacancy_id', vacancyId);
	form.set('claim_id', claimId);
	const request = new Request('http://localhost/company/vacancies/external?/withdrawClaim', {
		method: 'POST',
		body: form
	});
	return (await action(event(actor, request) as never)) as ClaimAnswer;
}

async function withdrawByApi(actor: Actor, vacancyId: string, claimId: string): Promise<Response> {
	const url = `http://localhost/api/v1/vacancies/${vacancyId}/claims/${claimId}/withdrawal`;
	return withdrawalApi(
		event(actor, new Request(url, { method: 'POST' }), { vacancy_id: vacancyId, claim_id: claimId }) as never
	);
}

async function claimByApi(actor: Actor, vacancyId: string): Promise<Response> {
	const url = `http://localhost/api/v1/vacancies/${vacancyId}/claims`;
	return claimApi(event(actor, new Request(url, { method: 'POST' }), { vacancy_id: vacancyId }) as never);
}

async function filedClaim(actor: Actor, vacancyId: string): Promise<string> {
	const answer = await claim(actor, vacancyId);
	if (!('claimed' in answer)) throw new Error('the claim was not filed');
	const card = (await load(actor)).page.items.find((item) => item.id === vacancyId);
	if (!card?.claim) throw new Error('the card does not show the claim');
	return card.claim.id;
}

async function claimRow(claimId: string) {
	const [row] = await database.db.select().from(vacancyClaims).where(eq(vacancyClaims.id, claimId));
	return row;
}

async function journalOf(claimId: string) {
	return database.db
		.select({ action: auditEvents.action, details: auditEvents.details })
		.from(auditEvents)
		.where(and(eq(auditEvents.objectType, 'vacancy_claim'), eq(auditEvents.objectId, claimId)))
		.orderBy(auditEvents.occurredAt, auditEvents.id);
}

describe('withdrawing a «this is our vacancy» claim', () => {
	it('from the list of vacancies: the open claim is withdrawn, journaled, and a new one can be filed', async () => {
		const { actor } = await member('verified');
		const vacancy = await externalVacancy();
		const claimId = await filedClaim(actor, vacancy.id);

		expect(await withdrawFromList(actor, vacancy.id, claimId)).toEqual({ claimId, withdrawn: true, problem: null });
		expect((await claimRow(claimId))?.status).toBe('withdrawn');
		const journal = await journalOf(claimId);
		expect(journal.map((row) => row.action)).toEqual(['vacancy_claim.submitted', 'vacancy_claim.withdrawn']);
		expect(journal[1]?.details).toEqual({ vacancy_id: vacancy.id, from_status: 'pending_review' });
		const listed = (await vacanciesPage.load(
			event(actor, new Request('http://localhost/company/vacancies')) as never
		)) as { claims: { claimId: string; status: string }[] };
		expect(listed.claims.find((row) => row.claimId === claimId)?.status).toBe('withdrawn');

		expect(await withdrawFromList(actor, vacancy.id, claimId)).toMatchObject({
			status: 422,
			data: { claimId, withdrawn: false, problem: { code: 'claim_not_open' } }
		});
		expect(await claim(actor, vacancy.id)).toMatchObject({ claimed: { status: 'pending_review' } });
	});

	it('from the card: a claim waiting for the verification of the company is withdrawn too', async () => {
		const { actor } = await member('draft');
		const vacancy = await externalVacancy();
		const claimId = await filedClaim(actor, vacancy.id);
		expect((await claimRow(claimId))?.status).toBe('awaiting_company_verification');

		expect(await withdrawFromCard(actor, vacancy.id, claimId)).toEqual({
			vacancyId: vacancy.id,
			claimed: { status: 'withdrawn' },
			problem: null
		});
		const card = (await load(actor)).page.items.find((item) => item.id === vacancy.id);
		expect(card?.claim).toMatchObject({ id: claimId, status: 'withdrawn' });
	});

	it('a decided claim is not withdrawn', async () => {
		const { actor } = await member('verified');
		const vacancy = await externalVacancy();
		const claimId = await filedClaim(actor, vacancy.id);
		await database.db
			.update(vacancyClaims)
			.set({ status: 'rejected', reason: 'не совпадает организация', decidedAt: new Date() })
			.where(eq(vacancyClaims.id, claimId));
		expect(await withdrawFromCard(actor, vacancy.id, claimId)).toMatchObject({
			status: 422,
			data: { problem: { code: 'claim_not_open' } }
		});
		expect((await claimRow(claimId))?.status).toBe('rejected');
	});

	it('another company, another vacancy or a malformed id finds no claim to withdraw', async () => {
		const owner = await member('verified');
		const vacancy = await externalVacancy();
		const other = await externalVacancy();
		const claimId = await filedClaim(owner.actor, vacancy.id);
		const stranger = await member('verified');

		expect(await withdrawFromList(stranger.actor, vacancy.id, claimId)).toMatchObject({
			status: 404,
			data: { problem: { code: 'not_found' } }
		});
		expect(await withdrawFromList(owner.actor, other.id, claimId)).toMatchObject({ status: 404 });
		expect(await withdrawFromList(owner.actor, vacancy.id, 'not-an-id')).toMatchObject({ status: 404 });
		expect((await claimRow(claimId))?.status).toBe('pending_review');
	});

	it('by the API: 204, then 422 for a claim that is no longer open, 404 for a claim of another company', async () => {
		const owner = await member('verified');
		const stranger = await member('verified');
		const vacancy = await externalVacancy();
		const claimId = await filedClaim(owner.actor, vacancy.id);

		const foreign = await withdrawByApi(stranger.actor, vacancy.id, claimId);
		expect(foreign.status).toBe(404);
		const done = await withdrawByApi(owner.actor, vacancy.id, claimId);
		expect(done.status).toBe(204);
		expect((await claimRow(claimId))?.status).toBe('withdrawn');
		expect((await journalOf(claimId)).map((row) => row.action)).toEqual([
			'vacancy_claim.submitted',
			'vacancy_claim.withdrawn'
		]);
		const again = await withdrawByApi(owner.actor, vacancy.id, claimId);
		expect(again.status).toBe(422);
		expect(await again.json()).toMatchObject({ error: { details: [{ code: 'claim_not_open' }] } });
	});
});

describe('the candidate searches the vacancies for them', () => {
	interface Item {
		vacancyId: string;
		origin: 'own' | 'external';
		match: { score: number };
	}

	async function candidateLoad(actor: Actor, query = '') {
		return (await candidatePage(event(actor, new Request(`http://localhost/me/vacancies${query}`)) as never)) as {
			page: { items: Item[] };
			search: { text: string; origin: string | null; roleKey: string | null; workFormats: string[] };
		};
	}

	it('narrows by words, origin, role and format, and the match of a vacancy stays the same', async () => {
		const person = await createCandidate(database.db);
		const actor = sessionActor(person.userId);
		const marker = `поиск${randomBytes(3).toString('hex')}`;
		const company = await createCompany(database.db);
		const author = await createMember(database.db, company.id);
		const own = await createOwnVacancy(
			database.db,
			{ companyId: company.id, memberId: author.id, taxonomyVersionId },
			{ title: `Go-разработчик ${marker}`, roleKey: 'backend', workFormat: 'remote' }
		);
		const remote = await externalVacancy({
			title: `Go-разработчик ${marker}`,
			roleKey: 'backend',
			workFormat: 'remote'
		});
		const office = await externalVacancy({ title: `Бэкенд ${marker}`, roleKey: 'backend', workFormat: 'office' });
		const frontend = await externalVacancy({ title: `Фронтенд ${marker}`, roleKey: 'frontend', workFormat: 'remote' });
		const q = `?q=${encodeURIComponent(marker)}`;

		const all = await candidateLoad(actor, q);
		expect(all.page.items.map((item) => item.vacancyId).sort()).toEqual(
			[own.id, remote.id, office.id, frontend.id].sort()
		);
		const external = await candidateLoad(actor, `${q}&origin=external`);
		expect(external.page.items.map((item) => item.vacancyId).sort()).toEqual(
			[remote.id, office.id, frontend.id].sort()
		);
		const backend = await candidateLoad(actor, `${q}&origin=external&role=backend`);
		expect(backend.page.items.map((item) => item.vacancyId).sort()).toEqual([remote.id, office.id].sort());
		const narrowed = await candidateLoad(actor, `${q}&role=backend&format=remote`);
		expect(narrowed.page.items.map((item) => item.vacancyId).sort()).toEqual([own.id, remote.id].sort());
		expect(narrowed.search).toEqual({
			text: marker,
			origin: null,
			roleKey: 'backend',
			workFormats: ['remote'],
			cursor: null
		});

		const unfiltered = await candidateLoad(actor);
		for (const item of narrowed.page.items) {
			expect(item.match).toEqual(unfiltered.page.items.find((other) => other.vacancyId === item.vacancyId)?.match);
		}
	});

	it('an unknown origin in the address is refused, not ignored', async () => {
		const person = await createCandidate(database.db);
		const actor = sessionActor(person.userId);
		await expect(candidateLoad(actor, '?origin=elsewhere')).rejects.toMatchObject({ status: 400 });
	});
});

describe('the right to file and withdraw a claim', () => {
	it.each(['rejected', 'suspended'] as const)(
		'a member of a %s company neither files nor withdraws a claim by the API',
		async (status) => {
			const { actor, company } = await member('verified');
			const claimed = await externalVacancy();
			const claimId = await filedClaim(actor, claimed.id);
			await database.db.update(companies).set({ status }).where(eq(companies.id, company.id));
			const fresh = await externalVacancy();

			const filing = await claimByApi(actor, fresh.id);
			expect(filing.status).toBe(403);
			expect(await filing.json()).toMatchObject({ error: { code: 'forbidden' } });
			const withdrawal = await withdrawByApi(actor, claimed.id, claimId);
			expect(withdrawal.status).toBe(403);
			expect(await withdrawal.json()).toMatchObject({ error: { code: 'forbidden' } });

			expect((await claimRow(claimId))?.status).toBe('pending_review');
			expect(await database.db.select().from(vacancyClaims).where(eq(vacancyClaims.vacancyId, fresh.id))).toEqual([]);
		}
	);

	it('filing by the API journals the member with the company it acts for', async () => {
		const { actor, company, member: requester } = await member('verified');
		const vacancy = await externalVacancy();
		const answer = await claimByApi(actor, vacancy.id);
		expect(answer.status).toBe(201);
		const { claim_id: claimId } = (await answer.json()) as { claim_id: string };
		const [entry] = await database.db
			.select({ actorUserId: auditEvents.actorUserId, actorCompanyId: auditEvents.actorCompanyId })
			.from(auditEvents)
			.where(and(eq(auditEvents.objectType, 'vacancy_claim'), eq(auditEvents.objectId, claimId)));
		expect(entry).toEqual({ actorUserId: requester.userId, actorCompanyId: company.id });
	});
});
