// Own vacancies: publication only by a verified company with a full range, the text check with moderation and
// confirmed warnings, `match.refresh` and `vacancy.embed` enqueued in the transaction of every change and publication,
// and a vacancy from pasted text through the model adapter with a fake runtime — and without the model.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '$lib/server/auth/secrets';
import type { CompanyDeps } from '$lib/server/companies/context';
import { acceptMinorTerms, minorTermsOf } from '$lib/server/companies/profile';
import { registryNotConfigured } from '$lib/server/companies/registry';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	companies,
	documentAcceptances,
	jobs,
	mlResults,
	productPolicies,
	vacancies
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { ModelAdapter, type ModelAdapterDeps } from '$lib/server/ml/adapter';
import { databaseSpaceLookup } from '$lib/server/ml/spaces';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { VacancyRefusal } from '$lib/server/vacancies/errors';
import { extractVacancyFromText } from '$lib/server/vacancies/from-text';
import { VACANCY_TEXT_RULES_VERSION } from '$lib/server/vacancies/text-rules';
import { loadInvitability } from '$lib/server/vacancies/invitable';
import { loadPoolCounter } from '$lib/server/vacancies/pool';
import {
	closeOwnVacancy,
	createOwnVacancy,
	decideVacancyModeration,
	pauseOwnVacancy,
	publishOwnVacancy,
	updateOwnVacancy,
	type VacancyAuthor,
	type VacancyDeps
} from '$lib/server/vacancies/own';
import { textCheckSchema } from '$lib/server/vacancies/text-check';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCompany, createMember, createPublishedDocument, createUser } from '../helpers/factories';
import { memoryTextParseCache } from '$lib/server/vacancies/text-extract';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));

let database: TestDatabase;
let deps: VacancyDeps;
let runtime: { url: string; answer: string; server: Server };

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	deps = { db: database.db, now: () => new Date() };
	// A draft from text places its range against the market of its category, which needs the market policies.
	const effectiveFrom = new Date(Date.now() - 86_400_000);
	await database.db.insert(productPolicies).values([
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 5 }, effectiveFrom },
		{ kind: 'market_policy', version: 1, params: { window_days: 30, min_sample: 3 }, effectiveFrom }
	]);

	// A fake OpenAI-compatible runtime answering `extract` with the items the test sets.
	runtime = { url: '', answer: '{"items":[]}', server: createServer() };
	runtime.server.on('request', (req, res) => {
		req.resume();
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'application/json' }).end(
				JSON.stringify({
					model: 'extractor-7b',
					choices: [{ finish_reason: 'stop', message: { content: runtime.answer } }]
				})
			);
		});
	});
	await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
	runtime.url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	runtime.server.closeAllConnections();
	await new Promise((resolve) => runtime.server.close(resolve));
	await database.drop();
});

async function employer(
	status: 'verified' | 'submitted' | 'suspended' = 'verified',
	role: 'owner' | 'recruiter' = 'owner'
): Promise<VacancyAuthor & { userId: string }> {
	const company = await createCompany(database.db, { status });
	const member = await createMember(database.db, company.id, { role });
	if (!member.userId) throw new Error('member without user');
	return {
		memberId: member.id,
		companyId: company.id,
		audit: { kind: 'user', userId: member.userId, companyId: company.id },
		requestId: 'req-test',
		userId: member.userId
	};
}

const input = (overrides: Record<string, unknown> = {}) => ({
	title: 'Backend-разработчик на Go',
	description: 'Разрабатываем платёжные сервисы на Go и PostgreSQL, команда из восьми человек.',
	roleKey: 'backend',
	gradeMin: 'middle',
	gradeMax: 'senior',
	requiredSkillKeys: ['go', 'postgresql'],
	niceSkillKeys: ['kafka'],
	workFormat: 'remote',
	employmentForm: 'full',
	contractTypes: ['labor'],
	cityId: null,
	timezoneOverlapHours: null,
	salary: { min: 250_000, max: 350_000, currency: 'RUB', period: 'month', taxBase: 'gross' },
	...overrides
});

async function queued(type: string, vacancyId: string) {
	return database.db
		.select({ id: jobs.id, inputVersion: jobs.inputVersion, status: jobs.status })
		.from(jobs)
		.where(
			and(
				eq(jobs.type, type),
				eq(jobs.status, 'queued'),
				eq(jobs.payload, { vacancy_id: vacancyId, ...(type === 'match.refresh' ? { scope: 'vacancy' } : {}) })
			)
		);
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof VacancyRefusal) return error.reason;
		throw error;
	}
	throw new Error('expected a refusal');
}

describe('own vacancy', () => {
	it('is created as a draft and enqueues its vector and matches in the same transaction', async () => {
		const author = await employer();
		const vacancy = await createOwnVacancy(deps, author, input());
		expect(vacancy).toMatchObject({ status: 'draft', revision: 1 });
		expect(await queued('match.refresh', vacancy.id)).toEqual([expect.objectContaining({ inputVersion: '1' })]);
		expect(await queued('vacancy.embed', vacancy.id)).toEqual([expect.objectContaining({ inputVersion: '1' })]);
	});

	it('refuses keys outside the taxonomy and a reversed range', async () => {
		const author = await employer();
		expect(await refusalOf(createOwnVacancy(deps, author, input({ roleKey: 'astronaut' })))).toBe('validation_failed');
		expect(
			await refusalOf(
				createOwnVacancy(
					deps,
					author,
					input({ salary: { min: 300_000, max: 200_000, currency: 'RUB', period: 'month', taxBase: 'gross' } })
				)
			)
		).toBe('validation_failed');
		expect(
			await refusalOf(
				createOwnVacancy(
					deps,
					author,
					input({ salary: { min: 1, max: 2, currency: 'RUB', period: 'month', taxBase: 'unknown' } })
				)
			)
		).toBe('validation_failed');
		// The range is in roubles only (domain 13.1): another currency is a rule of the platform.
		expect(
			await refusalOf(
				createOwnVacancy(
					deps,
					author,
					input({ salary: { min: 3_000, max: 5_000, currency: 'USD', period: 'month', taxBase: 'gross' } })
				)
			)
		).toBe('salary_not_rub');
	});

	it('is published by a verified company and enqueues matches at publication', async () => {
		const author = await employer();
		const draft = await createOwnVacancy(deps, author, input());
		await database.db.delete(jobs).where(eq(jobs.type, 'match.refresh'));
		const outcome = await publishOwnVacancy(deps, author, draft.id);
		expect(outcome.status).toBe('published');
		expect(outcome.vacancy.publishedAt).not.toBeNull();
		expect(await queued('match.refresh', draft.id)).toHaveLength(1);
		expect(await loadInvitability(database.db, draft.id)).toEqual({ invitable: true });
		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'vacancy.published'), eq(auditEvents.objectId, draft.id)));
		expect(event).toBeDefined();
	});

	it('is published by a company without a check and not by a suspended one (the admission policy)', async () => {
		const unverified = await employer('submitted');
		const draft = await createOwnVacancy(deps, unverified, input());
		await publishOwnVacancy(deps, unverified, draft.id);
		const [published] = await database.db
			.select({ status: vacancies.status })
			.from(vacancies)
			.where(eq(vacancies.id, draft.id));
		expect(published?.status).toBe('published');

		const closed = await employer('suspended');
		const held = await createOwnVacancy(deps, closed, input());
		await expect(publishOwnVacancy(deps, closed, held.id)).rejects.toMatchObject({
			code: 'forbidden',
			details: [{ code: 'company_suspended' }]
		});
		const [row] = await database.db
			.select({ status: vacancies.status })
			.from(vacancies)
			.where(eq(vacancies.id, held.id));
		expect(row?.status).toBe('draft');
	});

	it('is not touched by another company', async () => {
		const owner = await employer();
		const stranger = await employer();
		const draft = await createOwnVacancy(deps, owner, input());
		expect(await refusalOf(publishOwnVacancy(deps, stranger, draft.id))).toBe('vacancy_not_found');
	});

	it('goes to moderation with a blocked text, and an operator publishes it', async () => {
		const author = await employer();
		const draft = await createOwnVacancy(
			deps,
			author,
			input({ description: 'Нужен разработчик на Go. Гражданство РФ обязательно: работа с гостайной.' })
		);
		const outcome = await publishOwnVacancy(deps, author, draft.id);
		expect(outcome.status).toBe('pending_moderation');
		const operator = await createUser(database.db);
		const published = await decideVacancyModeration(deps, draft.id, {
			operatorUserId: operator.id,
			decision: 'publish',
			revision: outcome.vacancy.revision,
			reason: null,
			requestId: 'req-op'
		});
		expect(published.status).toBe('published');
	});

	it('asks to confirm warnings, and keeps the confirmation while the findings stay the same', async () => {
		const author = await employer();
		const draft = await createOwnVacancy(
			deps,
			author,
			input({ description: 'Сервисы на Go, молодой дружный коллектив, офис у метро.' })
		);
		expect(await refusalOf(publishOwnVacancy(deps, author, draft.id))).toBe('text_warnings_unconfirmed');
		const outcome = await publishOwnVacancy(deps, author, draft.id, { confirmWarnings: true });
		expect(outcome.status).toBe('published');
		const edited = await updateOwnVacancy(
			deps,
			author,
			draft.id,
			input({ description: 'Сервисы на Go и Kafka, молодой дружный коллектив, офис у метро.' })
		);
		expect(edited.status).toBe('published');
		expect(edited.revision).toBe(2);
	});

	it('raises the revision on every change and enqueues the new revision', async () => {
		const author = await employer();
		const draft = await createOwnVacancy(deps, author, input());
		// A change while a job waits joins it; without a waiting job the change enqueues its own.
		expect(await queued('match.refresh', draft.id)).toHaveLength(1);
		await database.db.delete(jobs).where(eq(jobs.status, 'queued'));
		// The pool counted at the first revision is not the pool of the second: it is counted anew, not shown stale.
		await database.db
			.update(vacancies)
			.set({ poolCount: 7, poolCountedAt: new Date() })
			.where(eq(vacancies.id, draft.id));
		const edited = await updateOwnVacancy(deps, author, draft.id, input({ gradeMin: 'senior' }));
		expect(edited.revision).toBe(2);
		expect(edited).toMatchObject({ poolCount: null, poolCountedAt: null });
		expect(await loadPoolCounter(database.db, draft.id, new Date())).toEqual({ status: 'pending' });
		expect(await queued('match.refresh', draft.id)).toEqual([expect.objectContaining({ inputVersion: '2' })]);
		expect(await queued('vacancy.embed', draft.id)).toEqual([expect.objectContaining({ inputVersion: '2' })]);
		const closed = await closeOwnVacancy(deps, author, draft.id);
		expect(closed.status).toBe('closed');
		expect(await refusalOf(updateOwnVacancy(deps, author, draft.id, input()))).toBe('vacancy_not_editable');
	});

	it('leaves a published vacancy for moderation when an edit adds a blocked requirement', async () => {
		const author = await employer();
		const draft = await createOwnVacancy(deps, author, input());
		await publishOwnVacancy(deps, author, draft.id);
		const edited = await updateOwnVacancy(
			deps,
			author,
			draft.id,
			input({ description: 'Сервисы на Go. Возраст до 35 лет.' })
		);
		expect(edited.status).toBe('pending_moderation');
		expect(await loadInvitability(database.db, draft.id)).toEqual({ invitable: false, reason: 'not_published' });
	});
});

describe('own vacancy in moderation, edited by its company', () => {
	const blocked = 'Нужен разработчик на Go. Гражданство РФ обязательно: работа с гостайной.';
	const otherBlock = 'Нужен разработчик на Go. Возраст до 35 лет.';
	const clean = 'Нужен разработчик на Go для платёжных сервисов, работа с PostgreSQL.';

	async function inModeration(author: VacancyAuthor) {
		const draft = await createOwnVacancy(deps, author, input({ description: blocked }));
		const outcome = await publishOwnVacancy(deps, author, draft.id);
		expect(outcome.status).toBe('pending_moderation');
		return outcome.vacancy;
	}

	const journal = async (vacancyId: string) =>
		(
			await database.db
				.select({ action: auditEvents.action, details: auditEvents.details })
				.from(auditEvents)
				.where(eq(auditEvents.objectId, vacancyId))
				.orderBy(auditEvents.occurredAt)
		).map((event) => [event.action, event.details]);

	it('opens a case with its moment when a blocked draft is published', async () => {
		const author = await employer();
		const pending = await inModeration(author);
		expect(textCheckSchema.parse(pending.textCheck).moderation).toEqual({
			opened_at: expect.any(String) as string,
			resume_to: 'published',
			decision: null
		});
	});

	it('returns to the catalog at once when the corrected text passes the check', async () => {
		const author = await employer();
		const pending = await inModeration(author);
		const edited = await updateOwnVacancy(deps, author, pending.id, input({ description: clean }));
		expect(edited.status).toBe('published');
		expect(edited.publishedAt).not.toBeNull();
		expect(textCheckSchema.parse(edited.textCheck)).toMatchObject({ result: 'clean', moderation: null });
		expect(await loadInvitability(database.db, pending.id)).toEqual({ invitable: true });
		expect(await journal(pending.id)).toEqual([
			['vacancy.blocked_text_check', { rules: ['citizenship.required'] }],
			['vacancy.moderation_cleared', { status: 'published' }],
			['vacancy.published', { revision: 2 }]
		]);
	});

	it('stays with the operator with the new findings when the text is still blocked', async () => {
		const author = await employer();
		const pending = await inModeration(author);
		const opened = textCheckSchema.parse(pending.textCheck).moderation?.opened_at;
		const edited = await updateOwnVacancy(deps, author, pending.id, input({ description: otherBlock }));
		expect(edited.status).toBe('pending_moderation');
		const check = textCheckSchema.parse(edited.textCheck);
		expect(check.phrases.map((p) => p.rule)).toEqual(['age.limit']);
		expect(check.moderation?.opened_at).toBe(opened);
	});

	it('asks to confirm new warnings before it leaves moderation', async () => {
		const author = await employer();
		const pending = await inModeration(author);
		const warned = input({ description: 'Сервисы на Go, молодой дружный коллектив, офис у метро.' });
		expect(await refusalOf(updateOwnVacancy(deps, author, pending.id, warned))).toBe('text_warnings_unconfirmed');
		const edited = await updateOwnVacancy(deps, author, pending.id, warned, { confirmWarnings: true });
		expect(edited.status).toBe('published');
	});

	it('returns a vacancy paused before the edit to the pause', async () => {
		const author = await employer();
		const draft = await createOwnVacancy(deps, author, input());
		await publishOwnVacancy(deps, author, draft.id);
		await pauseOwnVacancy(deps, author, draft.id);
		const pending = await updateOwnVacancy(deps, author, draft.id, input({ description: blocked }));
		expect(pending.status).toBe('pending_moderation');
		expect(textCheckSchema.parse(pending.textCheck).moderation?.resume_to).toBe('paused');
		const edited = await updateOwnVacancy(deps, author, draft.id, input({ description: clean }));
		expect(edited.status).toBe('paused');
	});

	it('keeps the operator approval while the blocking findings stay the same', async () => {
		const author = await employer();
		const pending = await inModeration(author);
		const operator = await createUser(database.db);
		await decideVacancyModeration(deps, pending.id, {
			operatorUserId: operator.id,
			decision: 'publish',
			revision: pending.revision,
			reason: 'Допуск к гостайне',
			requestId: 'req-op'
		});
		const salaryOnly = await updateOwnVacancy(
			deps,
			author,
			pending.id,
			input({
				description: blocked,
				salary: { min: 260_000, max: 360_000, currency: 'RUB', period: 'month', taxBase: 'gross' }
			})
		);
		expect(salaryOnly.status).toBe('published');
		const another = await updateOwnVacancy(
			deps,
			author,
			pending.id,
			input({ description: `${blocked} Возраст до 35 лет.` })
		);
		expect(another.status).toBe('pending_moderation');
		expect(textCheckSchema.parse(another.textCheck).moderation).toMatchObject({
			resume_to: 'published',
			decision: null
		});
	});
});

describe('vacancy for minors', () => {
	const companyDeps = (): CompanyDeps => ({
		db: database.db,
		crypto: createFieldCrypto({
			keys: new Map([[1, Buffer.alloc(32, 1)]]),
			activeVersion: 1,
			hmacSecret: Buffer.alloc(32, 2)
		}),
		mailer: { send: () => Promise.reject(new Error('no letters are sent here')) },
		registry: registryNotConfigured,
		appOrigin: 'http://app.test',
		now: () => new Date()
	});
	const as = async (userId: string) => ({
		subject: await loadAccessSubject(database.db, {
			kind: 'session',
			userId,
			sessionHash: sha256Hex(userId),
			authTime: new Date(),
			authMethod: 'password',
			csrfToken: 'csrf'
		}),
		meta: { requestId: `test-${randomUUID()}`, ip: '10.0.0.1', userAgent: 'vitest' }
	});
	async function apiErrorOf(promise: Promise<unknown>): Promise<string> {
		try {
			await promise;
		} catch (error) {
			if (error instanceof ApiError) return error.details?.[0]?.code ?? error.code;
			throw error;
		}
		throw new Error('expected an ApiError');
	}

	let terms: { id: string };
	beforeAll(async () => {
		terms = await createPublishedDocument(database.db, 'minor_employment_terms', {
			publishedAt: new Date(Date.now() - 86_400_000)
		});
	});

	it('needs the offer accepted by the owner, and refers to that acceptance', async () => {
		const author = await employer();
		expect(await refusalOf(createOwnVacancy(deps, author, input({ minAge: 16 })))).toBe('minor_terms_not_accepted');
		const draft = await createOwnVacancy(deps, author, input());
		expect(await refusalOf(updateOwnVacancy(deps, author, draft.id, input({ minAge: 15 })))).toBe(
			'minor_terms_not_accepted'
		);

		const owner = await as(author.userId);
		expect(await minorTermsOf(companyDeps(), owner, author.companyId)).toMatchObject({
			accepted: null,
			current: { id: terms.id }
		});
		const acceptance = await acceptMinorTerms(companyDeps(), owner, author.companyId, terms.id);
		const [journal] = await database.db
			.select()
			.from(documentAcceptances)
			.where(eq(documentAcceptances.id, acceptance.id));
		expect(journal).toMatchObject({
			documentId: terms.id,
			userId: author.userId,
			companyId: author.companyId,
			ip: '10.0.0.1',
			ua: 'vitest'
		});
		const [company] = await database.db.select().from(companies).where(eq(companies.id, author.companyId));
		expect(company?.minorTermsDocumentId).toBe(terms.id);
		expect((await minorTermsOf(companyDeps(), owner, author.companyId)).accepted).not.toBeNull();

		const created = await createOwnVacancy(deps, author, input({ minAge: 16 }));
		expect(created).toMatchObject({ minAge: 16, minorTermsAcceptanceId: acceptance.id });
		const edited = await updateOwnVacancy(deps, author, draft.id, input({ minAge: 14 }));
		expect(edited).toMatchObject({ minAge: 14, minorTermsAcceptanceId: acceptance.id });
		const adult = await updateOwnVacancy(deps, author, draft.id, input({ minAge: null }));
		expect(adult).toMatchObject({ minAge: null, minorTermsAcceptanceId: null });
	});

	it('takes only 14, 15 and 16', async () => {
		const author = await employer();
		for (const minAge of [13, 17, 18]) {
			expect(await refusalOf(createOwnVacancy(deps, author, input({ minAge })))).toBe('validation_failed');
		}
	});

	it('is accepted only by the owner, in the version the page showed', async () => {
		const recruiter = await employer('verified', 'recruiter');
		expect(
			await apiErrorOf(acceptMinorTerms(companyDeps(), await as(recruiter.userId), recruiter.companyId, terms.id))
		).toBe('forbidden');
		const author = await employer();
		const unknown = randomUUID();
		expect(await apiErrorOf(acceptMinorTerms(companyDeps(), await as(author.userId), author.companyId, unknown))).toBe(
			'document_outdated'
		);
	});

	it('asks to accept again a new version that requires it', async () => {
		const author = await employer();
		const owner = await as(author.userId);
		await acceptMinorTerms(companyDeps(), owner, author.companyId, terms.id);
		const renewed = await createPublishedDocument(database.db, 'minor_employment_terms', {
			publishedAt: new Date(Date.now() - 1_000),
			requiresReconsent: true
		});
		expect(await refusalOf(createOwnVacancy(deps, author, input({ minAge: 16 })))).toBe('minor_terms_not_accepted');
		expect(await minorTermsOf(companyDeps(), owner, author.companyId)).toMatchObject({
			accepted: null,
			current: { id: renewed.id }
		});
		expect(await apiErrorOf(acceptMinorTerms(companyDeps(), owner, author.companyId, terms.id))).toBe(
			'document_outdated'
		);
		const acceptance = await acceptMinorTerms(companyDeps(), owner, author.companyId, renewed.id);
		expect(await createOwnVacancy(deps, author, input({ minAge: 16 }))).toMatchObject({
			minorTermsAcceptanceId: acceptance.id
		});
	});
});

describe('vacancy from pasted text', () => {
	const TEXT = [
		'Senior Python-разработчик',
		'Обязательно: Python, PostgreSQL. Java не требуется.',
		'Зарплата 300 000 – 400 000 руб. в месяц на руки, удалённо'
	].join('\n');

	function adapter(modes: ModelAdapterDeps['modes'], modelName = 'extractor-7b'): ModelAdapter {
		return new ModelAdapter({
			models: {
				extract: {
					baseUrl: `${runtime.url}/v1`,
					runtime: 'vllm',
					model: modelName,
					apiKey: null,
					timeoutMs: 5_000,
					interactiveTimeoutMs: 5_000,
					maxConcurrency: 2,
					breaker: { failures: 3, cooldownMs: 30_000 }
				},
				embed: null,
				rerank: null
			},
			modes,
			spaces: databaseSpaceLookup(() => database.db)
		});
	}
	const on: ModelAdapterDeps['modes'] = { current: () => Promise.resolve({ ok: true, value: 'on' }) };
	const off: ModelAdapterDeps['modes'] = { current: () => Promise.resolve({ ok: true, value: 'off' }) };

	it('suggests fields with quotes, records the envelope, and becomes a draft with that id', async () => {
		runtime.answer = JSON.stringify({
			role_titles: [{ raw_text: 'Senior Python-разработчик', block_id: 'p1', quote: 'Senior Python-разработчик' }],
			grades: [{ raw_text: 'Senior', grade_min: 'senior', grade_max: 'senior', block_id: 'p1', quote: 'Senior' }],
			required_skills: [
				{ raw_text: 'Python', polarity: 'asserted', block_id: 'p2', quote: 'Python' },
				{ raw_text: 'PostgreSQL', polarity: 'asserted', block_id: 'p2', quote: 'PostgreSQL' },
				{ raw_text: 'Java', polarity: 'asserted', block_id: 'p2', quote: 'Java не требуется' },
				// Not in the text: refused by the quote check.
				{ raw_text: 'Kotlin', polarity: 'asserted', block_id: 'p2', quote: 'Kotlin' }
			],
			nice_skills: [],
			salaries: [
				{
					raw_text: '300 000 – 400 000 руб. в месяц на руки',
					salary_min: 300000,
					salary_max: 400000,
					currency: 'RUB',
					period: 'month',
					tax_base: 'net',
					block_id: 'p3',
					quote: '300 000 – 400 000 руб. в месяц на руки'
				}
			],
			work_formats: [{ raw_text: 'удалённо', value: 'remote', block_id: 'p3', quote: 'удалённо' }],
			employment_forms: [],
			contract_types: [],
			cities: []
		});
		const author = await employer();
		let calls = 0;
		const counting = (model: ModelAdapter): Pick<ModelAdapter, 'extract' | 'extractModelKey'> => ({
			extract: (request, lexicon, options) => {
				calls++;
				return model.extract(request, lexicon, options);
			},
			extractModelKey: () => model.extractModelKey()
		});
		const counted = counting(adapter(on));
		const textDeps = { db: database.db, models: counted, parseCache: memoryTextParseCache() };
		const draft = await extractVacancyFromText(textDeps, author, TEXT);
		expect(draft.mode).toBe('model');
		expect(draft.fields.title?.value).toBe('Senior Python-разработчик');
		expect(draft.fields.roleKey).toBe('backend');
		expect(draft.fields.grade?.value).toEqual({ min: 'senior', max: 'senior' });
		expect(draft.fields.requiredSkills.map((s) => s.key)).toEqual(['python', 'postgresql']);
		expect(draft.fields.negatedSkills.map((s) => s.key)).toEqual(['java']);
		expect(draft.fields.salary?.value).toEqual({
			min: 300_000,
			max: 400_000,
			currency: 'RUB',
			period: 'month',
			taxBase: 'net'
		});
		expect(draft.fields.salary?.quote.blockId).toBe('p3');
		expect(draft.missing).toEqual(['employmentForm', 'contractTypes']);
		// No vacancies of the category yet: the position says so instead of a number.
		expect(draft.marketPosition).toEqual({
			status: 'evaluated',
			positions: [
				{ indicator: 'vacancy_ranges', status: 'insufficient_data' },
				expect.objectContaining({ indicator: 'external_reference' })
			]
		});

		const [envelope] = await database.db.select().from(mlResults).where(eq(mlResults.id, draft.mlResultId));
		expect(envelope).toMatchObject({
			operation: 'extract',
			processingMode: 'model',
			schemaVersion: 'vacancy-extract/v2',
			inputRef: { type: 'vacancy', id: draft.vacancyId, revision: 0, company_id: author.companyId }
		});
		expect(envelope?.rejectedItems).toEqual([{ reason: 'quote_not_found' }]);

		const saved = await createOwnVacancy(
			deps,
			author,
			input({
				title: 'Senior Python-разработчик',
				roleKey: 'backend',
				requiredSkillKeys: ['python', 'postgresql'],
				niceSkillKeys: []
			}),
			{ fromText: { mlResultId: draft.mlResultId } }
		);
		expect(saved.id).toBe(draft.vacancyId);
		expect(saved.draftMlResultId).toBe(draft.mlResultId);

		// The same text again is the model's answer kept by its hash: a draft of its own, without a call of the model.
		expect(calls).toBe(1);
		const again = await extractVacancyFromText(textDeps, author, `\n${TEXT}  `);
		expect(calls).toBe(1);
		expect(again).toMatchObject({ mode: 'model', fields: draft.fields, missing: draft.missing });
		expect(again.vacancyId).not.toBe(draft.vacancyId);
		const [kept] = await database.db.select().from(mlResults).where(eq(mlResults.id, again.mlResultId));
		expect(kept).toMatchObject({ processingMode: 'model', inputSha256: envelope?.inputSha256 });
		// Another company's parse of the same text is its own call.
		await extractVacancyFromText(textDeps, await employer(), TEXT);
		expect(calls).toBe(2);
		// Another configured model does not get the answers of the previous one: the same text is read again.
		await extractVacancyFromText({ ...textDeps, models: counting(adapter(on, 'extractor-8b')) }, author, TEXT);
		expect(calls).toBe(3);
		// A company that may not save a vacancy does not spend the model on a draft.
		await expect(extractVacancyFromText(textDeps, await employer('suspended'), TEXT)).rejects.toMatchObject({
			code: 'forbidden',
			details: [{ code: 'company_suspended' }]
		});
		expect(calls).toBe(3);
		// The parse belongs to its company and serves one vacancy.
		expect(
			await refusalOf(createOwnVacancy(deps, author, input(), { fromText: { mlResultId: draft.mlResultId } }))
		).toBe('validation_failed');
		expect(
			await refusalOf(createOwnVacancy(deps, await employer(), input(), { fromText: { mlResultId: draft.mlResultId } }))
		).toBe('validation_failed');
	});

	it('reads the fields by rules with quotes when the model is switched off, and says so', async () => {
		const author = await employer();
		const before = runtime.answer;
		const draft = await extractVacancyFromText(
			{ db: database.db, models: adapter(off), parseCache: memoryTextParseCache() },
			author,
			TEXT
		);
		expect(draft).toMatchObject({ mode: 'rules', modelFailure: 'disabled' });
		expect(draft.fields.title).toMatchObject({ value: 'Senior Python-разработчик', quote: { blockId: 'p1' } });
		expect(draft.fields.roleKey).toBe('backend');
		expect(draft.fields.grade?.value).toEqual({ min: 'senior', max: 'senior' });
		expect(draft.fields.requiredSkills.map((s) => s.key)).toEqual(['python', 'postgresql']);
		expect(draft.fields.negatedSkills.map((s) => s.key)).toEqual(['java']);
		expect(draft.fields.salary).toMatchObject({
			value: { min: 300_000, max: 400_000, currency: 'RUB', period: 'month', taxBase: 'net' },
			quote: { blockId: 'p3' }
		});
		expect(draft.fields.workFormat?.value).toBe('remote');
		expect(draft.missing).toEqual(['employmentForm', 'contractTypes']);
		expect(draft.blocks).toHaveLength(3);
		const [envelope] = await database.db.select().from(mlResults).where(eq(mlResults.id, draft.mlResultId));
		expect(envelope).toMatchObject({
			processingMode: 'rules_only',
			rulesVersion: VACANCY_TEXT_RULES_VERSION,
			model: null,
			failure: { code: 'disabled', reason: 'switched_off' },
			rejectedItems: []
		});
		expect(runtime.answer).toBe(before);
		const saved = await createOwnVacancy(deps, author, input(), { fromText: { mlResultId: draft.mlResultId } });
		expect(saved.id).toBe(draft.vacancyId);
	});

	it('checks the pasted text for discriminatory requirements before anything is saved', async () => {
		const draft = await extractVacancyFromText(
			{ db: database.db, models: adapter(off), parseCache: memoryTextParseCache() },
			await employer(),
			'Python-разработчик\nТолько мужчины до 30 лет'
		);
		expect(draft.textCheck.result).toBe('blocked');
		expect(draft.textCheck.phrases.map((p) => p.rule).sort()).toEqual(['age.limit', 'sex.explicit']);
	});
});
