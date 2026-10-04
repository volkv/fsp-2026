// Sections of the shell behind a permission: the operator's journal shows in the header, the mobile menu and the tabs
// of the cabinet only once the administrator has granted `audit.read`, and it opens then.
//
// The person registers through the form (the password and address need the keys of the running application). The
// operator role and the grant are written directly: they are the administrator's decisions.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { and, eq, isNull } from 'drizzle-orm';
import { companies, companyMembers, staffRoles } from '$lib/server/db/schema';

const PASSWORD = 'e2e passphrase long';

// The pool of the application's own module: `closeDb` in `afterAll` ends it and the next query opens a new one, so a
// worker that comes back to this file for another group of its tests (fullyParallel) still reaches the database.
const { closeDb, db } = await import('$lib/server/db');

test.afterAll(async () => {
	await closeDb();
});

// Forms are posted to the public origin of the application (playwright.config.ts, APP_ORIGIN).
test.use({ baseURL: APP_ORIGIN });

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
	await page.getByLabel('Ваше имя').fill('Оператор Проверочный');
	await page.getByLabel('Рабочая почта').fill(`e2e-shell-${randomUUID()}@example.org`);
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

test('the operator sees the journal in the menu only with audit.read', async ({ page }) => {
	const userId = await registerPerson(page);
	await db().insert(staffRoles).values({ userId, role: 'operator', grantedAt: new Date() });

	await page.goto('/operator');
	const sections = page.getByRole('navigation', { name: 'Разделы: оператор фсп' });
	const tabs = page.getByRole('navigation', { name: 'Разделы кабинета оператора' });
	await expect(sections.getByRole('link', { name: 'Исходы' })).toBeVisible();
	await expect(sections.getByRole('link', { name: 'Журнал' })).toHaveCount(0);
	await expect(tabs.getByRole('link', { name: 'Карьерные исходы' })).toBeVisible();
	await expect(tabs.getByRole('link', { name: 'Журнал' })).toHaveCount(0);

	await db()
		.update(staffRoles)
		.set({ extraPermissions: ['audit.read'] })
		.where(and(eq(staffRoles.userId, userId), eq(staffRoles.role, 'operator'), isNull(staffRoles.revokedAt)));

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.reload();
	await expect(tabs.getByRole('link', { name: 'Журнал' })).toHaveAttribute('href', '/operator/audit');
	// Every section, the journal included, fits in the row of a desktop screen: no edge hides one of them.
	const row = page.getByTestId('workspace-nav').filter({ has: sections });
	await expect(row.locator('..').locator('[data-edge="end"]')).toHaveAttribute('data-shown', 'false');
	await sections.getByRole('link', { name: 'Журнал' }).click();
	await expect(page).toHaveURL(/\/operator\/audit$/);
	await expect(sections.getByRole('link', { name: 'Журнал' })).toHaveAttribute('aria-current', 'page');

	// The mobile menu lists the same sections.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: 'Открыть меню' }).click();
	const menu = page.getByRole('dialog');
	await expect(menu.getByRole('link', { name: 'Журнал' })).toBeVisible();
});
