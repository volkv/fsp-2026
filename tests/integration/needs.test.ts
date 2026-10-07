// Hiring needs of a company (docs/domain.md, section 13.10): the text is parsed by the rules into a form with quotes
// when the model is off, the fields the employer filled stay over the suggestion, closed specializations are not
// suggested — open is switched on in the catalog and with a released bank — a blocked text and a range not in roubles are refused, and the recommended categories count the
// candidates of a category in force the company sees — through `canShow`, so a minor and a hidden profile are not
// counted and small numbers are «< 5». Only members of the company see its needs.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { consentEvents, hiringNeeds, mlResults, productPolicies, sourceFacts } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { fail } from '$lib/server/ml/result';
import { createNeed, getNeed, needCategories, updateNeed, type NeedDeps } from '$lib/server/needs/service';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { releaseFixtureBank } from '../helpers/bank';
import { decide, invalidate } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createCompany, createMember, createPublishedDocument } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;

let database: TestDatabase;
let catalogDocumentId: string;
const meta = { requestId: 'test-needs', ip: '127.0.0.1', userAgent: 'vitest' };

const modelsOff: NeedDeps['models'] = {
	extract: () => Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' }))
};

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const effectiveFrom = new Date(Date.now() - 10 * DAY);
	await database.db.insert(productPolicies).values([
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 5 }, effectiveFrom },
		{ kind: 'minor_policy', version: 1, params: { enabled: true, authority_methods: ['in_person'] }, effectiveFrom }
	]);
	// Data and ML is switched on in the catalog but has no released bank: closed.
	for (const specialization of ['backend', 'frontend', 'qa'] as const) {
		await releaseFixtureBank(database.db, specialization);
	}
	catalogDocumentId = (
		await createPublishedDocument(database.db, 'catalog_visibility', { publishedAt: new Date(Date.now() - 10 * DAY) })
	).id;
});

afterAll(async () => {
	await database.drop();
});

const deps = (): NeedDeps => ({ db: database.db, models: modelsOff, now: () => new Date() });

async function employer(status: 'verified' | 'submitted' | 'suspended' = 'verified') {
	const company = await createCompany(database.db, { status });
	const member = await createMember(database.db, company.id);
	if (!member.userId) throw new Error('member without user');
	const subject: AccessSubject = {
		userId: member.userId,
		via: 'session',
		candidate: null,
		membership: {
			memberId: member.id,
			companyId: company.id,
			role: 'recruiter',
			status: 'active',
			companyStatus: status
		},
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { company, member, subject };
}

/** A candidate in the catalog: the processing consent of the factory and the catalog consent. */
async function listed(birthDate = '1996-04-12') {
	const row = await createCandidate(database.db, { visibility: 'catalog', birthDate });
	await database.db.insert(consentEvents).values({
		subjectCandidateId: row.id,
		kind: 'catalog_visibility',
		documentId: catalogDocumentId,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: row.userId,
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: new Date(Date.now() - DAY)
	});
	return row;
}

/** An official FSP result of the candidate's own, as the synchronization stores it: an algorithmic one confirms no skill of a backend need. */
async function fspResult(candidateId: string) {
	const competitionId = randomBytes(6).toString('hex');
	const resultId = randomBytes(6).toString('hex');
	await database.db.insert(sourceFacts).values({
		candidateId,
		source: 'fsp',
		factType: 'competition_result',
		sourceRecordRef: `fsp:result:${resultId}`,
		eventKey: `fsp:competition:${competitionId}`,
		trustLevel: 'fsp_verified',
		ownershipBasis: 'operator_confirmed',
		payload: {
			result: { id: resultId, competitionId, place: 3, award: 'prize', status: 'official' },
			competition: {
				id: competitionId,
				title: 'Кубок',
				discipline: 'algorithmic',
				level: 'russian_cup',
				startDate: '2026-03-01'
			}
		},
		payloadSha256: randomBytes(32).toString('hex'),
		occurredOn: '2026-03-01',
		observedAt: new Date(),
		lastVerifiedAt: new Date(),
		status: 'active'
	});
}

async function apiError(operation: Promise<unknown>): Promise<ApiError> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('the operation was expected to be refused');
}

describe('a hiring need', () => {
	it('is parsed by the rules without the model, each suggested field with its quote, recorded as such', async () => {
		const { subject, company } = await employer();
		const need = await createNeed(deps(), subject, meta, {
			text: 'Ищем QA-инженера уровня junior.\nНужны SQL и Python. Удалённо, вилка 120–150 тыс. ₽ на руки.'
		});
		expect(need.form).toMatchObject({
			specialization: 'qa',
			grade: { min: 'junior', max: 'junior' },
			work_format: 'remote'
		});
		expect(need.form.skill_keys).toEqual(expect.arrayContaining(['sql', 'python']));
		expect(need.form.salary).toEqual({ min: 120_000, max: 150_000, currency: 'RUB', period: 'month', tax_base: 'net' });
		expect(need.parse).toMatchObject({ mode: 'rules', model_failure: 'disabled', model: null });
		for (const field of need.parse?.fields ?? []) expect(need.text).toContain(field.quote);
		const [envelope] = await database.db
			.select()
			.from(mlResults)
			.where(eq(mlResults.id, need.parse?.ml_result_id ?? ''));
		expect(envelope).toMatchObject({
			processingMode: 'rules_only',
			inputRef: { type: 'hiring_need', id: need.id, company_id: company.id }
		});
		expect(need.status).toBe('draft');
	});

	it('takes the role from the title: a stack line never names it, a role no test checks keeps no specialization', async () => {
		const { subject } = await employer();
		const form = async (text: string) => (await createNeed(deps(), subject, meta, { text })).form;
		// Python in the requirements is a tool, not the position: the data engineer is not a backend developer.
		for (const text of [
			'Дата-инженер\nТребования: Python, SQL, Airflow.',
			'Data Engineer (Middle)\nPython, Spark, Airflow\nОпыт с Python от 3 лет.',
			'Аналитик данных\nНужны SQL и Python.',
			// A title inside a sentence of search, inflected.
			'Ищем аналитика данных в команду маркетинга\nНужны SQL и Python.',
			'Приглашаем в команду дата-инженера\nСтек: Python, Spark, Airflow.'
		]) {
			const read = await form(text);
			expect(read.specialization).toBeUndefined();
			expect(['data_engineer', 'data_analyst']).toContain(read.role_key);
		}
		expect(await form('Системный аналитик\nТребования: SQL, BPMN, REST.')).toMatchObject({
			role_key: 'systems_analyst'
		});
		// A title without a role and a line of a stack: no role at all rather than one read from the stack.
		const untitled = await form('Команда платформы данных\nPython, Kafka, ClickHouse');
		expect(untitled.role_key).toBeUndefined();
		expect(untitled.specialization).toBeUndefined();
		expect(await form('Открыта вакансия на позицию QA-инженера\nНужны SQL и Postman.')).toMatchObject({
			role_key: 'qa_manual',
			specialization: 'qa'
		});
		// A role of one specialization gives it; fullstack takes its first half and offers the second.
		expect(await form('Python-разработчик\nНужны Django и PostgreSQL.')).toMatchObject({
			role_key: 'backend',
			specialization: 'backend'
		});
		const fullstack = await form('Fullstack-разработчик (React + Node.js)\nТребования: TypeScript, PostgreSQL.');
		expect(fullstack.role_key).toBe('fullstack');
		expect(fullstack.specialization).toBeUndefined();
		const { basis, categories } = await needCategories(
			deps(),
			subject,
			(await createNeed(deps(), subject, meta, { form: { ...fullstack } })).id
		);
		expect(basis).toBe('role');
		const of = (b: string) => [...new Set(categories.filter((c) => c.basis === b).map((c) => c.specialization))];
		expect(of('role')).toEqual(['backend']);
		expect(of('composite_role')).toEqual(['frontend']);
	});

	it('keeps a required tool the taxonomy does not know by its name, never a broader skill, and not a negated one', async () => {
		const { subject } = await employer();
		const form = async (text: string) => (await createNeed(deps(), subject, meta, { text })).form;
		const ml = await form('ML-инженер\nТребования: Python, Hugging Face, Docker.');
		expect(ml.other_skills).toEqual(['Hugging Face']);
		expect(ml.skill_keys).toEqual(expect.arrayContaining(['python', 'docker']));
		const variants = await form(
			'Backend-разработчик\nСтек: Go, PostgreSQL, Temporal\nБудет плюсом: опыт с Camunda\nKotlin не требуется'
		);
		expect(variants.other_skills).toEqual(['Temporal']);
		expect(variants.other_nice_skills).toEqual(['Camunda']);
		expect(JSON.stringify(variants)).not.toContain('Kotlin');
		// Prose of requirements names no tool.
		const prose = await form('QA-инженер\nТребования: опыт от 2 лет, умение писать тест-кейсы, внимательность.');
		expect(prose.other_skills).toBeUndefined();
	});

	it('takes the region from a city in any case, never from a city outside the reference', async () => {
		const { subject } = await employer();
		const region = async (text: string) => (await createNeed(deps(), subject, meta, { text })).form.region_code;
		expect(await region('Go-разработчик\nОфис в Казани, гибрид.\nНужны Go и PostgreSQL.')).toBe('RU-TA');
		expect(await region('Backend-разработчик\nРабота в Нижнем Новгороде, офис.\nНужен Python.')).toBe('RU-NIZ');
		expect(await region('QA-инженер\nГород: Екатеринбург\nНужен SQL.')).toBe('RU-SVE');
		expect(await region('Frontend-разработчик\nМосква, офис у метро.\nНужен React.')).toBe('RU-MOW');
		expect(await region('Backend-разработчик\nОфис: г. Ташкент\nНужен Go.')).toBeUndefined();
		expect(await region('Backend-разработчик\nКонтакт: Владимир\nНужен Go.')).toBeUndefined();
	});

	it('reads a range of grades: «Middle/Senior», «от Junior», a grade above the catalog as its top', async () => {
		const { subject } = await employer();
		const read = async (text: string) => (await createNeed(deps(), subject, meta, { text })).form.grade;
		expect(await read('Ищем бэкенд-разработчика Middle/Senior.\nНужны Go и PostgreSQL.')).toEqual({
			min: 'middle',
			max: 'senior'
		});
		expect(await read('Бэкенд-разработчик от Junior\nНужны Go и PostgreSQL.')).toEqual({
			min: 'junior',
			max: 'senior'
		});
		expect(await read('Senior/Lead бэкенд-разработчик\nНужны Go и PostgreSQL.')).toEqual({
			min: 'senior',
			max: 'senior'
		});
		expect(await read('Senior C++ разработчик\nНужен C++.')).toEqual({ min: 'senior', max: 'senior' });
	});

	it('keeps what the employer filled over the suggestion and does not suggest a closed specialization', async () => {
		const { subject } = await employer();
		const need = await createNeed(deps(), subject, meta, {
			text: 'Ищем Android-разработчика уровня middle на Kotlin.',
			form: { skill_keys: ['kotlin'], nice_skill_keys: [], grade: { min: 'senior', max: 'senior' } }
		});
		// Mobile is switched off in the catalog: not suggested; the grade is the employer's.
		expect(need.form.specialization).toBeUndefined();
		expect(need.form.grade).toEqual({ min: 'senior', max: 'senior' });
		expect(need.form.skill_keys).toEqual(['kotlin']);

		const closed = await apiError(
			createNeed(deps(), subject, meta, { form: { skill_keys: [], nice_skill_keys: [], specialization: 'mobile' } })
		);
		expect([closed.code, closed.details?.[0]?.code]).toEqual(['policy_violation', 'specialization_closed']);
		const unreleased = await apiError(
			createNeed(deps(), subject, meta, { form: { skill_keys: [], nice_skill_keys: [], specialization: 'data_ml' } })
		);
		expect([unreleased.code, unreleased.details?.[0]?.code]).toEqual(['policy_violation', 'specialization_closed']);
	});

	it('refuses a blocked text, a range not in roubles and a need of another company', async () => {
		const { subject } = await employer();
		const blocked = await apiError(
			createNeed(deps(), subject, meta, { text: 'Ищем бэкенд-разработчика, только мужчин до 35 лет.' })
		);
		expect([blocked.code, blocked.details?.[0]?.code]).toEqual(['policy_violation', 'text_blocked']);
		const usd = await apiError(
			createNeed(deps(), subject, meta, {
				form: {
					skill_keys: [],
					nice_skill_keys: [],
					salary: { min: 3_000, max: 5_000, currency: 'USD', period: 'month', tax_base: 'gross' }
				}
			})
		);
		expect([usd.code, usd.details?.[0]?.code]).toEqual(['policy_violation', 'salary_not_rub']);

		const need = await createNeed(deps(), subject, meta, { form: { skill_keys: ['go'], nice_skill_keys: [] } });
		const other = await employer();
		expect((await apiError(getNeed(deps(), other.subject, need.id))).code).toBe('not_found');
		expect((await apiError(updateNeed(deps(), other.subject, meta, need.id, { status: 'closed' }))).code).toBe(
			'not_found'
		);
		const stored = await database.db.select().from(hiringNeeds).where(eq(hiringNeeds.companyId, other.company.id));
		expect(stored).toEqual([]);
	});

	it('is closed to a company the admission policy refused and open to one without a check', async () => {
		const unverified = await employer('submitted');
		expect(
			await createNeed(deps(), unverified.subject, meta, { form: { skill_keys: ['go'], nice_skill_keys: [] } })
		).toMatchObject({ status: 'draft' });
		const suspended = await employer('suspended');
		const refused = await apiError(
			createNeed(deps(), suspended.subject, meta, { form: { skill_keys: ['go'], nice_skill_keys: [] } })
		);
		expect([refused.code, refused.details?.[0]?.code]).toEqual(['forbidden', 'company_suspended']);
	});
});

describe('recommended categories of a need', () => {
	it('count only the candidates the company sees, small numbers as «< 5»', async () => {
		const { subject } = await employer();
		const need = await createNeed(deps(), subject, meta, {
			form: {
				specialization: 'backend',
				grade: { min: 'middle', max: 'middle' },
				skill_keys: ['go'],
				nice_skill_keys: []
			}
		});
		const seen = [];
		for (let i = 0; i < 6; i++) seen.push(await listed());
		const hidden = await createCandidate(database.db, { visibility: 'hidden' });
		const minor = await listed(`${new Date().getUTCFullYear() - 16}-03-01`);
		const [first, ...rest] = seen;
		if (!first) throw new Error('no candidate');
		// Categories confirmed by a test, through the one owner of categories.
		for (const person of [...rest, hidden, minor]) {
			await decide(database.db, person.id, { specialization: 'backend', grade: 'middle' });
		}
		await decide(database.db, first.id, { specialization: 'backend', grade: 'senior' });
		// «С ФСП» is the shortlist's «есть результаты ФСП»: any FSP fact in force, not only one confirming a required skill.
		for (const person of [...rest, hidden]) await fspResult(person.id);

		const { categories } = await needCategories(deps(), subject, need.id);
		expect(categories.map((c) => [c.grade, c.basis])).toEqual([
			['middle', 'form'],
			['junior', 'neighbour_grade'],
			['senior', 'neighbour_grade']
		]);
		// Five adults in the catalog: the hidden profile and the minor without a vacancy are not counted.
		expect(categories[0]?.candidates).toEqual({ value: 5 });
		expect(categories[1]?.candidates).toEqual({ value: 0 });
		expect(categories[2]?.candidates).toEqual({ below: 5 });
		expect(categories[0]?.withFsp).toEqual({ value: 5 });
		expect(categories[2]?.withFsp).toEqual({ value: 0 });
	});

	it('count only categories in force: a revoked one is not counted', async () => {
		const { subject } = await employer();
		const need = await createNeed(deps(), subject, meta, {
			form: { specialization: 'frontend', grade: { min: 'junior', max: 'junior' }, skill_keys: [], nice_skill_keys: [] }
		});
		const person = await listed();
		const { decision } = await decide(database.db, person.id, { specialization: 'frontend', grade: 'junior' });
		const counted = await needCategories(deps(), subject, need.id);
		expect(counted.categories[0]).toMatchObject({ grade: 'junior', candidates: { below: 5 } });
		await invalidate(database.db, person.id, decision.id, 'decision_annulled');
		const after = await needCategories(deps(), subject, need.id);
		expect(after.categories[0]).toMatchObject({ grade: 'junior', candidates: { value: 0 } });
	});
});
