import { expect, test } from './helpers/test';

test('home page renders', async ({ page }) => {
	const response = await page.goto('/');
	expect(response?.status()).toBe(200);
	await expect(page).toHaveTitle(/ФСП \| Карьера/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('ФСП | Карьера');
});

test('health endpoint reports ok', async ({ request }) => {
	const response = await request.get('/api/health');
	expect(response.status()).toBe(200);
	expect(response.headers()['cache-control']).toBe('no-store');
	expect(await response.json()).toMatchObject({
		status: 'ok',
		checks: { database: 'up', redis: 'up' }
	});
});
