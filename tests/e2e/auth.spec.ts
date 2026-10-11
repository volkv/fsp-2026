// Sign-up and sign-in in the browser against the local infrastructure (`make infra`): the application from `.env` with
// the legal documents published by `scripts/seed-legal.ts`, letters read from Mailpit, «Войти через ФСП ID» through the
// FSP simulator with a demo account.
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';

/** Mailpit's API on the host (compose.yaml publishes 8025 as 57825). */
const MAILPIT = 'http://127.0.0.1:57825';
const PASSWORD = 'e2e passphrase long';

/** The link of the newest letter to the address whose subject contains `subject`. */
async function linkFromLetter(to: string, subject: string): Promise<string> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
		const { messages } = (await search.json()) as { messages: { ID: string; Subject: string }[] };
		const letter = messages.find((m) => m.Subject.includes(subject));
		if (letter) {
			const { Text } = (await (await fetch(`${MAILPIT}/api/v1/message/${letter.ID}`)).json()) as { Text: string };
			const link = /https?:\/\/\S+token=[A-Za-z0-9_%-]+/.exec(Text)?.[0];
			if (!link) throw new Error(`letter «${letter.Subject}» has no link`);
			return link;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`no letter «${subject}» to ${to}`);
}

async function expectNoAxeViolations(page: Page): Promise<void> {
	const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
	expect(result.violations.map((v) => v.id)).toEqual([]);
}

// Forms are posted and FSP ID returns to the public origin of the application (playwright.config.ts, APP_ORIGIN).
test.use({ baseURL: APP_ORIGIN });

test('a candidate registers, confirms the address, gives the consent and signs out', async ({ page }) => {
	const email = `e2e-${randomUUID()}@example.org`;
	await page.goto('/register');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Регистрация');
	await expectNoAxeViolations(page);

	await page.getByRole('radio', { name: /Ищу работу/ }).check();
	await page.getByLabel('Как к вам обращаться').fill('Тест Кандидатов');
	await page.getByLabel('Почта').fill(email);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByLabel('Дата рождения').fill('2000-03-15');
	await page.getByRole('checkbox', { name: /Принимаю/ }).check();
	await page.getByRole('button', { name: 'Зарегистрироваться' }).click();

	await expect(page).toHaveURL(/\/onboarding$/);
	await expect(page.getByTestId('viewer-link')).toContainText('Тест Кандидатов');
	await expect(page.locator('[data-step="email"]')).toHaveAttribute('data-done', 'false');

	const link = new URL(await linkFromLetter(email, 'Подтвердите почту'));
	await page.goto(`${link.pathname}${link.search}`);
	await page.getByRole('button', { name: 'Подтвердить почту' }).click();
	await expect(page.getByText('Почта подтверждена.')).toBeVisible();

	await page.goto('/onboarding');
	await expect(page.locator('[data-step="email"]')).toHaveAttribute('data-done', 'true');
	await page.getByRole('link', { name: 'Прочитать и дать согласие' }).click();
	await expect(page.getByTestId('consent-text')).toBeVisible();
	await page.getByRole('button', { name: 'Даю согласие' }).click();
	// The registration goes on with the survey and the declared grade (domain 12.2): the survey opens after the consent.
	await expect(page).toHaveURL(/\/onboarding\/survey$/);
	await expect(page.getByTestId('survey-form')).toBeVisible();
	await page.goto('/onboarding');
	await expect(page.locator('[data-step="consent"]')).toHaveAttribute('data-done', 'true');
	await expect(page.locator('[data-step="survey"]')).toHaveAttribute('data-done', 'false');
	await expect(page.getByRole('link', { name: 'Пройти опрос' })).toHaveAttribute('href', '/onboarding/survey');
	await page.goto('/account');
	await expect(page.getByTestId('account-email')).toHaveText(email);

	// A state-changing request of the session without its CSRF token is refused.
	const forged = await page.request.post('/auth/logout', { form: {} });
	expect(forged.status()).toBe(403);

	await page.getByRole('button', { name: 'Выйти' }).first().click();
	await expect(page).toHaveURL(/\/$/);
	// A wrong password is not tried here: failures count per client address (15 minutes), and every e2e run comes from
	// the same one; refusals and lockout are covered by tests/integration/auth-password.test.ts.
	await page.goto('/login');
	await page.getByLabel('Почта').fill(email);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	// The registration is not complete without the survey: the sign-in leads back to its steps.
	await expect(page).toHaveURL(/\/onboarding$/);
});

/** Signs in at the simulator with a demo account, unless its session is still alive there. */
async function signInThroughFsp(page: Page, demo: string): Promise<void> {
	await page.goto('/login');
	await page.getByRole('button', { name: 'Войти через ФСП ID' }).click();
	await page.waitForURL(
		(url) =>
			url.pathname.includes('/login-actions/') || (url.pathname !== '/login' && !url.pathname.startsWith('/auth/'))
	);
	if (page.url().includes('/login-actions/')) {
		await expect(page.getByRole('heading', { name: 'Вход в ФСП ID' })).toBeVisible();
		await page.getByRole('button', { name: new RegExp(demo) }).click();
	}
	await page.waitForURL((url) => !url.pathname.includes('/login-actions/') && !url.pathname.startsWith('/auth/'));
}

test('an athlete signs in through FSP ID with a demo account', async ({ page }) => {
	const demo = 'Капитан, backend, МС';
	await signInThroughFsp(page, demo);
	// The first sign-in of this identity on the stand continues with the registration form, prefilled from FSP ID.
	if (new URL(page.url()).pathname === '/register') {
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Завершите регистрацию');
		await expect(page.getByLabel('Как к вам обращаться')).not.toHaveValue('');
		await page.getByLabel('Дата рождения').fill('2001-09-01');
		await page.getByRole('checkbox', { name: /Принимаю/ }).check();
		await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
		await expect(page).toHaveURL(/\/onboarding/);
	}
	await expect(page.getByTestId('viewer-link')).toBeVisible();

	// Signed out and in again: the same identity signs in without a form.
	await page.getByRole('button', { name: 'Выйти' }).first().click();
	await expect(page).toHaveURL(/\/$/);
	await signInThroughFsp(page, demo);
	expect(new URL(page.url()).pathname).not.toBe('/register');
	await expect(page.getByTestId('viewer-link')).toBeVisible();
	await page.goto('/account');
	await expect(page.getByTestId('fsp-section')).toContainText('Привязан');
});
