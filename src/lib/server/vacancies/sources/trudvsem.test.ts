import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fixturePath } from '../fixtures/taxonomy';
import { removeContacts } from './contacts';
import { TrudvsemSource, trudvsemSalary } from './trudvsem';

const PAGE = await readFile(fixturePath('trudvsem-page.json'), 'utf8');
const NOW = new Date('2026-09-25T12:00:00Z');

type Answer = { status: number; body: string; headers?: Record<string, string> };

function source(answer: (url: URL) => Answer, requests: URL[] = [], queries = ['программист']) {
	return new TrudvsemSource({
		http: {
			fetch: (input) => {
				const url = new URL(input);
				requests.push(url);
				const { status, body, headers } = answer(url);
				return Promise.resolve(new Response(body, { status, headers: headers ?? {} }));
			},
			userAgent: 'test',
			timeoutMs: 5_000
		},
		now: () => NOW,
		queries
	});
}

describe('«Работа России» listing', () => {
	it('keeps fresh IT postings of the page and drops old and other industries', async () => {
		const requests: URL[] = [];
		const page = await source(() => ({ status: 200, body: PAGE }), requests).list({ mode: 'full' });
		if (!page.ok) throw new Error(page.error.message);
		expect(page.value.items.map((p) => p.externalId)).toEqual([
			'300000000000012/ee08a9ee-b030-11f1-b99e-4972ddb33ebb',
			expect.stringMatching(/\/572331f4-/),
			expect.stringMatching(/\/629d80a8-/),
			expect.stringMatching(/\/477ab560-/)
		]);
		expect(page.value.nextCursor).toBeNull();
		const [request] = requests;
		expect(request?.searchParams.get('text')).toBe('программист');
		expect(request?.searchParams.get('offset')).toBe('0');
		expect(request?.searchParams.get('limit')).toBe('100');
		// Postings in scope were created within 30 days, so the listing asks only for records modified since then.
		expect(request?.searchParams.get('modifiedFrom')).toBe('2026-08-26T12:00:00Z');
	});

	it('never returns contacts of people', async () => {
		const page = await source(() => ({ status: 200, body: PAGE })).list({ mode: 'full' });
		if (!page.ok) throw new Error(page.error.message);
		const text = JSON.stringify(page.value.items);
		expect(text).not.toMatch(/example\.org|000\) 000|900 000-00-00|Контактное лицо/);
		const withContacts = page.value.items.find((p) => p.externalId.includes('572331f4'));
		expect(withContacts?.contactsRemoved).toBe(true);
		expect(withContacts?.description).toContain('[контакт удалён]');
	});

	it('maps the fields of a record', async () => {
		const page = await source(() => ({ status: 200, body: PAGE })).list({ mode: 'full' });
		if (!page.ok) throw new Error(page.error.message);
		const [first] = page.value.items;
		expect(first).toMatchObject({
			title: 'Инженер-программист',
			organization: { name: 'ИП Пример', inn: '000000000012', sourceOrgId: '300000000000012' },
			salary: { min: 30_000, max: 40_000, currency: 'RUB', period: 'month', taxBase: null, rawText: 'от 30000' },
			publishedAt: '2026-09-14T00:00:00.000Z',
			updatedAt: '2026-09-14T14:07:29.000Z'
		});
		expect(first?.skillsRaw.length).toBeGreaterThan(0);
		const remote = page.value.items.find((p) => p.externalId.includes('477ab560'));
		expect(remote?.location.remote).toBe(true);
	});

	it('keeps only records whose page is a web address', async () => {
		const page = JSON.parse(PAGE) as { results: { vacancies: { vacancy: Record<string, unknown> }[] } };
		const [first, second, third] = page.results.vacancies;
		if (!first || !second || !third) throw new Error('the fixture has fewer records');
		first.vacancy.vac_url = 'javascript:alert(1)';
		second.vacancy.vac_url = 'не адрес';
		third.vacancy.vac_url = 'http://trudvsem.ru/vacancy/card/7100019777/629d80a8';
		const listed = await source(() => ({ status: 200, body: JSON.stringify(page) })).list({ mode: 'full' });
		if (!listed.ok) throw new Error(listed.error.message);
		expect(listed.value.items.map((p) => p.url)).toEqual([
			'http://trudvsem.ru/vacancy/card/7100019777/629d80a8',
			expect.stringMatching(/^https:\/\/trudvsem\.ru\/vacancy\/card\/.+\/477ab560-/)
		]);
	});

	it('walks pages and queries with a cursor', async () => {
		const body = (total: number) => JSON.stringify({ ...JSON.parse(PAGE), meta: { total, limit: 100 } });
		const src = source(
			(url) => ({ status: 200, body: body(url.searchParams.get('text') === 'a' ? 150 : 10) }),
			[],
			['a', 'b']
		);
		const first = await src.list({ mode: 'full' });
		expect(first.ok && first.value.nextCursor).toBe('0:1');
		const second = await src.list({ mode: 'full', cursor: '0:1' });
		expect(second.ok && second.value.nextCursor).toBe('1:0');
		const third = await src.list({ mode: 'full', cursor: '1:0' });
		expect(third.ok && third.value.nextCursor).toBeNull();
		expect(await src.list({ mode: 'full', cursor: 'nonsense' })).toMatchObject({
			ok: false,
			error: { code: 'protocol_error' }
		});
	});

	it('asks an incremental listing from its start', async () => {
		const requests: URL[] = [];
		await source(() => ({ status: 200, body: PAGE }), requests).list({
			mode: 'incremental',
			since: '2026-09-24T00:00:00.000Z'
		});
		expect(requests[0]?.searchParams.get('modifiedFrom')).toBe('2026-09-24T00:00:00Z');
	});

	it('maps failures of the API to adapter errors', async () => {
		const failure = (status: number, headers?: Record<string, string>) =>
			source(() => ({ status, body: '', ...(headers ? { headers } : {}) })).list({ mode: 'full' });
		expect(await failure(503)).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: true } });
		expect(await failure(429, { 'retry-after': '30' })).toMatchObject({
			ok: false,
			error: { code: 'rate_limited', details: { retry_after_seconds: 30 } }
		});
		expect(await failure(403)).toMatchObject({ ok: false, error: { code: 'forbidden', retryable: false } });
		const broken = await source(() => ({ status: 200, body: '{"status":"500"}' })).list({ mode: 'full' });
		expect(broken).toMatchObject({ ok: false, error: { code: 'protocol_error' } });
	});
});

describe('«Работа России» single record', () => {
	it('is gone when the API has no such record', async () => {
		const empty = JSON.stringify({
			status: '200',
			request: { api: 'v1' },
			meta: { total: 0, limit: 100 },
			results: {}
		});
		const result = await source(() => ({ status: 200, body: empty })).get(
			'1027739326449/ad5ea3d9-5d7a-11f1-86a0-6d7ecfad847a'
		);
		expect(result).toEqual({ ok: true, value: { gone: true } });
	});

	it('confirms a record in scope and reads it from the company path', async () => {
		const requests: URL[] = [];
		const one = JSON.parse(PAGE) as { results: { vacancies: unknown[] } };
		const body = JSON.stringify({
			...one,
			meta: { total: 1 },
			results: { vacancies: one.results.vacancies.slice(2, 3) }
		});
		const result = await source(() => ({ status: 200, body }), requests).get(
			'7100019777/629d80a8-0000-0000-0000-000000000000'
		);
		expect(result.ok && !('gone' in result.value) && result.value.title).toBe(
			'Тестировщик (Верификатор) / QA Engineer'
		);
		expect(requests[0]?.pathname).toBe('/api/v1/vacancies/vacancy/7100019777/629d80a8-0000-0000-0000-000000000000');
	});
});

describe('salary of a record', () => {
	const salary = (text: string, min: number, max: number) =>
		trudvsemSalary({ salary: text, salary_min: min, salary_max: max, currency: '«руб.»' });

	it('reads «от N» with equal bounds as an open range', () => {
		expect(salary('от 149426', 149_426, 149_426)).toMatchObject({ min: 149_426, max: null });
	});

	it('keeps a real range and treats zero as unknown', () => {
		expect(salary('от 30000', 30_000, 40_000)).toMatchObject({ min: 30_000, max: 40_000, currency: 'RUB' });
		expect(salary('от 0', 0, 0)).toMatchObject({ min: null, max: null, currency: null, period: null });
		expect(salary('от 340000', 340_000, 0)).toMatchObject({ min: 340_000, max: null });
	});
});

describe('contacts', () => {
	it('removes e-mails, phones, handles and profile links', () => {
		const { text, removed } = removeContacts(
			'Пишите hr@example.org, звоните +7 (900) 000-00-00 или 8 900 000 00 00, телеграм @recruiter_bot, t.me/somebody, опыт 3-5 лет, C# и .NET'
		);
		expect(removed).toBe(true);
		expect(text).not.toMatch(/example|900|recruiter_bot|somebody/);
		expect(text).toContain('опыт 3-5 лет, C# и .NET');
	});

	it('leaves a text without contacts as it is', () => {
		expect(removeContacts('Зарплата от 200 000 ₽, стек Python 3.12')).toEqual({
			text: 'Зарплата от 200 000 ₽, стек Python 3.12',
			removed: false
		});
	});
});
