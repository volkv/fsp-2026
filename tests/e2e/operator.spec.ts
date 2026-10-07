// The FSP operator cabinet in the browser against the local infrastructure (`make infra`): an employer submits its
// company, the operator approves it from the queue and the employer is notified; the operator downloads the authority
// document of a request; a candidate's objection to a test result waits in the queue with its due date; a conflict of
// the birth date is resolved by a document; a stuck test attempt is read in full and annulled; the career outcomes
// (also by region) and the skills feedback render with their notices. Somebody who is not an operator does not get into
// the cabinet or its documents. The main screens have no accessibility violations.
//
// People register through the forms (their passwords and addresses need the keys of the running application). The
// operator role, the candidate and the objection are written directly: they are state the cabinet receives from other
// parts (the administrator's grant, the candidate cabinet).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { releaseFixtureBank } from '../helpers/bank';
import { recordDecisionIn } from '../helpers/categories';
import { and, eq } from 'drizzle-orm';
import {
	assessmentObjections,
	auditEvents,
	candidates,
	companies,
	companyMembers,
	companyVerifications,
	files,
	productPolicies,
	staffRoles,
	testArtifacts,
	testAttempts,
	testItems,
	users
} from '$lib/server/db/schema';

// `$env/dynamic/private`, which the storage needs through `$lib/server/config`, only SvelteKit provides; the hook that
// resolves it for a plain Node test process is registered process-wide (`playwright.config.ts`).
const { objectStore } = await import('$lib/server/storage/object-store');
// The keys of the running application encrypt the name and the address the case of a birth date shows.
const { fieldCrypto } = await import('$lib/server/crypto/fields');

const PASSWORD = 'e2e passphrase long';

// The pool of the application's own module: `closeDb` in `afterAll` ends it and the next query opens a new one, so a
// worker that comes back to this file for another group of its tests (fullyParallel) still reaches the database.
const { closeDb, db } = await import('$lib/server/db');

test.afterAll(async () => {
	await closeDb();
});

// Forms are posted to the public origin of the application (playwright.config.ts, APP_ORIGIN).
test.use({ baseURL: APP_ORIGIN });

async function expectNoAxeViolations(page: Page): Promise<void> {
	const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
	expect(result.violations.map((v) => v.id)).toEqual([]);
}

/** A 10-digit taxpayer number of an organization with valid check digits. */
function organizationInn(): string {
	const digits = Array.from({ length: 9 }, (_, index) =>
		index === 0 ? 1 + ((randomBytes(1)[0] ?? 0) % 9) : (randomBytes(1)[0] ?? 0) % 10
	);
	const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
	const sum = digits.reduce((total, digit, index) => total + digit * (weights[index] ?? 0), 0);
	return [...digits, (sum % 11) % 10].join('');
}

/** Registers an employer through the form; the registration creates the company draft with the person as owner. */
async function registerEmployer(page: Page, companyName: string): Promise<{ inn: string }> {
	const inn = organizationInn();
	await page.goto('/register');
	await page.getByRole('radio', { name: /Нанимаю/ }).check();
	await page.getByLabel('Ваше имя').fill('Сотрудник Проверочный');
	await page.getByLabel('Рабочая почта').fill(`e2e-operator-${randomUUID()}@example.org`);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByLabel('Название компании').fill(companyName);
	await page.getByLabel('ИНН компании').fill(inn);
	for (const checkbox of await page.getByRole('checkbox', { name: /Принимаю/ }).all()) await checkbox.check();
	await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
	await expect(page).toHaveURL(/\/onboarding/);
	return { inn };
}

/**
 * A person of the federation with the operator role granted, as the administrator's grant stores it. The person is
 * found through the company draft of the registration: the address itself is only readable with the application keys.
 */
async function signInOperatorAccount(browser: Browser): Promise<{ page: Page; userId: string }> {
	const context = await browser.newContext({ baseURL: APP_ORIGIN });
	const page = await context.newPage();
	const { inn } = await registerEmployer(page, 'Служебная учётка e2e');
	const [member] = await db()
		.select({ userId: companyMembers.userId })
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(eq(companies.inn, inn));
	if (!member?.userId) throw new Error('operator user not found');
	await db().insert(staffRoles).values({ userId: member.userId, role: 'operator', grantedAt: new Date() });
	return { page, userId: member.userId };
}

async function signInOperator(browser: Browser): Promise<Page> {
	return (await signInOperatorAccount(browser)).page;
}

/** The threshold of small numbers the cabinet reads; published once per database. */
async function ensureCatalogPolicy(): Promise<void> {
	const [existing] = await db()
		.select({ id: productPolicies.id })
		.from(productPolicies)
		.where(eq(productPolicies.kind, 'catalog_policy'))
		.limit(1);
	if (!existing) {
		await db()
			.insert(productPolicies)
			.values({
				kind: 'catalog_policy',
				version: 1,
				params: { small_count_threshold: 5 },
				effectiveFrom: new Date(Date.now() - 86_400_000)
			})
			.onConflictDoNothing();
	}
}

const sha256 = () => randomBytes(32).toString('hex');

/**
 * An adult candidate with an open objection to a decision of a test about the grade, in a region of the reference
 * (seeds/regions.json) like any stored one. Other candidates of the database may share its region: the tests find this
 * one by the id of its objection.
 */
async function seedObjection(reason: string): Promise<string> {
	return db().transaction(async (tx) => {
		const [user] = await tx
			.insert(users)
			.values({
				status: 'active',
				emailEnc: randomBytes(40),
				emailHmac: sha256(),
				displayName: 'Кандидат с возражением'
			})
			.returning({ id: users.id });
		if (!user) throw new Error('user not inserted');
		const [candidate] = await tx
			.insert(candidates)
			.values({
				userId: user.id,
				status: 'active',
				searchStatus: 'active',
				visibility: 'catalog',
				profileRevision: 1,
				birthDate: '2002-05-20',
				birthDatePrecision: 'day',
				birthDateSource: 'self_declared',
				birthDateStatus: 'unverified',
				desiredRoleKeys: ['backend'],
				preferences: { work_formats: ['remote'], region_code: 'RU-KGD' },
				seedBatchId: 'e2e-operator'
			})
			.returning({ id: candidates.id });
		if (!candidate) throw new Error('candidate not inserted');
		const openedAt = new Date();
		const [objection] = await tx
			.insert(assessmentObjections)
			.values({
				candidateId: candidate.id,
				decisionId: (
					await recordDecisionIn(tx, candidate.id, {
						specialization: 'backend',
						grade: 'junior',
						outcome: 'not_confirmed'
					})
				).id,
				reason,
				openedAt,
				dueAt: new Date(openedAt.getTime() + 30 * 86_400_000),
				status: 'open'
			})
			.returning({ id: assessmentObjections.id });
		if (!objection) throw new Error('objection not inserted');
		return objection.id;
	});
}

test('the operator approves a submitted company from the queue', async ({ page, browser }) => {
	await ensureCatalogPolicy();
	const { inn } = await registerEmployer(page, 'Проверяемая компания e2e');
	await page.goto('/company/profile');
	await page.getByRole('button', { name: 'Подать на проверку' }).click();
	await expect(page.getByTestId('verification-state')).toHaveAttribute('data-state', 'pending');

	// The employer is not an operator: the cabinet is closed to them.
	const refused = await page.goto('/operator');
	expect(refused?.status()).toBe(403);

	const operator = await signInOperator(browser);
	await operator.goto('/operator');
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText('Кабинет оператора ФСП');
	await expect(operator.locator('[data-queue="companies"] [data-count]')).not.toHaveText('0');
	await expectNoAxeViolations(operator);

	await operator.goto('/operator/companies');
	const row = operator.locator(`[data-inn="${inn}"]`);
	await expect(row).toHaveCount(1);
	await expect(row).toContainText('Рабочая почта на домене компании');
	await expectNoAxeViolations(operator);

	await row.getByRole('link', { name: 'Проверяемая компания e2e' }).click();
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText('Проверяемая компания e2e');
	await expect(operator.getByTestId('applicant-domain')).toHaveText('example.org');
	await expect(operator.getByTestId('registry-state')).toBeVisible();
	await expectNoAxeViolations(operator);

	await operator.getByRole('button', { name: 'Подтвердить компанию' }).click();
	await expect(operator.getByText('Компания подтверждена')).toBeVisible();
	await expect(operator.getByTestId('decision')).toHaveAttribute('data-state', 'approved');
	const [company] = await db().select({ status: companies.status }).from(companies).where(eq(companies.inn, inn));
	expect(company?.status).toBe('verified');

	// The employer learns the decision from the notifications and is led to the company profile.
	await page.goto('/notifications');
	await page.getByRole('link', { name: /Решение по проверке компании/ }).click();
	await expect(page).toHaveURL(/\/company\/profile$/);

	// The company card: moderation and partnerships of a verified company.
	await operator.getByRole('link', { name: 'Карточка компании' }).click();
	await expect(operator.getByTestId('suspend-form')).toBeVisible();
	await expect(operator.getByTestId('partnership-form')).toBeVisible();
	await expectNoAxeViolations(operator);

	const partnership = operator.getByTestId('partnership-form');
	await partnership.getByLabel('Соревнование ФСП').fill('e2e-operator-cup-2026');
	await partnership.getByLabel('Основание').fill('Договор о партнёрстве кейсодателя № e2e');
	await partnership.getByRole('button', { name: 'Открыть партнёрство' }).click();
	await expect(operator.getByText('Партнёрство открыто.')).toBeVisible();
	await expect(operator.locator('[data-partnership][data-status="active"]')).toContainText('финалисты и выше');

	await operator.getByLabel('Причина').selectOption('complaint');
	await operator.getByRole('button', { name: 'Приостановить' }).click();
	await expect(operator.getByText('Компания приостановлена')).toBeVisible();
	await operator.getByRole('button', { name: 'Вернуть к работе' }).click();
	await expect(operator.getByText('Компания снова работает', { exact: false })).toBeVisible();
	await operator.context().close();
});

test('the operator downloads the authority document of a request; others get no document', async ({
	page,
	browser
}) => {
	await ensureCatalogPolicy();
	const { inn } = await registerEmployer(page, 'Компания с доверенностью e2e');
	const [owner] = await db()
		.select({ memberId: companyMembers.id, userId: companyMembers.userId, companyId: companies.id })
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(eq(companies.inn, inn));
	if (!owner?.userId) throw new Error('owner not found');
	// The request as the submission leaves it: the document stored, the company waiting for the operator.
	const content = `Доверенность на подписанта ${randomUUID()}`;
	const bytes = new TextEncoder().encode(content);
	const fileId = randomUUID();
	const storageKey = `company_authority_evidence/${fileId}`;
	await objectStore().put(storageKey, bytes, 'text/plain; charset=utf-8');
	await db()
		.insert(files)
		.values({
			id: fileId,
			ownerUserId: owner.userId,
			purpose: 'company_authority_evidence',
			storageKey,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			sizeBytes: bytes.byteLength,
			declaredName: 'доверенность.txt',
			detectedMime: 'text/plain; charset=utf-8',
			status: 'ready'
		});
	const [verification] = await db()
		.insert(companyVerifications)
		.values({
			companyId: owner.companyId,
			applicantMemberId: owner.memberId,
			authorityMethod: 'power_of_attorney',
			authorityEvidenceFileId: fileId
		})
		.returning({ id: companyVerifications.id });
	if (!verification) throw new Error('verification not inserted');
	await db().update(companies).set({ status: 'submitted' }).where(eq(companies.id, owner.companyId));
	const evidencePath = `/operator/companies/requests/${verification.id}/evidence?file=${fileId}`;

	// The employer is not an operator: the document is not handed out through the cabinet.
	expect((await page.request.get(evidencePath)).status()).toBe(403);

	const operator = await signInOperator(browser);
	await operator.goto(`/operator/companies/requests/${verification.id}`);
	const link = operator.getByTestId('evidence-download');
	await expect(link).toHaveText('доверенность.txt');
	await expectNoAxeViolations(operator);
	const [download] = await Promise.all([operator.waitForEvent('download'), link.click()]);
	expect(download.suggestedFilename()).toBe('доверенность.txt');
	expect(await readFile(await download.path(), 'utf8')).toBe(content);
	const access = await db()
		.select({ details: auditEvents.details })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'operator.case_access'), eq(auditEvents.objectId, fileId)));
	expect(access).toEqual([{ details: { case_type: 'moderation', case_id: verification.id } }]);

	// Another file, or the document under another request, is «not found».
	expect(
		(
			await operator.request.get(`/operator/companies/requests/${verification.id}/evidence?file=${randomUUID()}`)
		).status()
	).toBe(404);
	expect(
		(await operator.request.get(`/operator/companies/requests/${randomUUID()}/evidence?file=${fileId}`)).status()
	).toBe(404);
	await operator.context().close();
});

test('the operator sees an objection to a test result in the queue with its due date', async ({ browser }) => {
	await ensureCatalogPolicy();
	const objectionId = await seedObjection('Второе задание оценено неверно: ответ совпадает с эталоном.');
	const operator = await signInOperator(browser);

	await operator.goto('/operator/objections');
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText('Возражения по результатам тестов');
	const row = operator.locator(`[data-objection="${objectionId}"]`);
	await expect(row).toContainText('не назначен');
	await expect(row.locator('[data-due]')).toHaveAttribute('data-due', 'in_time');
	await expectNoAxeViolations(operator);
	await operator.context().close();
});

test('the operator sees the career funnel by stage, the skills feedback and the other sections', async ({
	browser
}) => {
	await ensureCatalogPolicy();
	const operator = await signInOperator(browser);

	await operator.goto('/operator/outcomes');
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText('Карьерные исходы');
	await expect(operator.locator('[data-notice="correlation"]')).toBeVisible();
	await expect(operator.getByTestId('funnel-stages').or(operator.getByTestId('funnel-empty'))).toBeVisible();
	await expectNoAxeViolations(operator);

	await operator.getByLabel('Разрез').selectOption('specialization');
	await operator.getByRole('button', { name: 'Показать' }).click();
	await expect(operator).toHaveURL(/by=specialization/);
	await expect(operator.getByRole('heading', { level: 2, name: /Категория: специализация/ })).toBeVisible();

	await operator.getByLabel('Разрез').selectOption('region');
	await operator.getByRole('button', { name: 'Показать' }).click();
	await expect(operator).toHaveURL(/by=region/);
	await expect(operator.getByRole('heading', { level: 2, name: /Регион/ })).toBeVisible();
	await expect(operator.getByTestId('funnel-region-note')).toBeVisible();
	await expectNoAxeViolations(operator);

	// Two dimensions at once and a filter: the rules of counting are written next to the table.
	await operator.getByLabel('Разрез').selectOption('fsp_discipline');
	await operator.getByLabel('Внутри каждой строки').selectOption('grade');
	await operator.getByLabel('Уровень ФСП').selectOption('L3');
	await operator.getByRole('button', { name: 'Показать' }).click();
	await expect(operator).toHaveURL(/by=fsp_discipline.*then=grade.*fsp_level=L3/);
	await expect(
		operator.getByRole('heading', { level: 2, name: 'По разрезу: Дисциплина ФСП, внутри — Категория: грейд' })
	).toBeVisible();
	const rules = operator.getByTestId('funnel-rules');
	await expect(rules.locator('[data-rule="small-groups"]')).toContainText('Малые группы');
	await expect(rules.locator('[data-rule="multi-group"]')).toContainText('суммы по строкам не равны итогу');
	await expect(rules.locator('[data-rule="nested"]')).toBeVisible();
	await expect(operator.getByLabel('Уровень ФСП')).toHaveValue('L3');
	await expectNoAxeViolations(operator);

	await operator.goto('/operator/skills');
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText('Навыки рынка ↔ навыки ФСП');
	await expect(operator.locator('[data-notice="correlation"]')).toBeVisible();
	await expect(operator.getByTestId('skills-table').or(operator.getByTestId('skills-empty'))).toBeVisible();
	await expectNoAxeViolations(operator);

	// The other queues and the partnerships render in any state of the shared database.
	for (const [path, heading] of [
		['/operator/representatives', 'Законные представители'],
		['/operator/partnerships', 'Партнёрства с соревнованиями']
	] as const) {
		await operator.goto(path);
		await expect(operator.getByRole('heading', { level: 1 })).toHaveText(heading);
		await expectNoAxeViolations(operator);
	}
	await operator.context().close();
});

/** A candidate whose declared birth date the FSP import contradicted, as the synchronization leaves it. */
async function seedAgeConflict(): Promise<string> {
	const crypto = fieldCrypto();
	return db().transaction(async (tx) => {
		const [user] = await tx
			.insert(users)
			.values({
				status: 'active',
				emailEnc: Buffer.from(crypto.encrypt(`e2e-age-${randomUUID()}@example.org`, 'users.email')),
				emailHmac: sha256(),
				displayName: 'Кандидат с расхождением'
			})
			.returning({ id: users.id });
		if (!user) throw new Error('user not inserted');
		const [candidate] = await tx
			.insert(candidates)
			.values({
				userId: user.id,
				status: 'active',
				searchStatus: 'active',
				visibility: 'catalog',
				lastNameEnc: Buffer.from(crypto.encrypt('Сидорова', 'candidates.last_name')),
				firstNameEnc: Buffer.from(crypto.encrypt('Анна', 'candidates.first_name')),
				birthDate: '2001-04-12',
				birthDatePrecision: 'day',
				birthDateSource: 'self_declared',
				birthDateStatus: 'conflict',
				preferences: {},
				seedBatchId: 'e2e-operator'
			})
			.returning({ id: candidates.id });
		if (!candidate) throw new Error('candidate not inserted');
		await tx.insert(auditEvents).values({
			action: 'age.conflict',
			outcome: 'success',
			actorKind: 'system',
			subjectCandidateId: candidate.id,
			requestId: 'e2e-operator',
			details: { source: 'fsp_import' }
		});
		return candidate.id;
	});
}

test('the operator resolves a conflict of the birth date by a document', async ({ browser }) => {
	const candidateId = await seedAgeConflict();
	const operator = await signInOperator(browser);

	await operator.goto('/operator/ages');
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText('Конфликты возраста');
	const row = operator.locator(`[data-age-case="${candidateId}"]`);
	await expect(row).toHaveCount(1);
	await expectNoAxeViolations(operator);

	await row.getByRole('link').click();
	await expect(operator.getByText('Сидорова Анна')).toBeVisible();
	await expect(operator.getByTestId('declared-date')).toContainText('указал кандидат');
	await expectNoAxeViolations(operator);

	const form = operator.getByTestId('age-form');
	await form.getByLabel('Дата рождения по документу').fill('2009-02-03');
	await form.getByRole('radio', { name: /Личный визит/ }).check();
	await form.getByLabel('Документ', { exact: true }).selectOption('birth_certificate');
	await form.getByRole('button', { name: 'Подтвердить дату' }).click();
	await expect(operator.getByText(/кандидату 14–17 лет, профиль работает в защищённом режиме/)).toBeVisible();
	await expect(operator.getByTestId('age-hidden')).toBeVisible();
	await expect(operator.locator(`[data-age-case="${candidateId}"]`)).toHaveAttribute('data-status', 'verified');

	const [candidate] = await db()
		.select({
			birthDate: candidates.birthDate,
			status: candidates.birthDateStatus,
			source: candidates.birthDateSource,
			visibility: candidates.visibility
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	expect(candidate).toEqual({
		birthDate: '2009-02-03',
		status: 'verified',
		source: 'operator_document',
		visibility: 'hidden'
	});
	const [decision] = await db()
		.select({ details: auditEvents.details })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'age.verified'), eq(auditEvents.subjectCandidateId, candidateId)));
	expect(decision?.details).toEqual({
		method: 'in_person',
		document_kind: 'birth_certificate',
		matches_declared: false,
		regime: 'minor'
	});
	await operator.context().close();
});

/**
 * An attempt whose practice the sandbox has not scored for an hour: the list asks a person to look at it. The bank of
 * the attempt is a fixture release of QA (the e2e stand releases no bank of its own).
 */
async function seedStuckAttempt(): Promise<string> {
	const { releaseId, families } = await releaseFixtureBank(db(), 'qa', { n: 900 });
	const family = families.find((f) => f.descriptor.format === 'qa_mutation');
	if (!family) throw new Error('no QA family in the fixture bank');
	return db().transaction(async (tx) => {
		const [user] = await tx
			.insert(users)
			.values({ status: 'active', emailEnc: randomBytes(40), emailHmac: sha256(), displayName: 'Кандидат с попыткой' })
			.returning({ id: users.id });
		if (!user) throw new Error('user not inserted');
		const [candidate] = await tx
			.insert(candidates)
			.values({
				userId: user.id,
				status: 'active',
				searchStatus: 'active',
				birthDate: '1999-01-01',
				birthDatePrecision: 'day',
				birthDateSource: 'self_declared',
				birthDateStatus: 'unverified',
				preferences: {},
				seedBatchId: 'e2e-operator'
			})
			.returning({ id: candidates.id });
		if (!candidate) throw new Error('candidate not inserted');
		const answeredAt = new Date(Date.now() - 3_600_000);
		const [attempt] = await tx
			.insert(testAttempts)
			.values({
				candidateId: candidate.id,
				purpose: 'grade',
				specialization: 'qa',
				grade: 'intern',
				catalogVersion: '2026.10.1',
				bankReleaseId: releaseId,
				procedureVersion: 'sprt-1',
				policyVersion: 1,
				form: 'A',
				seed: randomBytes(16).toString('hex'),
				status: 'in_progress',
				startedAt: new Date(answeredAt.getTime() - 600_000),
				deadlineAt: new Date(answeredAt.getTime() + 3_600_000),
				integritySignals: {
					entries: [
						{
							at: answeredAt.toISOString(),
							stage: 'submission',
							seq: 1,
							client: { elapsedMs: 540_000, pasteCount: 2, pastedChars: 380, blurCount: 4 }
						}
					]
				}
			})
			.returning({ id: testAttempts.id });
		if (!attempt) throw new Error('attempt not inserted');
		const [item] = await tx
			.insert(testItems)
			.values({
				attemptId: attempt.id,
				seq: 1,
				block: family.descriptor.block,
				format: family.descriptor.format,
				practice: true,
				familyKey: family.descriptor.key,
				familyVersion: 1,
				classId: 'a',
				instanceSeed: 's',
				instance: family.module.generate({ seed: 's', grade: 'intern', classId: 'a' }),
				angoff: 0.8,
				servedAt: new Date(answeredAt.getTime() - 300_000),
				answeredAt,
				status: 'awaiting_sandbox'
			})
			.returning({ id: testItems.id });
		if (!item) throw new Error('item not inserted');
		await tx.insert(testArtifacts).values({
			attemptId: attempt.id,
			itemId: item.id,
			seq: 1,
			kind: 'qa_cases',
			content: { seq: 1, stage: 'task', cases: [{ input: '5 1 9', expected: 'clamp-case-marker' }] },
			sha256: sha256(),
			createdAt: answeredAt,
			retentionUntil: '2099-01-01'
		});
		return attempt.id;
	});
}

test('the operator reads a stuck attempt in full and annuls it with a reason', async ({ browser }) => {
	const attemptId = await seedStuckAttempt();
	const operator = await signInOperator(browser);

	await operator.goto('/operator/assessments');
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText('Попытки тестов');
	const row = operator.locator(`[data-attempt="${attemptId}"]`);
	await expect(row).toContainText('Песочница не ответила');
	await expect(row).toContainText('вставок 2 (380 симв.), уходов 4');
	await expectNoAxeViolations(operator);

	await row.getByRole('link').click();
	await expect(operator.getByTestId('review-item')).toContainText('clamp-case-marker');
	await expect(operator.getByTestId('signals')).toBeVisible();
	await expectNoAxeViolations(operator);

	await operator.getByLabel('Попытка сорвалась из-за технического сбоя на стороне платформы.').check();
	await operator.getByRole('button', { name: 'Аннулировать' }).click();
	await expect(operator.getByText('Попытка аннулирована', { exact: true })).toBeVisible();

	const [attempt] = await db()
		.select({ status: testAttempts.status, reason: testAttempts.annulReason })
		.from(testAttempts)
		.where(eq(testAttempts.id, attemptId));
	expect(attempt).toEqual({ status: 'annulled', reason: 'technical_failure' });
	const journal = await db()
		.select({ action: auditEvents.action })
		.from(auditEvents)
		.where(eq(auditEvents.objectId, attemptId));
	expect(journal.map((event) => event.action).sort()).toEqual(
		expect.arrayContaining(['assessment.annulled', 'assessment.artifact_viewed', 'operator.case_access'])
	);
	await operator.context().close();
});

test('an operator reads the journal only with the right the administrator grants', async ({ browser }) => {
	const { page: operator, userId } = await signInOperatorAccount(browser);

	// Without the grant the journal does not exist for the operator: a failed object rule is `404` (`requirePermission`).
	const refused = await operator.goto('/operator/audit');
	expect(refused?.status()).toBe(404);

	await db()
		.update(staffRoles)
		.set({ extraPermissions: ['audit.read'] })
		.where(and(eq(staffRoles.userId, userId), eq(staffRoles.role, 'operator')));
	await operator.goto('/operator/audit');
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText('Журнал действий');
	await expect(operator.getByTestId('journal-filters')).toBeVisible();
	await expectNoAxeViolations(operator);
	await operator.getByLabel('Событие').selectOption('audit.read');
	await operator.getByLabel('Актор (ID аккаунта)').fill(userId);
	await operator.getByRole('button', { name: 'Показать' }).click();
	await expect(operator).toHaveURL(/\/operator\/audit\?.*action=audit\.read/);
	// The reading before this one is already in the journal under the operator's account; the refused one is not.
	await expect(operator.getByTestId('journal').locator('[data-action="audit.read"]')).toHaveCount(1);
	await expectNoAxeViolations(operator);
	await operator.context().close();
});

test('an anonymous visitor is sent to sign in instead of the cabinet', async ({ page }) => {
	await page.goto('/operator/objections');
	await expect(page).toHaveURL(/\/login\?returnTo=%2Foperator%2Fobjections/);
});
