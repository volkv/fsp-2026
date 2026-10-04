import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test';

/** Collects console errors and page errors (including CSP violations) for the whole test. */
function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	page.on('pageerror', (error) => {
		errors.push(error.message);
	});
	return errors;
}

async function expectNoAxeViolations(page: Page): Promise<void> {
	const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
	const summary = result.violations.map((violation) => ({
		id: violation.id,
		nodes: violation.nodes.slice(0, 5).map((node) => `${node.target.join(' ')} — ${node.failureSummary ?? ''}`)
	}));
	expect(summary).toEqual([]);
}

test('home page presents the product without errors', async ({ page }) => {
	const errors = watchErrors(page);
	const response = await page.goto('/');
	expect(response?.status()).toBe(200);

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('ФСП | Карьера');
	await expect(page.getByText('Платформа ИТ-найма, где навыки подтверждены').first()).toBeVisible();
	await expect(page.getByRole('link', { name: 'ФСП | Карьера — на главную' })).toBeVisible();
	for (const id of ['employers', 'candidates', 'fsp', 'how']) {
		await expect(page.locator(`#${id}`)).toBeAttached();
	}
	// Market figures are shown only with their source.
	await expect(page.getByText(/Источник: Хантфлоу и Джун/).first()).toBeVisible();
	await expect(page.locator('[data-notice="recommendation"]')).toBeVisible();

	await expectNoAxeViolations(page);
	expect(errors).toEqual([]);
});

test('fonts are served locally', async ({ page }) => {
	const external: string[] = [];
	page.on('request', (request) => {
		if (!request.url().startsWith('http://127.0.0.1:')) external.push(request.url());
	});
	await page.goto('/design');
	await page.evaluate(() => document.fonts.ready);
	const loaded = await page.evaluate(() =>
		[...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family.replaceAll('"', ''))
	);
	expect(loaded).toContain('Inter');
	expect(loaded).toContain('JetBrains Mono');
	expect(external).toEqual([]);
});

test('showcase renders every component group without errors', async ({ page }) => {
	const errors = watchErrors(page);
	const response = await page.goto('/design');
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading', { level: 1, name: 'Дизайн-система' })).toBeVisible();

	for (const title of ['Токены', 'Базовые компоненты', 'Продуктовые компоненты', 'Оболочка']) {
		await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
	}

	const chips = page.getByTestId('trust-chips');
	for (const level of ['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed', 'derived']) {
		await expect(chips.locator(`[data-trust="${level}"]`).first()).toBeVisible();
	}
	await expect(page.locator('[data-receipt-status="valid"]').first()).toBeVisible();
	await expect(page.locator('[data-receipt-status="annulled"]')).toBeVisible();
	await expect(page.locator('[data-award]')).toHaveCount(4);
	await expect(page.locator('[data-axis="grade"][data-status="insufficient_data"]').first()).toBeVisible();
	await expect(page.locator('[data-category-outcome="insufficient_data"]')).toBeVisible();
	await expect(page.locator('[data-salary="not_stated"]')).toHaveText('Зарплата не указана');
	await expect(page.locator('[data-comparison="not_comparable"]')).toBeVisible();
	for (const status of ['sent', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn']) {
		await expect(page.locator(`[data-invitation-status="${status}"]`).first()).toBeVisible();
	}
	const deadlines = page.getByTestId('deadlines');
	for (const phase of ['open', 'soon', 'expired']) {
		await expect(deadlines.locator(`[data-deadline="${phase}"]`).first()).toBeVisible();
	}
	await expect(page.locator('[data-outcome-state="diverged"]')).toBeVisible();
	await expect(page.locator('[data-notice="degraded"]').first()).toBeVisible();
	// Every section of a workspace leads to its page.
	const sections = {
		кандидат: { Профиль: '/me/profile', Категория: '/me/category', Резюме: '/me/resume', Тесты: '/me/tests' },
		'оператор фсп': { Заявки: '/operator/claims', Навыки: '/operator/skills', Импорт: '/operator/fsp-import' },
		администратор: {
			Правила: '/admin/rules',
			'Источники вакансий': '/admin/sources',
			Политики: '/admin/policies',
			Документы: '/admin/documents'
		}
	};
	for (const [workspace, links] of Object.entries(sections)) {
		const nav = page.getByRole('navigation', { name: `Разделы: ${workspace}` });
		for (const [label, href] of Object.entries(links)) {
			await expect(nav.getByRole('link', { name: label })).toHaveAttribute('href', href);
		}
	}

	await expectNoAxeViolations(page);
	expect(errors).toEqual([]);
});

test('trust chip explains itself on keyboard focus', async ({ page }) => {
	await page.goto('/design');
	const chips = page.getByTestId('trust-chips');
	const first = chips.locator('[data-trust="fsp_verified"]').first();
	const second = chips.locator('[data-trust="platform_verified"]').first();
	// Keyboard focus within one row: a tooltip closes when the page scrolls, as focusing a far element would do.
	await second.scrollIntoViewIfNeeded();
	await first.focus();
	await page.keyboard.press('Tab');
	await expect(second).toBeFocused();
	// The open hint is the chip's accessible description (aria-describedby).
	await expect(second).toHaveAccessibleDescription(/Не подтверждает: Самостоятельность выполнения/);
	await page.keyboard.press('Escape');
	await expect(second).not.toHaveAttribute('aria-describedby');
});

test('dialog opens, traps focus and closes with Escape', async ({ page }) => {
	await page.goto('/design');
	await page.getByRole('button', { name: 'Отклонить с причиной' }).click();
	const trigger = page.getByRole('button', { name: 'Отклонить с причиной' });
	const dialog = page.getByRole('dialog', { name: 'Отклонить приглашение' });
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Tab');
	expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
});

test('theme toggle switches to the dark theme and keeps contrast', async ({ page }) => {
	const errors = watchErrors(page);
	await page.goto('/design');
	await page.getByRole('button', { name: 'Переключить светлую и тёмную тему' }).first().click();
	await expect(page.locator('html')).toHaveClass(/dark/);
	await expectNoAxeViolations(page);
	expect(errors).toEqual([]);
});

test('workspace sections fit in one row or scroll with a visible edge', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/design');
	const row = (workspace: string) =>
		page.getByTestId('workspace-nav').filter({ has: page.getByRole('navigation', { name: `Разделы: ${workspace}` }) });
	const operator = row('оператор фсп');
	await expect(operator.locator('..').locator('[data-edge="end"]')).toHaveAttribute('data-shown', 'false');
	await expect(row('администратор').locator('..').locator('[data-edge="end"]')).toHaveAttribute('data-shown', 'false');

	await page.setViewportSize({ width: 800, height: 900 });
	const end = operator.locator('..').locator('[data-edge="end"]');
	await expect(end).toHaveAttribute('data-shown', 'true');
	const lastLink = operator.getByRole('link').last();
	await lastLink.scrollIntoViewIfNeeded();
	await expect(end).toHaveAttribute('data-shown', 'false');
	await expect(operator.locator('..').locator('[data-edge="start"]')).toHaveAttribute('data-shown', 'true');
	// One line per section: a label never wraps.
	expect((await lastLink.boundingBox())?.height).toBeLessThan(40);
});

test('mobile header opens the navigation menu', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await page.getByRole('banner').getByRole('button', { name: 'Открыть меню' }).click();
	const menu = page.getByRole('dialog');
	await expect(menu.getByRole('link', { name: 'Работодателям' })).toBeVisible();
	// Contrast is checked on the open menu, not on its fade-in: mid-animation the text is still translucent.
	await menu.evaluate(async (element) => {
		await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
	});
	await expectNoAxeViolations(page);
});
