// Moderation of own vacancies by the FSP operator (docs/domain.md 13.1): the queue of vacancies a blocked text check sent
// to the operator with the phrases quoted in place, the case with its history, and the three decisions — publish (back
// to the catalog or to the pause), return for editing with a reason, reject (closed) — each with its journal event and
// the reason the company reads, and the notification of the author and the owners that names the decision and leads to
// the vacancy. A clone operator of a demo session reaches the vacancies of its session only.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { RequestMeta } from '$lib/server/auth/context';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	companyMembers,
	demoSessions,
	notifications,
	productPolicies,
	vacancies
} from '$lib/server/db/schema';
import { notificationFacts } from '$lib/server/notifications/content';
import { notificationLinks } from '$lib/server/notifications/deliver';
import { openNotification } from '$lib/server/notifications/inbox';
import { notificationLetter, telegramText } from '$lib/server/notifications/templates';
import { isNotificationType } from '$lib/server/notifications/types';
import { operatorOverview } from '$lib/server/operator/overview';
import { decideModeration, vacancyModerationCase, vacancyModerationQueue } from '$lib/server/operator/vacancies';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import {
	createOwnVacancy,
	pauseOwnVacancy,
	publishOwnVacancy,
	updateOwnVacancy,
	type VacancyAuthor,
	type VacancyDeps
} from '$lib/server/vacancies/own';
import { textCheckSchema } from '$lib/server/vacancies/text-check';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCompany, createMember, createUser } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const BLOCKED = 'Разрабатываем платёжные сервисы на Go. Гражданство РФ обязательно: работа с гостайной.';
const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 8)
});

let database: TestDatabase;
let deps: VacancyDeps;
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
	// The case shows the vacancy as its company sees it, with the pool counter and its small-count threshold.
	await database.db.insert(productPolicies).values({
		kind: 'catalog_policy',
		version: 1,
		params: { small_count_threshold: 5 },
		effectiveFrom: new Date(Date.now() - 86_400_000)
	});
});

afterAll(async () => {
	await database.drop();
});

async function operator(demoSessionId: string | null = null): Promise<AccessSubject> {
	const user = await createUser(database.db, { demoSessionId });
	return {
		userId: user.id,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: true, admin: false, extraPermissions: [] }
	};
}

async function demoSession(): Promise<string> {
	const [row] = await database.db
		.insert(demoSessions)
		.values({
			joinTokenSha256: randomBytes(32).toString('hex'),
			seedBatchId: 'moderation-batch',
			expiresAt: new Date(Date.now() + 86_400_000)
		})
		.returning();
	if (!row) throw new Error('demo session not inserted');
	return row.id;
}

async function employer(demoSessionId: string | null = null): Promise<VacancyAuthor> {
	const company = await createCompany(database.db, { demoSessionId, displayName: `Компания ${randomUUID()}` });
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

async function inModeration(author: VacancyAuthor, description = BLOCKED): Promise<string> {
	const draft = await createOwnVacancy(deps, author, input(description));
	const outcome = await publishOwnVacancy(deps, author, draft.id);
	expect(outcome.status).toBe('pending_moderation');
	return draft.id;
}

async function stored(vacancyId: string) {
	const [row] = await database.db.select().from(vacancies).where(eq(vacancies.id, vacancyId));
	if (!row) throw new Error('vacancy missing');
	return { ...row, check: textCheckSchema.parse(row.textCheck) };
}

/** The revision the operator reads in the case: the one a decision names. */
const revisionOf = async (vacancyId: string) => (await stored(vacancyId)).revision;

async function decidedEvent(vacancyId: string) {
	const [event] = await database.db
		.select({ details: auditEvents.details, actorUserId: auditEvents.actorUserId })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'vacancy.moderation_decided'), eq(auditEvents.objectId, vacancyId)));
	return event;
}

describe('queue of vacancy moderation', () => {
	it('lists vacancies in moderation with the company, the moment and the quoted phrases', async () => {
		const reviewer = await operator();
		const author = await employer();
		const vacancyId = await inModeration(author);
		const queue = await vacancyModerationQueue(database.db, reviewer);
		const item = queue.find((entry) => entry.vacancyId === vacancyId);
		expect(item).toMatchObject({
			title: 'Backend-разработчик на Go',
			company: { id: author.companyId, status: 'verified' },
			openedAt: expect.any(Date) as Date,
			resumeTo: 'published',
			findings: [
				{
					rule: 'citizenship.required',
					category: 'citizenship',
					field: 'description',
					quote: {
						before: 'Разрабатываем платёжные сервисы на Go. ',
						text: 'Гражданство РФ',
						after: ' обязательно: работа с гостайной.'
					}
				}
			]
		});
		const overview = await operatorOverview(database.db, reviewer, new Date());
		expect(overview.vacancies.pending).toBe(queue.length);
	});

	it('shows the case with its history', async () => {
		const reviewer = await operator();
		const vacancyId = await inModeration(await employer());
		const opened = await vacancyModerationCase(database.db, reviewer, vacancyId, new Date());
		expect(opened.vacancy.status).toBe('pending_moderation');
		expect(opened.history).toEqual([
			expect.objectContaining({ action: 'vacancy.blocked_text_check', by: 'company', decision: null })
		]);
		await decideModeration(
			database.db,
			reviewer,
			meta(),
			vacancyId,
			'return',
			'Уберите требование гражданства',
			await revisionOf(vacancyId)
		);
		const decided = await vacancyModerationCase(database.db, reviewer, vacancyId, new Date());
		expect(decided.history.map((entry) => [entry.action, entry.by, entry.decision])).toEqual([
			['vacancy.blocked_text_check', 'company', null],
			['vacancy.moderation_decided', 'operator', 'returned']
		]);
	});
});

describe('decision on a vacancy in moderation', () => {
	it('publishes a lawful requirement: the vacancy goes to the catalog and leaves the queue', async () => {
		const reviewer = await operator();
		const vacancyId = await inModeration(await employer());
		await decideModeration(
			database.db,
			reviewer,
			meta(),
			vacancyId,
			'publish',
			'Допуск к гостайне по закону',
			await revisionOf(vacancyId)
		);
		const row = await stored(vacancyId);
		expect(row.status).toBe('published');
		expect(row.publishedAt).not.toBeNull();
		expect(row.check.moderation?.decision).toMatchObject({
			outcome: 'published',
			reason: 'Допуск к гостайне по закону'
		});
		expect(await decidedEvent(vacancyId)).toEqual({
			details: { decision: 'published', status: 'published', rules: ['citizenship.required'] },
			actorUserId: reviewer.userId
		});
		const queue = await vacancyModerationQueue(database.db, reviewer);
		expect(queue.map((entry) => entry.vacancyId)).not.toContain(vacancyId);
	});

	it('publishes a vacancy that was paused before the edit back into the pause', async () => {
		const reviewer = await operator();
		const author = await employer();
		const draft = await createOwnVacancy(deps, author, input('Разрабатываем платёжные сервисы на Go и PostgreSQL.'));
		await publishOwnVacancy(deps, author, draft.id);
		await pauseOwnVacancy(deps, author, draft.id);
		await updateOwnVacancy(deps, author, draft.id, input(BLOCKED));
		await decideModeration(database.db, reviewer, meta(), draft.id, 'publish', '', await revisionOf(draft.id));
		expect((await stored(draft.id)).status).toBe('paused');
	});

	it('returns the vacancy to a draft with the reason the company reads', async () => {
		const reviewer = await operator();
		const vacancyId = await inModeration(await employer());
		await expect(
			decideModeration(database.db, reviewer, meta(), vacancyId, 'return', '  ', await revisionOf(vacancyId))
		).rejects.toMatchObject({
			code: 'validation_failed'
		});
		await decideModeration(
			database.db,
			reviewer,
			meta(),
			vacancyId,
			'return',
			'Уберите требование гражданства',
			await revisionOf(vacancyId)
		);
		const row = await stored(vacancyId);
		expect(row.status).toBe('draft');
		expect(row.check.moderation?.decision).toMatchObject({
			outcome: 'returned',
			reason: 'Уберите требование гражданства'
		});
		expect((await decidedEvent(vacancyId))?.details).toEqual({
			decision: 'returned',
			status: 'draft',
			rules: ['citizenship.required']
		});
	});

	it('rejects the vacancy: it is closed with the reason', async () => {
		const reviewer = await operator();
		const vacancyId = await inModeration(await employer());
		await expect(
			decideModeration(database.db, reviewer, meta(), vacancyId, 'reject', '', await revisionOf(vacancyId))
		).rejects.toMatchObject({
			code: 'validation_failed'
		});
		await decideModeration(
			database.db,
			reviewer,
			meta(),
			vacancyId,
			'reject',
			'Требование не основано на законе',
			await revisionOf(vacancyId)
		);
		const row = await stored(vacancyId);
		expect(row.status).toBe('closed');
		expect(row.closedAt).not.toBeNull();
		expect(row.check.moderation?.decision).toMatchObject({ outcome: 'rejected' });
		const [closed] = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'vacancy.closed'), eq(auditEvents.objectId, vacancyId)));
		expect(closed?.details).toEqual({ from: 'pending_moderation' });
	});

	it('answers a second decision and a cleared text with a conflict', async () => {
		const reviewer = await operator();
		const author = await employer();
		const decided = await inModeration(author);
		await decideModeration(
			database.db,
			reviewer,
			meta(),
			decided,
			'reject',
			'Не основано на законе',
			await revisionOf(decided)
		);
		await expect(
			decideModeration(database.db, reviewer, meta(), decided, 'publish', '', await revisionOf(decided))
		).rejects.toMatchObject({
			code: 'conflict'
		});
		const cleared = await inModeration(author);
		await updateOwnVacancy(deps, author, cleared, input('Разрабатываем платёжные сервисы на Go и PostgreSQL.'));
		await expect(
			decideModeration(database.db, reviewer, meta(), cleared, 'publish', '', await revisionOf(cleared))
		).rejects.toMatchObject({
			code: 'conflict'
		});
	});

	it('refuses an employer that is not an operator', async () => {
		const author = await employer();
		const vacancyId = await inModeration(author);
		const member: AccessSubject = {
			userId: author.audit.kind === 'user' ? author.audit.userId : null,
			via: 'session',
			candidate: null,
			membership: {
				memberId: author.memberId,
				companyId: author.companyId,
				role: 'owner',
				status: 'active',
				companyStatus: 'verified'
			},
			staff: { operator: false, admin: false, extraPermissions: [] }
		};
		await expect(vacancyModerationQueue(database.db, member)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			decideModeration(database.db, member, meta(), vacancyId, 'publish', '', await revisionOf(vacancyId))
		).rejects.toMatchObject({
			code: 'forbidden'
		});
	});
});

describe('a clone operator of a demo session', () => {
	it('sees and decides the vacancies of its own session only', async () => {
		const session = await demoSession();
		const other = await demoSession();
		const clone = await operator(session);
		const person = await operator();
		const own = await inModeration(await employer(session));
		const foreign = await inModeration(await employer(other));
		const stand = await inModeration(await employer());

		const seen = (await vacancyModerationQueue(database.db, clone)).map((entry) => entry.vacancyId);
		expect(seen).toEqual([own]);
		expect((await operatorOverview(database.db, clone, new Date())).vacancies.pending).toBe(1);
		const standSeen = (await vacancyModerationQueue(database.db, person)).map((entry) => entry.vacancyId);
		expect(standSeen).toContain(stand);
		expect(standSeen).not.toContain(own);

		for (const vacancyId of [foreign, stand]) {
			await expect(vacancyModerationCase(database.db, clone, vacancyId, new Date())).rejects.toMatchObject({
				code: 'not_found'
			});
			await expect(
				decideModeration(database.db, clone, meta(), vacancyId, 'publish', '', await revisionOf(vacancyId))
			).rejects.toMatchObject({
				code: 'not_found'
			});
			expect((await stored(vacancyId)).status).toBe('pending_moderation');
		}
		await decideModeration(database.db, clone, meta(), own, 'publish', '', await revisionOf(own));
		expect((await stored(own)).status).toBe('published');
	});
});

describe('notification of a moderation decision', () => {
	const notificationsOf = (vacancyId: string) =>
		database.db
			.select()
			.from(notifications)
			.where(and(eq(notifications.objectId, vacancyId), eq(notifications.type, 'vacancy.moderation_decided')))
			.orderBy(notifications.createdAt, notifications.id);

	/** The letter the recipient would get now; `null` — the vacancy is no longer theirs. */
	async function letterOf(notification: typeof notifications.$inferSelect) {
		if (!isNotificationType(notification.type)) throw new Error(`unknown type ${notification.type}`);
		const facts = await notificationFacts(database.db, crypto, { ...notification, type: notification.type });
		if (!facts) return null;
		return notificationLetter(
			'someone@example.org',
			notification.type,
			facts,
			notification.payload as Record<string, unknown>,
			notificationLinks('https://career.test', notification.id)
		);
	}

	it('reaches the author and the active owners once each, names the decision without the reason', async () => {
		const reviewer = await operator();
		const author = await employer();
		const owner = await createMember(database.db, author.companyId);
		const recruiter = await createMember(database.db, author.companyId, { role: 'recruiter' });
		const removed = await createMember(database.db, author.companyId, { status: 'removed', removedAt: new Date() });
		const vacancyId = await inModeration(author);
		const reason = 'Уберите требование гражданства: допуск к гостайне по этой должности не нужен';
		await decideModeration(database.db, reviewer, meta(), vacancyId, 'return', reason, await revisionOf(vacancyId));

		const sent = await notificationsOf(vacancyId);
		const authorUser = author.audit.kind === 'user' ? author.audit.userId : null;
		expect(sent.map((n) => n.userId).sort()).toEqual([authorUser, owner.userId].sort());
		expect(sent.map((n) => n.userId)).not.toContain(recruiter.userId);
		expect(sent.map((n) => n.userId)).not.toContain(removed.userId);
		for (const notification of sent) {
			expect(notification).toMatchObject({
				category: 'account',
				objectType: 'vacancy',
				payload: { vacancy_id: vacancyId, decision: 'returned', status: 'draft' }
			});
		}
		const [first] = sent;
		if (!first) throw new Error('no notification');
		const letter = await letterOf(first);
		expect(letter?.subject).toBe('Вакансия возвращена на правку — ФСП | Карьера');
		expect(letter?.text).toContain('«Backend-разработчик на Go»');
		expect(letter?.text).not.toContain(reason);
		expect(telegramText('vacancy.moderation_decided')).toBe('Решение модерации по вакансии — ФСП | Карьера');
		const opened = await openNotification(database.db, first.userId, first.id, new Date());
		expect(opened?.target).toEqual({ kind: 'company_vacancy', vacancyId });
	});

	it('tells each decision of a new case apart and names publication and rejection', async () => {
		const reviewer = await operator();
		const author = await employer();
		const vacancyId = await inModeration(author);
		await decideModeration(
			database.db,
			reviewer,
			meta(),
			vacancyId,
			'return',
			'Уберите требование гражданства',
			await revisionOf(vacancyId)
		);
		await publishOwnVacancy(deps, author, vacancyId);
		await decideModeration(database.db, reviewer, meta(), vacancyId, 'publish', '', await revisionOf(vacancyId));
		const rejected = await inModeration(author);
		await decideModeration(
			database.db,
			reviewer,
			meta(),
			rejected,
			'reject',
			'Требование не основано на законе',
			await revisionOf(rejected)
		);

		const decided = await notificationsOf(vacancyId);
		expect(decided.map((n) => (n.payload as { decision: string }).decision)).toEqual(['returned', 'published']);
		const published = decided[1];
		if (!published) throw new Error('no notification of the publication');
		expect((await letterOf(published))?.subject).toBe('Вакансия прошла модерацию — ФСП | Карьера');
		const [closed] = await notificationsOf(rejected);
		if (!closed) throw new Error('no notification of the rejection');
		expect(closed.payload).toMatchObject({ decision: 'rejected', status: 'closed' });
		expect((await letterOf(closed))?.subject).toBe('Вакансия отклонена модерацией — ФСП | Карьера');
	});

	it('leads nowhere and writes nothing to a member who left the company', async () => {
		const reviewer = await operator();
		const author = await employer();
		const vacancyId = await inModeration(author);
		await decideModeration(
			database.db,
			reviewer,
			meta(),
			vacancyId,
			'reject',
			'Требование не основано на законе',
			await revisionOf(vacancyId)
		);
		const [notification] = await notificationsOf(vacancyId);
		if (!notification) throw new Error('no notification');
		await database.db
			.update(companyMembers)
			.set({ status: 'removed', removedAt: new Date() })
			.where(eq(companyMembers.id, author.memberId));
		expect(await letterOf(notification)).toBeNull();
		const opened = await openNotification(database.db, notification.userId, notification.id, new Date());
		expect(opened?.target).toEqual({ kind: 'unavailable' });
	});
});
