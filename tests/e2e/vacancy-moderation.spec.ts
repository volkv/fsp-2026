// Moderation of vacancies in the browser against the local infrastructure (`make infra`): a vacancy whose text states
// a requirement the law does not allow goes to the operator instead of the catalog; the operator sees it in the queue
// of the cabinet with the phrase quoted in place and returns it for editing with a reason, which the company reads on
// the vacancy and is notified of; a company that corrects the text of a vacancy in moderation gets it back to the
// catalog at once. The notice of the check says what the found phrases mean at each step.
//
// People register through the forms. The company's verification and the operator role are written directly: they are
// state the vacancies receive from other parts (the operator's decision on the company, the administrator's grant).
import { randomBytes, randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { companies, companyMembers, staffRoles } from '$lib/server/db/schema';

const PASSWORD = 'e2e passphrase long';

// The pool of the application's own module: `closeDb` in `afterAll` ends it.
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

/** Registers an employer through the form; returns the taxpayer number of its company draft. */
async function registerEmployer(page: Page, companyName: string): Promise<string> {
	const inn = organizationInn();
	await page.goto('/register');
	await page.getByRole('radio', { name: /Нанимаю/ }).check();
	await page.getByLabel('Ваше имя').fill('Рекрутер Проверочный');
	await page.getByLabel('Рабочая почта').fill(`e2e-moderation-${randomUUID()}@example.org`);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByLabel('Название компании').fill(companyName);
	await page.getByLabel('ИНН компании').fill(inn);
	for (const checkbox of await page.getByRole('checkbox', { name: /Принимаю/ }).all()) await checkbox.check();
	await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
	await expect(page).toHaveURL(/\/onboarding/);
	return inn;
}

/** An employer of a company the operator has verified. */
async function verifiedEmployer(page: Page, companyName: string): Promise<void> {
	const inn = await registerEmployer(page, companyName);
	const updated = await db()
		.update(companies)
		.set({ status: 'verified', verifiedAt: new Date() })
		.where(and(eq(companies.inn, inn), eq(companies.status, 'draft')))
		.returning({ id: companies.id });
	expect(updated).toHaveLength(1);
}

/** A person of the federation with the operator role granted, as the administrator's grant stores it. */
async function signInOperator(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ baseURL: APP_ORIGIN });
	const page = await context.newPage();
	const inn = await registerEmployer(page, 'Служебная учётка модерации e2e');
	const [member] = await db()
		.select({ userId: companyMembers.userId })
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(eq(companies.inn, inn));
	if (!member?.userId) throw new Error('operator user not found');
	await db().insert(staffRoles).values({ userId: member.userId, role: 'operator', grantedAt: new Date() });
	return page;
}

const BLOCKED = 'Сервисы платежей на Go и PostgreSQL. Гражданство РФ обязательно, возраст до 35 лет.';
const CLEAN = 'Сервисы платежей на Go и PostgreSQL. Команда из восьми человек, код-ревью и дежурства по графику.';

/** A draft vacancy filled through the form; the page of the draft opens after saving. */
async function draftVacancy(page: Page, title: string, description: string): Promise<void> {
	await page.goto('/company/vacancies/new');
	await page.getByLabel('Название вакансии').fill(title);
	await page.getByLabel('Роль').selectOption('backend');
	await page.getByLabel('Грейд от').selectOption('middle');
	await page.getByLabel('Грейд до').selectOption('senior');
	await page.getByLabel('Обязательные навыки').fill('Go, PostgreSQL');
	await page.getByLabel('От', { exact: true }).fill('250000');
	await page.getByLabel('До', { exact: true }).fill('350000');
	await page.getByLabel('Валюта').selectOption('RUB');
	await page.getByLabel('Период').selectOption('month');
	await page.getByRole('radio', { name: 'на руки' }).check();
	await page.getByLabel('Формат', { exact: true }).selectOption('remote');
	await page.getByLabel('Занятость', { exact: true }).selectOption('full');
	await page.getByRole('checkbox', { name: 'Трудовой договор (ТК РФ)' }).check();
	await page.getByLabel('Описание').fill(description);
	await page.getByRole('button', { name: 'Сохранить черновик' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
}

async function publishToModeration(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Опубликовать' }).click();
	await expect(page.getByText('Вакансия отправлена на модерацию')).toBeVisible();
	await expect(page.getByTestId('moderation-status')).toHaveAttribute('data-state', 'pending');
	await expect(page.getByTestId('text-check')).toHaveAttribute('data-stage', 'pending');
	await expect(page.getByTestId('text-check')).toContainText('Из-за этих требований вакансия на модерации');
}

test('the operator returns a blocked vacancy for editing with a reason the company reads', async ({
	page,
	browser
}) => {
	const title = `Go-разработчик ${randomUUID().slice(0, 8)}`;
	await verifiedEmployer(page, 'Модерация e2e');
	await draftVacancy(page, title, BLOCKED);
	await expect(page.getByTestId('text-check')).toHaveAttribute('data-stage', 'before');
	await expect(page.getByTestId('text-check')).toContainText('после публикации её посмотрит оператор ФСП');
	await publishToModeration(page);
	const vacancyUrl = page.url();

	const operator = await signInOperator(browser);
	await operator.goto('/operator');
	await expect(operator.locator('[data-queue="vacancies"] [data-count]')).not.toHaveText('0');
	await operator.getByRole('link', { name: 'Модерация вакансий' }).first().click();
	await expect(operator).toHaveURL(/\/operator\/vacancies$/);
	const item = operator.getByRole('listitem').filter({ has: operator.getByRole('heading', { name: title }) });
	await expect(item.locator('mark', { hasText: 'Гражданство РФ' })).toBeVisible();
	await expect(item.locator('mark', { hasText: 'возраст до 35' })).toBeVisible();
	await expect(item.getByText('citizenship.required')).toBeVisible();
	await expect(item.getByTestId('moderation-wait')).toContainText('ждёт');
	await expectNoAxeViolations(operator);

	await item.getByRole('link', { name: title }).click();
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText(title);
	await expect(operator.locator('[data-finding="age.limit"]')).toBeVisible();
	await expectNoAxeViolations(operator);
	await operator.getByRole('button', { name: 'Вернуть на правку' }).click();
	await expect(operator.locator('[data-tone="error"]')).toContainText('Напишите компании, что исправить');
	await expect(operator.getByLabel('Причина для компании')).toHaveAttribute('aria-invalid', 'true');
	await operator.getByLabel('Причина для компании').fill('Уберите требования к гражданству и возрасту.');
	await operator.getByRole('button', { name: 'Вернуть на правку' }).click();
	await expect(operator.getByText('Вакансия возвращена компании на правку')).toBeVisible();
	await expect(operator.getByTestId('moderation-decision')).toContainText('Возвращена на правку');
	await expect(operator.getByTestId('moderation-history')).toContainText('Решение оператора: возвращена на правку');
	await operator.goto('/operator/vacancies');
	await expect(operator.getByRole('heading', { name: title })).toHaveCount(0);

	await page.goto(vacancyUrl);
	const status = page.getByTestId('moderation-status');
	await expect(status).toHaveAttribute('data-state', 'returned');
	await expect(status).toContainText('Уберите требования к гражданству и возрасту.');
	await expect(page.getByText('Черновик', { exact: true })).toBeVisible();
	await expect(page.getByTestId('text-check')).toHaveAttribute('data-stage', 'before');
	await expectNoAxeViolations(page);

	await page.goto('/notifications');
	await page.getByRole('link', { name: /Решение модерации по вакансии/ }).click();
	await expect(page).toHaveURL(new URL(vacancyUrl).pathname);
	await expect(page.getByTestId('moderation-status')).toHaveAttribute('data-state', 'returned');
});

test('a company that corrects the text of a vacancy in moderation gets it back to the catalog', async ({ page }) => {
	await verifiedEmployer(page, 'Исправление e2e');
	await draftVacancy(page, 'Go-разработчик платежей', BLOCKED);
	await publishToModeration(page);

	await page.getByText('Изменить вакансию').click();
	await page.getByLabel('Описание').fill(CLEAN);
	await page.getByRole('button', { name: 'Сохранить изменения' }).click();
	await expect(page.getByText('Текст прошёл проверку: вакансия вышла из модерации и снова в каталоге.')).toBeVisible();
	await expect(page.getByText('Опубликована', { exact: true })).toBeVisible();
	await expect(page.getByTestId('moderation-status')).toHaveCount(0);
});

test('a decision on a vacancy the company edited meanwhile is refused and the case reopens with the new text', async ({
	page,
	browser
}) => {
	const title = `Go-разработчик ${randomUUID().slice(0, 8)}`;
	const edited = 'Сервисы платежей на Go и Kafka. Гражданство РФ обязательно, дежурства по графику.';
	await verifiedEmployer(page, 'Правка на модерации e2e');
	await draftVacancy(page, title, BLOCKED);
	await publishToModeration(page);
	const vacancyUrl = page.url();

	const operator = await signInOperator(browser);
	await operator.goto('/operator/vacancies');
	await operator.getByRole('link', { name: title }).click();
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText(title);
	await expect(operator.locator('[data-finding="age.limit"]')).toBeVisible();

	// The company corrects one requirement while the operator reads the case; the other one still blocks the text.
	await page.goto(vacancyUrl);
	await page.getByText('Изменить вакансию').click();
	await page.getByLabel('Описание').fill(edited);
	await page.getByRole('button', { name: 'Сохранить изменения' }).click();
	await expect(page.getByTestId('moderation-status')).toHaveAttribute('data-state', 'pending');

	await operator.getByRole('button', { name: 'Опубликовать' }).click();
	await expect(operator.locator('[data-tone="error"]')).toContainText('Вакансия изменилась');
	await expect(operator.locator('[data-moderation-case]')).toHaveAttribute('data-status', 'pending_moderation');
	await expect(operator.locator('[data-finding="age.limit"]')).toHaveCount(0);
	await expect(operator.locator('details').getByText(edited)).toBeAttached();
	await expectNoAxeViolations(operator);

	await operator.getByRole('button', { name: 'Опубликовать' }).click();
	await expect(operator.getByText('Вакансия опубликована: требование признано законным.')).toBeVisible();
	await expect(operator.locator('[data-moderation-case]')).toHaveAttribute('data-status', 'published');
});
