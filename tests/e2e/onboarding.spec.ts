// Tours of the cabinets: the one-time invitation, the tour of the sections that moves between pages, the tour of a page
// from the header button, and the page under a running tour staying usable — the framed element takes the click.
//
// The person registers through the form; the operator role is written directly (the administrator's decision): the
// operator's cabinet needs no further registration steps, so the invitation comes on its first page.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { eq } from 'drizzle-orm';
import { companies, companyMembers, staffRoles } from '$lib/server/db/schema';

const PASSWORD = 'e2e passphrase long';

const { closeDb, db } = await import('$lib/server/db');

test.afterAll(async () => {
	await closeDb();
});

test.use({ baseURL: APP_ORIGIN, tours: true, viewport: { width: 1280, height: 900 } });

function organizationInn(): string {
	const digits = Array.from({ length: 9 }, (_, index) =>
		index === 0 ? 1 + ((randomBytes(1)[0] ?? 0) % 9) : (randomBytes(1)[0] ?? 0) % 10
	);
	const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
	const sum = digits.reduce((total, digit, index) => total + digit * (weights[index] ?? 0), 0);
	return [...digits, (sum % 11) % 10].join('');
}

/** Registers a person through the form and makes them an operator of the federation. */
async function signInOperator(page: Page): Promise<void> {
	const inn = organizationInn();
	await page.goto('/register');
	await page.getByRole('radio', { name: /Нанимаю/ }).check();
	await page.getByLabel('Ваше имя').fill('Оператор Тура');
	await page.getByLabel('Рабочая почта').fill(`e2e-tour-${randomUUID()}@example.org`);
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
	await db().insert(staffRoles).values({ userId: member.userId, role: 'operator', grantedAt: new Date() });
}

test('the invitation comes once and the tour of the sections moves between pages', async ({ page }) => {
	await signInOperator(page);
	await page.goto('/operator');

	const welcome = page.getByTestId('tour-welcome');
	await expect(welcome).toBeVisible();
	await welcome.getByRole('button', { name: 'Начать тур' }).click();
	await expect(welcome).toBeHidden();

	const card = page.getByTestId('tour-card');
	await expect(card).toBeVisible();
	await expect(card).toBeFocused();
	// The tour starts where the tours are found: the button in the header.
	await expect(card).toContainText('Подсказки — здесь');
	await card.getByRole('button', { name: 'Далее' }).click();
	await expect(card).toContainText('2 из');
	await card.getByRole('button', { name: 'Далее' }).click();
	await expect(page).toHaveURL(/\/operator\/companies$/);
	await expect(page.getByTestId('tour-frame')).toBeVisible();

	// The frame and its dimming let the pointer through: the framed navigation item is what the click lands on.
	const box = await page.getByTestId('tour-frame').boundingBox();
	if (!box) throw new Error('the frame has no box');
	const hit = await page.evaluate(
		({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-tour]')?.getAttribute('data-tour') ?? null,
		{ x: box.x + box.width / 2, y: box.y + box.height / 2 }
	);
	expect(hit).toBe('nav:/operator/companies');
	// The rest of the page as well: another section opens under the running tour.
	await page.getByRole('navigation', { name: 'Разделы: оператор фсп' }).getByRole('link', { name: 'Исходы' }).click();
	await expect(page).toHaveURL(/\/operator\/outcomes$/);
	await expect(card).toBeVisible();

	await card.focus();
	await page.keyboard.press('Escape');
	await expect(card).toBeHidden();

	await page.reload();
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(welcome).toBeHidden();
});

test('the tour button pulses until the tour of the page is opened', async ({ page }) => {
	await signInOperator(page);
	await page.goto('/operator');
	await page.getByTestId('tour-welcome').getByRole('button', { name: 'Позже' }).click();

	const button = page.locator('[data-tour="tour-button"]');
	await expect(button).toHaveAttribute('data-fresh', '');
	await button.click();
	await page.getByRole('menuitem', { name: /Тур по этой странице/ }).click();
	await expect(page.getByTestId('tour-card')).toBeVisible();
	await expect(button).not.toHaveAttribute('data-fresh', '');

	// The tour of a page ends when the page is left.
	await page.goto('/operator/companies');
	await expect(page.getByTestId('tour-card')).toBeHidden();
	await expect(button).toHaveAttribute('data-fresh', '');
});
