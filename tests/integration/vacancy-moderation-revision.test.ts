// The operator's decision names the revision of the vacancy it was taken on (docs/domain.md 13.1): the employer may edit
// a vacancy in moderation, and a new text that is still blocked stays with the operator under a new revision. A decision
// on the revision the operator read before the edit is refused with `409 vacancy_changed` and changes nothing — the
// vacancy is not published with a text nobody has seen; a decision on the current revision is taken. Through the API
// the revision is a required field of the body, and the queue names the revision its findings are of.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import type { AccessSubject } from '$lib/server/access/permissions';
import { runOperation, type Operation } from '$lib/server/api/operation';
import type { ApiServices } from '$lib/server/api/services';
import * as operatorApi from '$lib/server/api/v1/operator';
import type { RequestMeta } from '$lib/server/auth/context';
import { registryNotConfigured } from '$lib/server/companies/registry';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import { auditEvents, staffRoles, vacancies } from '$lib/server/db/schema';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { fail } from '$lib/server/ml/result';
import { decideModeration, vacancyModerationQueue } from '$lib/server/operator/vacancies';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import {
	createOwnVacancy,
	decideVacancyModeration,
	publishOwnVacancy,
	updateOwnVacancy,
	type VacancyAuthor,
	type VacancyDeps
} from '$lib/server/vacancies/own';
import { textCheckSchema } from '$lib/server/vacancies/text-check';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCompany, createMember, createUser, randomSha256 } from '../helpers/factories';
import { noFiles } from '../helpers/storage';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const BLOCKED = 'Разрабатываем платёжные сервисы на Go. Гражданство РФ обязательно: работа с гостайной.';
/** Another text blocked by the same rule: the vacancy stays in moderation with a new revision. */
const BLOCKED_AGAIN =
	'Разрабатываем платёжные сервисы на Go и Kafka. Гражданство РФ обязательно, дежурства по выходным без оплаты.';

let database: TestDatabase;
let deps: VacancyDeps;
let services: ApiServices;
const meta = (): RequestMeta => ({ requestId: `test-${randomUUID()}`, ip: '10.0.0.1', userAgent: 'vitest' });

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	deps = { db: database.db, now: () => new Date() };
	services = {
		db: database.db,
		// The decision is not idempotent by key: the operation never asks for Redis.
		redis: () => Promise.reject(new Error('redis is not used by the moderation operations')),
		crypto: createFieldCrypto({
			keys: new Map([[1, Buffer.alloc(32, 7)]]),
			activeVersion: 1,
			hmacSecret: Buffer.alloc(32, 8)
		}),
		mailer: { send: () => Promise.reject(new Error('no letters in moderation')) },
		store: noFiles,
		registry: registryNotConfigured,
		models: {
			embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
			rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' })),
			extract: () => Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' })),
			extractModelKey: () => Promise.resolve(null)
		},
		receiptSigner: createReceiptSigner({ issuer: 'http://app.test', keyId: 'test-1', seed: Buffer.alloc(32, 5) }),
		appOrigin: 'http://app.test',
		now: () => new Date(),
		testResults: GRADE_DECISION_RESULTS
	};
});

afterAll(async () => {
	await database.drop();
});

async function operator(): Promise<AccessSubject> {
	const user = await createUser(database.db);
	await database.db.insert(staffRoles).values({ userId: user.id, role: 'operator', grantedAt: new Date() });
	return {
		userId: user.id,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: true, admin: false, extraPermissions: [] }
	};
}

async function employer(): Promise<VacancyAuthor> {
	const company = await createCompany(database.db, { displayName: `Компания ${randomUUID()}` });
	const member = await createMember(database.db, company.id);
	if (!member.userId) throw new Error('member without user');
	return {
		memberId: member.id,
		companyId: company.id,
		audit: { kind: 'user', userId: member.userId, companyId: company.id },
		requestId: 'req-test'
	};
}

const input = (description: string) => ({
	title: 'Backend-разработчик на Go',
	description,
	roleKey: 'backend',
	gradeMin: 'middle',
	gradeMax: 'senior',
	requiredSkillKeys: ['go'],
	niceSkillKeys: [],
	workFormat: 'remote',
	employmentForm: 'full',
	contractTypes: ['labor'],
	cityId: null,
	timezoneOverlapHours: null,
	salary: { min: 250_000, max: 350_000, currency: 'RUB', period: 'month', taxBase: 'gross' }
});

/**
 * A vacancy in moderation that the employer edited after the operator opened it: the revision the operator read and
 * the current one, both blocked.
 */
async function editedInModeration(author: VacancyAuthor): Promise<{ id: string; seen: number; current: number }> {
	const draft = await createOwnVacancy(deps, author, input(BLOCKED));
	const outcome = await publishOwnVacancy(deps, author, draft.id);
	expect(outcome.status).toBe('pending_moderation');
	const seen = outcome.vacancy.revision;
	const edited = await updateOwnVacancy(deps, author, draft.id, input(BLOCKED_AGAIN));
	expect(edited.status).toBe('pending_moderation');
	expect(edited.revision).toBe(seen + 1);
	return { id: draft.id, seen, current: edited.revision };
}

async function stored(vacancyId: string) {
	const [row] = await database.db.select().from(vacancies).where(eq(vacancies.id, vacancyId));
	if (!row) throw new Error('vacancy missing');
	return { ...row, check: textCheckSchema.parse(row.textCheck) };
}

async function decisionsOf(vacancyId: string): Promise<number> {
	const rows = await database.db
		.select({ id: auditEvents.id })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'vacancy.moderation_decided'), eq(auditEvents.objectId, vacancyId)));
	return rows.length;
}

async function expectUndecided(vacancyId: string, description: string): Promise<void> {
	const row = await stored(vacancyId);
	expect(row.status).toBe('pending_moderation');
	expect(row.publishedAt).toBeNull();
	expect(row.description).toBe(description);
	expect(row.check.moderation?.decision).toBeNull();
	expect(await decisionsOf(vacancyId)).toBe(0);
}

describe('the revision of a moderation decision', () => {
	it('refuses a decision on the revision read before the edit and publishes nothing', async () => {
		const reviewer = await operator();
		const { id, seen, current } = await editedInModeration(await employer());

		for (const decision of ['publish', 'return', 'reject'] as const) {
			await expect(
				decideModeration(database.db, reviewer, meta(), id, decision, 'Причина для компании', seen)
			).rejects.toMatchObject({
				code: 'conflict',
				status: 409,
				details: [{ code: 'vacancy_changed' }]
			});
		}
		await expectUndecided(id, BLOCKED_AGAIN);

		// The queue shows the current text under its revision: that is what the operator decides on.
		const [item] = (await vacancyModerationQueue(database.db, reviewer)).filter((entry) => entry.vacancyId === id);
		expect(item?.revision).toBe(current);
	});

	it('refuses a stale revision under the lock of the vacancy, not only in the cabinet', async () => {
		const reviewer = await operator();
		const { id, seen } = await editedInModeration(await employer());

		await expect(
			decideVacancyModeration(deps, id, {
				operatorUserId: reviewer.userId ?? '',
				decision: 'publish',
				revision: seen,
				reason: null,
				requestId: 'req-test'
			})
		).rejects.toMatchObject({ code: 'conflict', details: [{ code: 'vacancy_changed' }] });
		await expectUndecided(id, BLOCKED_AGAIN);
	});

	it('publishes the vacancy on the current revision', async () => {
		const reviewer = await operator();
		const { id, current } = await editedInModeration(await employer());

		await decideModeration(database.db, reviewer, meta(), id, 'publish', 'Допуск к гостайне по закону', current);

		const row = await stored(id);
		expect(row.status).toBe('published');
		expect(row.publishedAt).toBeInstanceOf(Date);
		expect(row.description).toBe(BLOCKED_AGAIN);
		expect(row.revision).toBe(current);
		expect(row.check.moderation?.decision?.outcome).toBe('published');
		expect(await decisionsOf(id)).toBe(1);
	});

	it('refuses a revision that is not a revision', async () => {
		const reviewer = await operator();
		const { id } = await editedInModeration(await employer());

		for (const revision of [0, Number.NaN, 1.5]) {
			await expect(decideModeration(database.db, reviewer, meta(), id, 'publish', '', revision)).rejects.toMatchObject({
				code: 'validation_failed',
				details: [{ path: 'revision' }]
			});
		}
		await expectUndecided(id, BLOCKED_AGAIN);
	});
});

describe('the revision in the API of moderation', () => {
	let requests = 0;

	async function call(operation: Operation, subject: AccessSubject, params = {}, body?: unknown) {
		const path = operation.path.replace(/\{(\w+)\}/gu, (_, name: string) => {
			const value = (params as Record<string, string>)[name];
			if (value === undefined) throw new Error(`parameter ${name} of ${operation.id} is missing`);
			return value;
		});
		const url = new URL(`http://app.test/api/v1${path}`);
		const request = new Request(url, {
			method: operation.method,
			...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
		});
		if (subject.userId === null) throw new Error('an operator without an account');
		const response = await runOperation(operation, services, {
			request,
			url,
			params,
			locals: {
				requestId: `req-${++requests}`,
				actor: {
					kind: 'session',
					userId: subject.userId,
					sessionHash: randomSha256(),
					authTime: new Date(),
					authMethod: 'password',
					csrfToken: randomBytes(8).toString('hex')
				}
			},
			getClientAddress: () => '127.0.0.1'
		});
		const text = await response.text();
		return {
			status: response.status,
			json: (text.length === 0 ? {} : JSON.parse(text)) as {
				items?: { vacancy_id: string; revision: number }[];
				error?: { code: string; details?: { path?: string; code: string }[] };
			}
		};
	}

	it('lists the revision in the queue and requires it in the decision', async () => {
		const reviewer = await operator();
		const { id, seen, current } = await editedInModeration(await employer());
		const params = { vacancy_id: id };

		const queue = await call(operatorApi.listVacancyModeration, reviewer);
		expect(queue.status).toBe(200);
		expect(queue.json.items?.find((item) => item.vacancy_id === id)?.revision).toBe(current);

		const missing = await call(operatorApi.decideVacancyModeration, reviewer, params, { decision: 'publish' });
		expect(missing.status).toBe(400);
		expect(missing.json.error?.code).toBe('validation_failed');
		expect(missing.json.error?.details?.map((detail) => detail.path)).toContain('revision');

		const stale = await call(operatorApi.decideVacancyModeration, reviewer, params, {
			decision: 'publish',
			revision: seen
		});
		expect(stale.status).toBe(409);
		expect(stale.json.error?.details?.[0]?.code).toBe('vacancy_changed');
		await expectUndecided(id, BLOCKED_AGAIN);

		const taken = await call(operatorApi.decideVacancyModeration, reviewer, params, {
			decision: 'publish',
			revision: current
		});
		expect(taken.status).toBe(204);
		expect((await stored(id)).status).toBe('published');
	});
});
