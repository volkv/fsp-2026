// Loading a batch of FSP results in the operator cabinet against the local infrastructure (`make infra`): the operator
// checks a synthetic export with a broken row, sees the row, the column and the reason, checks the fixed export and
// loads it; the load appears in the history with its source file, which only an operator downloads. Somebody who is not
// an operator gets neither the page nor the file. The page has no accessibility violations.
//
// The operator registers through the form (the password and the address need the keys of the running application); the
// operator role is written directly, as the administrator's grant stores it.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { eq } from 'drizzle-orm';
import { companies, companyMembers, staffRoles } from '$lib/server/db/schema';

const FIXTURES = fileURLToPath(new URL('../fixtures/fsp-import', import.meta.url));
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
	// Contrast is checked on settled colors: a checked batch turns the button «Проверить пакет» from the filled variant
	// into the outline one, and mid-transition its text and background are both in between. A transition that is
	// replaced by another one is cancelled rather than finished; only the running ones are waited for.
	await page.evaluate(async () => {
		const transitions = document.getAnimations().filter((animation) => animation instanceof CSSTransition);
		await Promise.allSettled(transitions.map((transition) => transition.finished));
	});
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

/** A person registered through the form with a company draft; returns the user found through that draft. */
async function registerPerson(page: Page): Promise<string> {
	const inn = organizationInn();
	await page.goto('/register');
	await page.getByRole('radio', { name: /Нанимаю/ }).check();
	await page.getByLabel('Ваше имя').fill('Сотрудник Федерации');
	await page.getByLabel('Рабочая почта').fill(`e2e-fsp-import-${randomUUID()}@example.org`);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByLabel('Название компании').fill('Служебная учётка импорта e2e');
	await page.getByLabel('ИНН компании').fill(inn);
	for (const checkbox of await page.getByRole('checkbox', { name: /Принимаю/ }).all()) await checkbox.check();
	await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
	await expect(page).toHaveURL(/\/onboarding/);
	const [member] = await db()
		.select({ userId: companyMembers.userId })
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(eq(companies.inn, inn));
	if (!member?.userId) throw new Error('registered user not found');
	return member.userId;
}

async function signInOperator(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ baseURL: APP_ORIGIN });
	const page = await context.newPage();
	const userId = await registerPerson(page);
	await db().insert(staffRoles).values({ userId, role: 'operator', grantedAt: new Date() });
	return page;
}

async function checkBatch(page: Page, file: string): Promise<void> {
	await page.getByLabel('Файл пакета').setInputFiles(`${FIXTURES}/${file}`);
	await page.getByRole('button', { name: /Проверить/ }).click();
	await expect(page.getByTestId('batch-preview')).toContainText(file);
	await expect(page.getByTestId('batch-preview')).toHaveAttribute('data-stale', 'false');
}

test('the operator checks a batch, fixes it, loads it and finds it in the history', async ({ browser, page }) => {
	const operator = await signInOperator(browser);
	await operator.goto('/operator/fsp-import');
	await expect(operator.getByRole('heading', { level: 1 })).toHaveText('Импорт результатов ФСП');
	await expectNoAxeViolations(operator);

	// The export with a broken row: the preview names the row, the column and the reason, and nothing is loaded yet.
	await operator.getByLabel('Файл профиля').setInputFiles(`${FIXTURES}/profile.json`);
	await checkBatch(operator, 'results-errors.csv');
	const preview = operator.getByTestId('batch-preview');
	await expect(preview.locator('[data-count="read"] dd')).toHaveText('7');
	await expect(preview.locator('[data-count="issues"] dd')).toHaveText('5');
	const issue = operator.locator('[data-issue-row="3"]');
	await expect(issue).toHaveAttribute('data-issue-code', 'invalid_number');
	await expect(issue).toContainText('Место');
	await expect(issue).toContainText('нужно целое число не меньше 1');
	await expect(operator.getByRole('checkbox', { name: /Загрузить только верные строки/ })).toBeVisible();
	await expectNoAxeViolations(operator);

	// The fixed export: a new file makes the preview stale until it is checked again.
	await operator.getByLabel('Файл пакета').setInputFiles(`${FIXTURES}/results.csv`);
	await expect(preview).toHaveAttribute('data-stale', 'true');
	await expect(operator.getByRole('button', { name: 'Загрузить пакет' })).toHaveCount(0);
	await operator.getByLabel('Пакет полный').check();
	await operator.getByRole('button', { name: /Проверить/ }).click();
	await expect(preview).toHaveAttribute('data-stale', 'false');
	await expect(preview.locator('[data-count="issues"] dd')).toHaveText('0');
	await expect(operator.getByTestId('batch-completeness')).toHaveAttribute('data-complete', 'true');
	await expect(operator.getByTestId('batch-issues')).toHaveCount(0);

	await operator.getByRole('button', { name: 'Загрузить пакет' }).click();
	await expect(operator.getByRole('status').filter({ hasText: 'Пакет «results.csv» загружен' })).toBeVisible();
	await expect(operator.getByTestId('batch-preview')).toHaveCount(0);

	const latest = operator.getByTestId('batch-history').locator('tbody tr').first();
	await expect(latest).toHaveAttribute('data-result', 'imported');
	await expect(latest).toContainText('Сотрудник Федерации');
	await expect(latest).toContainText('Полный');
	const link = latest.getByRole('link', { name: 'results.csv' });
	const href = await link.getAttribute('href');
	if (!href) throw new Error('no link to the source file');
	const download = await operator.request.get(href);
	expect(download.status()).toBe(200);
	expect(download.headers()['content-disposition']).toContain('results.csv');
	expect(await download.text()).toContain('ФСП ID;ФИО');
	await expectNoAxeViolations(operator);

	// Somebody who is not an operator: the cabinet is closed, the file does not exist for them.
	await registerPerson(page);
	expect((await page.goto('/operator/fsp-import'))?.status()).toBe(403);
	expect((await page.request.get(href)).status()).toBe(404);
	await operator.context().close();
});
