// The administrator cabinet in the browser against the local infrastructure (`make infra`): the administrator switches
// the `extract` model operation off and back on with a confirmation, each switch lands in the action journal; enables a
// vacancy source, which puts its import in the queue, and disables it again; the reference books, the quality panel, people and the journal render; somebody who is not an administrator does not get
// into the cabinet. The main screens have no accessibility violations.
//
// People register through the form (their passwords and addresses need the keys of the running application). The
// administrator role is written directly: it is the grant of another administrator or of the initial account.
import { randomBytes, randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { and, eq, sql } from 'drizzle-orm';
import { createClient } from 'redis';
import { auditEvents, companies, companyMembers, jobs, staffRoles, vacancySources } from '$lib/server/db/schema';

const PASSWORD = 'e2e passphrase long';

// The pool of the application's own module: `closeDb` in `afterAll` ends it and the next query opens a new one, so a
// worker that comes back to this file for another group of its tests (fullyParallel) still reaches the database.
const { closeDb, db } = await import('$lib/server/db');

process.loadEnvFile('.env');
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL must be set in .env');

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

/** Registers a person through the form (as an employer: the shortest path to a signed-in account) and returns the id. */
async function registerPerson(page: Page): Promise<string> {
	const inn = organizationInn();
	await page.goto('/register');
	await page.getByRole('radio', { name: /Нанимаю/ }).check();
	await page.getByLabel('Ваше имя').fill('Администратор Проверочный');
	await page.getByLabel('Рабочая почта').fill(`e2e-admin-${randomUUID()}@example.org`);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByLabel('Название компании').fill('Служебная учётка e2e');
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

async function signInAdmin(browser: Browser): Promise<{ page: Page; userId: string }> {
	const context = await browser.newContext({ baseURL: APP_ORIGIN });
	const page = await context.newPage();
	const userId = await registerPerson(page);
	await db().insert(staffRoles).values({ userId, role: 'admin', grantedAt: new Date() });
	return { page, userId };
}

test('the administrator switches extract off and back on, and each switch is journaled', async ({ browser }) => {
	// A run that stopped halfway may have left the operation off: start from the default mode.
	const redis = createClient({ url: redisUrl });
	await redis.connect();
	await redis.del('ml:mode:extract');
	redis.destroy();

	const { page, userId } = await signInAdmin(browser);
	await page.goto('/admin');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Кабинет администратора');
	await expectNoAxeViolations(page);

	const extract = page.getByRole('switch', { name: 'Извлечение (LLM)' });
	await expect(extract).toHaveAttribute('aria-checked', 'true');

	await extract.click();
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toContainText('Выключить «Извлечение (LLM)»?');
	await dialog.getByRole('button', { name: 'Выключить' }).click();
	await expect(page.getByRole('status')).toContainText('«Извлечение (LLM)» выключена');
	await expect(extract).toHaveAttribute('aria-checked', 'false');

	await extract.click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Включить' }).click();
	await expect(page.getByRole('status')).toContainText('«Извлечение (LLM)» включена');
	await expect(extract).toHaveAttribute('aria-checked', 'true');

	// Cancelling the confirmation changes nothing.
	await extract.click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Отмена' }).click();
	await expect(extract).toHaveAttribute('aria-checked', 'true');

	const journal = await db()
		.select({ details: auditEvents.details })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'ml.mode_changed'), eq(auditEvents.actorUserId, userId)));
	expect(journal.map((row) => row.details)).toEqual(
		expect.arrayContaining([
			{ operation: 'extract', from: 'on', to: 'off' },
			{ operation: 'extract', from: 'off', to: 'on' }
		])
	);
	expect(journal).toHaveLength(2);
	await page.context().close();
});

test('the administrator enables a vacancy source with its import queued, then disables it', async ({ browser }) => {
	// A run that stopped halfway may have left the source on: start from the state the seed registers.
	await db().update(vacancySources).set({ enabled: false }).where(eq(vacancySources.key, 'trudvsem'));
	const { page, userId } = await signInAdmin(browser);
	await page.goto('/admin/sources');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Источники вакансий');
	await expectNoAxeViolations(page);

	const card = page.locator('[data-source="trudvsem"]');
	const trudvsem = page.getByRole('switch', { name: 'Работа России' });
	await expect(trudvsem).toHaveAttribute('aria-checked', 'false');

	await trudvsem.click();
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toContainText('Включить «Работа России»?');
	await expect(dialog).toContainText('полный импорт');
	await dialog.getByRole('button', { name: 'Включить' }).click();
	await expect(page.getByRole('status')).toContainText('«Работа России» включён: полный импорт поставлен в очередь');
	await expect(trudvsem).toHaveAttribute('aria-checked', 'true');
	await expect(card).toContainText('импорт в очереди');
	// The page is checked once the confirmation has faded out.
	await expect(dialog).toBeHidden();
	await expectNoAxeViolations(page);

	await trudvsem.click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Выключить' }).click();
	await expect(page.getByRole('status')).toContainText('«Работа России» выключен');
	await expect(trudvsem).toHaveAttribute('aria-checked', 'false');

	const journal = await db()
		.select({ action: auditEvents.action, details: auditEvents.details })
		.from(auditEvents)
		.where(and(eq(auditEvents.objectId, 'trudvsem'), eq(auditEvents.actorUserId, userId)));
	const enabled = journal.find((row) => row.action === 'vacancy_source.enabled');
	expect(enabled?.details).toMatchObject({ source: 'trudvsem' });
	expect(journal.find((row) => row.action === 'vacancy_source.disabled')?.details).toEqual({
		source: 'trudvsem',
		reason: 'administrator'
	});
	expect(journal).toHaveLength(2);

	// No worker runs against the test stand; the queued import would skip a disabled source anyway.
	const jobId = (enabled?.details as { import_job_id?: unknown } | null)?.import_job_id;
	if (typeof jobId !== 'string') throw new Error('the enabling entry names no import job');
	await db()
		.update(jobs)
		.set({ status: 'cancelled', finishedAt: sql`now()` })
		.where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')));
	await page.context().close();
});

test('the reference books, the quality panel, people and the journal render without violations', async ({
	browser
}) => {
	const { page } = await signInAdmin(browser);

	await page.goto('/admin/quality');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Качество моделей');
	await expect(page.getByTestId('quality-empty').or(page.locator('[data-eval-run]'))).toBeVisible();
	await expectNoAxeViolations(page);

	await page.goto('/admin/taxonomy');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Таксономия');
	await page.getByLabel('Навык или синоним').fill('postgres');
	await page.getByRole('button', { name: 'Найти' }).click();
	await expect(page).toHaveURL(/q=postgres/);
	await expect(page.getByTestId('skills')).toContainText('PostgreSQL');
	await expectNoAxeViolations(page);

	for (const [path, heading] of [
		['/admin/rules', 'Правила'],
		['/admin/documents', 'Документы'],
		['/admin/policies', 'Политики продукта'],
		['/admin/staff', 'Пользователи и персонал']
	] as const) {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
		await expectNoAxeViolations(page);
	}

	await page.goto('/admin/documents');
	await page.getByTestId('documents').getByRole('link').first().click();
	await expect(page.getByTestId('document-body')).not.toBeEmpty();
	await expectNoAxeViolations(page);

	// The administrator role includes reading the journal; the reading itself is the newest event on the next reading.
	await page.goto('/admin/audit');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Журнал действий');
	await expect(page.getByTestId('journal-filters')).toBeVisible();
	await expectNoAxeViolations(page);
	await page.getByLabel('Событие').selectOption('audit.read');
	await page.getByRole('button', { name: 'Показать' }).click();
	await expect(page).toHaveURL(/action=audit\.read/);
	await expect(page.getByTestId('journal').locator('[data-action="audit.read"]').first()).toBeVisible();
	await expectNoAxeViolations(page);
	await page.context().close();
});

test('somebody who is not an administrator does not get into the cabinet', async ({ page }) => {
	await registerPerson(page);
	// The session token of the person, from a form of their own onboarding page: the refusal below is the cabinet's.
	const csrfToken = await page.locator('input[name="csrf_token"]').first().inputValue();
	const refused = await page.goto('/admin');
	expect(refused?.status()).toBe(403);
	const refusedAction = await page.request.post('/admin?/switchMode', {
		headers: { origin: APP_ORIGIN },
		form: { csrf_token: csrfToken, operation: 'extract', mode: 'off' }
	});
	expect(refusedAction.status()).toBe(403);
	expect(await refusedAction.text()).toContain('Кабинет администратора доступен только администраторам');
	const refusedSource = await page.request.post('/admin/sources?/switchSource', {
		headers: { origin: APP_ORIGIN },
		form: { csrf_token: csrfToken, source: 'trudvsem', enabled: 'true' }
	});
	expect(refusedSource.status()).toBe(403);
});

test('an anonymous visitor is sent to sign in instead of the cabinet', async ({ page }) => {
	await page.goto('/admin/staff');
	await expect(page).toHaveURL(/\/login\?returnTo=%2Fadmin%2Fstaff/);
});
