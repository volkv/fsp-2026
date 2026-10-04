// Vacancies of a company in the browser against the local infrastructure (`make infra`) with the models switched off:
// pasted text is read by the rules and every found field arrives in the form with its quote, a vacancy for
// candidates from 16 years becomes possible once the owner accepts the offer on the work of minors in the profile, and
// an employer finds its vacancy among the external ones, sees the pool and claims it, takes an open claim back from the
// list of its vacancies or from the card, and after the approval creates its own vacancy on the basis of the external
// one; a candidate narrows the vacancies for them by words, origin, role and format.
import { randomBytes, randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { and, desc, eq, lte } from 'drizzle-orm';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { hashPassword } from '$lib/server/auth/password';
import {
	candidates,
	companies,
	companyMembers,
	consentEvents,
	legalDocuments,
	passwordCredentials,
	users,
	vacancies,
	vacancyClaims,
	vacancyImportRuns,
	vacancyPostings
} from '$lib/server/db/schema';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';
import { decideVacancyClaim } from '$lib/server/vacancies/claims';
import { PENDING_NORMALIZATION, PENDING_VERSION } from '$lib/server/vacancies/clusters';
import { HABR_SOURCE_KEY } from '$lib/server/vacancies/sources/definitions';

const PASSWORD = 'e2e passphrase long';

// The pool of the application's own module: `closeDb` in `afterAll` ends it.
const { closeDb, db } = await import('$lib/server/db');
const { fieldCrypto } = await import('$lib/server/crypto/fields');

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

/** Registers an employer through the form, and the operator's decision makes the company verified; returns its id. */
async function verifiedEmployer(page: Page, companyName: string): Promise<string> {
	const inn = organizationInn();
	await page.goto('/register');
	await page.getByRole('radio', { name: /Нанимаю/ }).check();
	await page.getByLabel('Ваше имя').fill('Рекрутер Проверочный');
	await page.getByLabel('Рабочая почта').fill(`e2e-employer-${randomUUID()}@example.org`);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByLabel('Название компании').fill(companyName);
	await page.getByLabel('ИНН компании').fill(inn);
	for (const checkbox of await page.getByRole('checkbox', { name: /Принимаю/ }).all()) await checkbox.check();
	await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
	await expect(page).toHaveURL(/\/onboarding/);
	const updated = await db()
		.update(companies)
		.set({ status: 'verified', verifiedAt: new Date() })
		.where(and(eq(companies.inn, inn), eq(companies.status, 'draft')))
		.returning({ id: companies.id });
	const [company] = updated;
	if (updated.length !== 1 || !company) throw new Error('the registered company was not found');
	return company.id;
}

const VACANCY_TEXT = [
	'Middle Go-разработчик (backend)',
	'Ищем разработчика в команду платёжных сервисов.',
	'Обязательно: Go, PostgreSQL. Желательно: Kubernetes.',
	'Зарплата 200–230 тыс. ₽ на руки, гибрид или удалёнка, полная занятость, оформление по ТК РФ.'
].join('\n');

test('pasted text without the model is read by the rules, with a quote behind every found field', async ({ page }) => {
	await verifiedEmployer(page, 'Правила e2e');
	await page.goto('/company/vacancies/new');
	await page.getByLabel('Текст вакансии').fill(VACANCY_TEXT);
	await page.getByRole('button', { name: 'Разобрать' }).click();

	await expect(page.getByTestId('draft')).toHaveAttribute('data-mode', 'rules');
	await expect(page.getByTestId('rules-mode')).toContainText('Разобрано правилами, проверьте поля');
	await expect(page.locator('[data-notice="degraded"]')).toBeVisible();
	await expect(page.getByLabel('Название вакансии')).toHaveValue('Middle Go-разработчик (backend)');
	await expect(page.getByLabel('Роль')).toHaveValue('backend');
	await expect(page.getByLabel('Грейд от')).toHaveValue('middle');
	await expect(page.getByLabel('Грейд до')).toHaveValue('middle');
	await expect(page.getByLabel('Обязательные навыки')).toHaveValue('Go, PostgreSQL');
	await expect(page.getByLabel('Желательные навыки')).toHaveValue('Kubernetes');
	await expect(page.getByLabel('От', { exact: true })).toHaveValue('200000');
	await expect(page.getByLabel('До', { exact: true })).toHaveValue('230000');
	await expect(page.getByLabel('Валюта')).toHaveValue('RUB');
	await expect(page.getByRole('radio', { name: 'на руки' })).toBeChecked();
	await expect(page.getByLabel('Формат', { exact: true })).toHaveValue('hybrid');
	await expect(page.getByLabel('Занятость', { exact: true })).toHaveValue('full');
	await expect(page.getByRole('checkbox', { name: 'Трудовой договор (ТК РФ)' })).toBeChecked();
	await expect(page.locator('[data-quote] mark', { hasText: 'Зарплата 200–230 тыс. ₽ на руки' }).first()).toBeVisible();
	await expect(page.locator('[data-quote] mark', { hasText: 'Middle Go-разработчик (backend)' }).first()).toBeVisible();
	// The text does not state the period of the range: the field is left to the employer, not guessed.
	await expect(page.getByTestId('draft-missing')).toContainText('период вилки');
	await expect(page.getByLabel('Описание')).toHaveValue(VACANCY_TEXT);
	// The pool of the draft before saving: no confirmed Go developers here, so «fewer than» the policy threshold.
	const estimate = page.getByTestId('pool-estimate');
	await expect(estimate).toHaveAttribute('data-pool-status', 'below_threshold');
	await expect(estimate).toContainText('Категория:');
	await expect(estimate).toContainText('В пуле меньше 5 подтверждённых кандидатов');
	await expectNoAxeViolations(page);

	await page.getByLabel('Период').selectOption('month');
	await page.getByRole('button', { name: 'Сохранить черновик' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Middle Go-разработчик (backend)');
	await expect(page.getByTestId('vacancy-min-age')).toHaveText('только совершеннолетние');
});

test('a vacancy for candidates from 16 years needs the offer accepted by the owner', async ({ page }) => {
	await verifiedEmployer(page, 'Подростки e2e');

	await page.goto('/company/vacancies/new');
	await expect(page.getByRole('option', { name: 'С 16 лет' })).toBeDisabled();
	await expect(page.getByText('её принимает владелец компании')).toBeVisible();

	await page.goto('/company/profile');
	const terms = page.getByTestId('minor-terms');
	await expect(terms.getByTestId('minor-terms-state')).toHaveAttribute('data-state', 'not_accepted');
	await expectNoAxeViolations(page);
	await terms.getByRole('button', { name: 'Принять оферту' }).click();
	await expect(page.getByText('Оферта принята. Теперь в вакансии')).toBeVisible();
	await expect(terms.getByTestId('minor-terms-state')).toHaveAttribute('data-state', 'accepted');

	await page.goto('/company/vacancies/new');
	await page.getByLabel('Название вакансии').fill('Стажёр-разработчик Python');
	await page.getByLabel('Роль').selectOption('backend');
	await page.getByLabel('Грейд от').selectOption('intern');
	await page.getByLabel('Грейд до').selectOption('junior');
	await page.getByLabel('Обязательные навыки').fill('Python');
	await page.getByLabel('От', { exact: true }).fill('40000');
	await page.getByLabel('До', { exact: true }).fill('60000');
	await page.getByLabel('Валюта').selectOption('RUB');
	await page.getByLabel('Период').selectOption('month');
	await page.getByRole('radio', { name: 'на руки' }).check();
	await page.getByLabel('Формат', { exact: true }).selectOption('remote');
	await page.getByLabel('Занятость', { exact: true }).selectOption('part');
	await page.getByRole('checkbox', { name: 'Трудовой договор (ТК РФ)' }).check();
	await page.getByLabel('Возраст кандидатов').selectOption('16');
	await page
		.getByLabel('Описание')
		.fill('Стажировка на неполный день для школьников старших классов: сервисы на Python под присмотром наставника.');
	await page.getByRole('button', { name: 'Сохранить черновик' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Стажёр-разработчик Python');
	await expect(page.getByTestId('vacancy-min-age')).toHaveText('с 16 лет');
});

/**
 * An external vacancy as the import leaves it — one posting on Habr Career — with the pool counted by `match.refresh`.
 */
async function importedVacancy(
	title: string,
	overrides: { workFormat?: string } = {}
): Promise<{ id: string; url: string }> {
	const database = db();
	const version = await latestPublishedVersion(database);
	if (!version) throw new Error('no published taxonomy');
	const at = new Date();
	const [vacancy] = await database
		.insert(vacancies)
		.values({
			origin: 'external',
			externalOrg: { name: 'ООО «Платёжные сервисы»', source_org_ids: [] },
			taxonomyVersionId: version.id,
			title,
			roleKey: 'backend',
			requiredSkillKeys: ['go'],
			workFormat: overrides.workFormat ?? 'remote',
			gradeBasis: 'unknown',
			textCheck: { validator_version: 'e2e', result: 'clean', phrases: [], warnings_confirmed: null, moderation: null },
			status: 'active',
			poolCount: 7,
			poolCountedAt: at
		})
		.returning({ id: vacancies.id });
	if (!vacancy) throw new Error('vacancy not inserted');
	const [run] = await database
		.insert(vacancyImportRuns)
		.values({
			source: HABR_SOURCE_KEY,
			adapterVersion: 'e2e/1',
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
	const url = `https://career.habr.com/vacancies/${externalId}`;
	await database.insert(vacancyPostings).values({
		vacancyId: vacancy.id,
		source: HABR_SOURCE_KEY,
		externalId,
		url,
		organization: { name: 'ООО «Платёжные сервисы»', inn: null, source_org_id: null },
		title,
		originalTerms: {},
		rawSha256: randomBytes(32).toString('hex'),
		normalized: PENDING_NORMALIZATION,
		normalizationVersion: PENDING_VERSION,
		firstFetchedAt: at,
		lastFetchedAt: at,
		lastCheckedAt: at,
		freshness: 'active',
		dedup: { method: 'exact', score: 1 },
		lastImportRunId: run.id
	});
	return { id: vacancy.id, url };
}

test('an employer finds its vacancy among the external ones, claims it and takes the claim back', async ({ page }) => {
	const marker = `платёжн${randomBytes(3).toString('hex')}`;
	const title = `Go-разработчик ${marker}`;
	const imported = await importedVacancy(title);
	await verifiedEmployer(page, 'Внешние e2e');

	await page.goto('/company/vacancies');
	const sections = page.getByRole('navigation', { name: 'Разделы: работодатель' });
	await page.getByRole('main').getByRole('link', { name: 'Внешние вакансии' }).click();
	await expect(page).toHaveURL(/\/company\/vacancies\/external$/u);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Внешние вакансии');
	await expect(sections.getByRole('link', { name: 'Внешние вакансии' })).toHaveAttribute('aria-current', 'page');
	await expect(sections.getByRole('link', { name: 'Вакансии', exact: true })).not.toHaveAttribute('aria-current');

	await page.getByLabel('Название, навыки, организация').fill(marker);
	await page.getByLabel('Роль').selectOption('backend');
	await page.getByRole('button', { name: 'Найти' }).click();
	await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(marker);
	const card = page.locator(`[data-external-vacancy="${imported.id}"]`);
	await expect(page.getByTestId('external-vacancies').locator(':scope > li')).toHaveCount(1);
	await expect(card.getByRole('heading', { level: 2 })).toHaveText(title);
	await expect(card.getByTestId('vacancy-sources')).toContainText('Хабр Карьер');
	await expect(card.getByRole('link', { name: /Оригинал вакансии/u })).toHaveAttribute('href', imported.url);
	await expect(card.getByTestId('pool')).toHaveAttribute('data-pool-status', 'counted');
	await expect(card.getByTestId('pool')).toContainText('В пуле 7 подтверждённых кандидатов');
	await expectNoAxeViolations(page);

	await card.getByRole('button', { name: 'Это наша вакансия' }).click();
	await expect(card.getByText('Заявка подана: оператор ФСП сверит организацию')).toBeVisible();
	await expect(card.getByTestId('claim')).toHaveAttribute('data-claim-status', 'pending_review');
	await expect(card.getByText('На проверке у оператора')).toBeVisible();
	await expect(card.getByRole('button', { name: 'Это наша вакансия' })).toHaveCount(0);

	await page.goto('/company/vacancies');
	const claims = page.getByRole('region', { name: 'Заявленные внешние вакансии' });
	await expect(claims).toContainText(title);
	await expect(claims).toContainText('На проверке у оператора');
	await expectNoAxeViolations(page);

	await claims.getByRole('button', { name: 'Отозвать заявку' }).click();
	await expect(claims.getByText('Заявка отозвана: оператор её больше не увидит.')).toBeVisible();
	await expect(claims.locator('[data-claim-status="withdrawn"]')).toContainText('Отозвана');
	await expect(claims.getByRole('button', { name: 'Отозвать заявку' })).toHaveCount(0);

	// The card offers a new claim, and a claim filed again is taken back from the card.
	await page.goto(`/company/vacancies/external?q=${encodeURIComponent(marker)}`);
	await expect(card.getByTestId('claim')).toHaveAttribute('data-claim-status', 'withdrawn');
	await card.getByRole('button', { name: 'Это наша вакансия' }).click();
	await expect(card.getByTestId('claim')).toHaveAttribute('data-claim-status', 'pending_review');
	await card.getByRole('button', { name: 'Отозвать заявку' }).click();
	await expect(card.getByText('Заявка отозвана.')).toBeVisible();
	await expect(card.getByTestId('claim')).toHaveAttribute('data-claim-status', 'withdrawn');
	await expect(card.getByRole('button', { name: 'Это наша вакансия' })).toBeVisible();
});

test('after the claim is approved, the company creates its own vacancy on the basis of the external one', async ({
	page
}) => {
	const title = `Go-разработчик ${randomBytes(3).toString('hex')}`;
	const imported = await importedVacancy(title);
	const companyId = await verifiedEmployer(page, 'Своя на основе e2e');
	// Someone else's vacancy cannot be the basis: the page is not found.
	const refused = await page.goto(`/company/vacancies/new?from=${imported.id}`);
	expect(refused?.status()).toBe(404);

	const database = db();
	const [member] = await database
		.select({ userId: companyMembers.userId })
		.from(companyMembers)
		.where(eq(companyMembers.companyId, companyId));
	if (!member?.userId) throw new Error('the company has no member');
	const [claim] = await database
		.insert(vacancyClaims)
		.values({
			vacancyId: imported.id,
			companyId,
			requestedByUserId: member.userId,
			status: 'pending_review',
			matchEvidence: { inn: 'unknown', posting_inns: [], name_similarity: 0 }
		})
		.returning({ id: vacancyClaims.id });
	if (!claim) throw new Error('claim not inserted');
	await decideVacancyClaim({ db: database, now: () => new Date() }, claim.id, {
		operatorUserId: member.userId,
		decision: 'approved',
		reason: null,
		requestId: 'e2e'
	});

	await page.goto(`/company/vacancies/external?q=${encodeURIComponent(title)}`);
	const card = page.locator(`[data-external-vacancy="${imported.id}"]`);
	await expect(card.getByText('Подтверждена за вашей компанией')).toBeVisible();
	await card.getByRole('link', { name: 'Создать на основе' }).click();
	await expect(page).toHaveURL(new RegExp(`/company/vacancies/new\\?from=${imported.id}$`, 'u'));
	await expect(page.getByTestId('derived-from')).toContainText(title);
	await expect(page.getByLabel('Название вакансии')).toHaveValue(title);
	await expect(page.getByLabel('Роль')).toHaveValue('backend');
	await expect(page.getByLabel('Обязательные навыки')).toHaveValue('Go');
	await expect(page.getByLabel('Формат', { exact: true })).toHaveValue('remote');
	await expectNoAxeViolations(page);

	await page.getByLabel('Описание').fill('Разрабатываем платёжные сервисы на Go, команда из восьми человек.');
	await page.getByLabel('Грейд от').selectOption('middle');
	await page.getByLabel('Грейд до').selectOption('senior');
	await page.getByLabel('Занятость', { exact: true }).selectOption('full');
	await page.getByRole('checkbox', { name: 'Трудовой договор (ТК РФ)' }).check();
	await page.getByLabel('От', { exact: true }).fill('250000');
	await page.getByLabel('До', { exact: true }).fill('350000');
	await page.getByLabel('Валюта').selectOption('RUB');
	await page.getByLabel('Период').selectOption('month');
	await page.getByRole('radio', { name: 'до вычета НДФЛ' }).check();
	await page.getByRole('button', { name: 'Сохранить черновик' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

	const [own] = await database
		.select({ derivedFromVacancyId: vacancies.derivedFromVacancyId })
		.from(vacancies)
		.where(and(eq(vacancies.companyId, companyId), eq(vacancies.origin, 'own')));
	expect(own?.derivedFromVacancyId).toBe(imported.id);
});

/** An active candidate with a password and the processing consent signed an hour ago; returns the sign-in address. */
async function seededCandidate(): Promise<string> {
	const database = db();
	const crypto = fieldCrypto();
	const email = `e2e-candidate-${randomUUID()}@example.org`;
	const now = new Date();
	const [user] = await database
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			emailVerifiedAt: now,
			displayName: 'Кандидат Поисковый'
		})
		.returning({ id: users.id });
	if (!user) throw new Error('user not inserted');
	await database
		.insert(passwordCredentials)
		.values({ userId: user.id, hash: await hashPassword(PASSWORD), changedAt: now });
	const [candidate] = await database
		.insert(candidates)
		.values({
			userId: user.id,
			status: 'active',
			searchStatus: 'active',
			preferences: {},
			birthDate: '1995-05-05',
			birthDatePrecision: 'day',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified'
		})
		.returning({ id: candidates.id });
	if (!candidate) throw new Error('candidate not inserted');
	const [document] = await database
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(and(eq(legalDocuments.kind, 'pd_processing'), lte(legalDocuments.publishedAt, now)))
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	if (!document) throw new Error('no published pd_processing document');
	await database.insert(consentEvents).values({
		subjectCandidateId: candidate.id,
		kind: 'pd_processing',
		documentId: document.id,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: user.id,
		method: 'separate_screen_button',
		evidence: { source: 'e2e' },
		occurredAt: new Date(now.getTime() - 3_600_000)
	});
	return email;
}

test('a candidate narrows the vacancies by words, origin, role and format, the address keeps the search', async ({
	page
}) => {
	const marker = `поиск${randomBytes(3).toString('hex')}`;
	const remote = await importedVacancy(`Go-разработчик ${marker}`);
	await importedVacancy(`Разработчик сервисов ${marker}`, { workFormat: 'office' });
	const email = await seededCandidate();

	await page.goto('/login');
	await page.getByLabel('Почта').fill(email);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await page.waitForURL((url) => url.pathname !== '/login');

	await page.goto('/me/vacancies');
	const search = page.getByTestId('vacancy-search');
	await search.getByLabel('Название, навыки, компания').fill(marker);
	await search.getByRole('button', { name: 'Найти' }).click();
	await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(marker);
	const list = page.getByTestId('vacancy-list');
	await expect(list.locator(':scope > li')).toHaveCount(2);

	await search.getByLabel('Откуда вакансия').selectOption('external');
	await search.getByLabel('Роль').selectOption('backend');
	await search.getByRole('checkbox', { name: 'Удалённо' }).check();
	await search.getByRole('button', { name: 'Найти' }).click();
	await expect(page).toHaveURL(/origin=external/u);
	await expect(page).toHaveURL(/format=remote/u);
	await expect(list.locator(':scope > li')).toHaveCount(1);
	await expect(list.getByRole('heading', { level: 2 })).toHaveText(`Go-разработчик ${marker}`);
	await expect(list.getByRole('link', { name: /Оригинал вакансии/u })).toHaveAttribute('href', remote.url);
	await expect(list.getByText('соответствие', { exact: true })).toBeVisible();

	await page.reload();
	await expect(search.getByLabel('Название, навыки, компания')).toHaveValue(marker);
	await expect(search.getByLabel('Откуда вакансия')).toHaveValue('external');
	await expect(search.getByRole('checkbox', { name: 'Удалённо' })).toBeChecked();
	await expect(list.locator(':scope > li')).toHaveCount(1);
	await expectNoAxeViolations(page);

	await search.getByRole('link', { name: 'Сбросить' }).click();
	await expect(page).toHaveURL(/\/me\/vacancies$/u);
	await expect(search.getByLabel('Название, навыки, компания')).toHaveValue('');
});
