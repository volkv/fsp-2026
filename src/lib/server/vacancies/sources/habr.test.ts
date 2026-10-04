import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fixturePath } from '../fixtures/taxonomy';
import { tableFetch } from '../fixtures/feed';
import { HabrCareerSource, habrPostingFromFeed, parseFeed, parseHabrSalary } from './habr';

const RSS = await readFile(fixturePath('habr-rss.xml'), 'utf8');
const PAGE = await readFile(fixturePath('habr-vacancy.html'), 'utf8');
const NOW = new Date('2026-09-25T12:00:00Z');

function source(table: Parameters<typeof tableFetch>[0]) {
	return new HabrCareerSource({
		http: { fetch: tableFetch(table), userAgent: 'test', timeoutMs: 5_000 },
		now: () => NOW
	});
}

describe('Habr Career feed', () => {
	it('reads every item of the saved feed into the white list of fields', async () => {
		const page = await source({ 'https://career.habr.com/vacancies/rss': { status: 200, body: RSS } }).list();
		if (!page.ok) throw new Error(page.error.message);
		expect(page.value.items).toHaveLength(50);
		expect(page.value.nextCursor).toBeNull();
		for (const item of page.value.items) {
			expect(item.externalId).toMatch(/^\d+$/);
			expect(item.url).toBe(`https://career.habr.com/vacancies/${item.externalId}`);
			expect(item.description).toBeNull();
			expect(item.title).not.toMatch(/^Требуется/);
			expect(item.rawSha256).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it('reads the feed with the XML parser: text values, entities decoded, numeric ids kept as written', () => {
		const items = parseFeed(RSS);
		expect(items).toHaveLength(50);
		expect(items[0]).toEqual({
			title: 'Требуется «Менеджер по продажам IT» (Санкт-Петербург)',
			description:
				'Компания «MobileUp» ищет хорошего специалиста на вакансию «Менеджер по продажам IT». Санкт-Петербург (Россия). ' +
				'Полный рабочий день. Можно удалённо. Требуемые навыки: #middle, #B2B, #Продажи.',
			author: 'MobileUp',
			pubDate: 'Thu, 24 Sep 2026 22:37:12 +0300',
			link: 'https://career.habr.com/vacancies/1000168830',
			guid: '1000168830'
		});
		const [escaped] = parseFeed(
			'<rss version="2.0"><channel><item><title>C++ &amp; Qt</title><guid isPermaLink="false">007</guid>' +
				'<description><![CDATA[<b>Go</b>]]></description></item></channel></rss>'
		);
		expect(escaped).toEqual({
			title: 'C++ & Qt',
			description: '<b>Go</b>',
			author: null,
			pubDate: null,
			link: null,
			guid: '007'
		});
		expect(parseFeed('<rss version="2.0"><channel><title>empty</title></channel></rss>')).toEqual([]);
	});

	it('answers a document that is not RSS with a protocol error', async () => {
		const page = await source({
			'https://career.habr.com/vacancies/rss': { status: 200, body: '<html><body>maintenance</body></html>' }
		}).list();
		expect(page).toMatchObject({ ok: false, error: { code: 'protocol_error', retryable: false } });
		expect(() => parseFeed('<rss><channel><item><title><b>x</b></title></item></channel></rss>')).toThrow(/not text/);
	});

	it('parses the template: organization, city, remote, grade tag and skills', () => {
		const [item] = parseFeed(RSS).filter((i) => i.guid === '1000168749');
		if (!item) throw new Error('fixture item is missing');
		const posting = habrPostingFromFeed(item);
		expect(posting).toMatchObject({
			title: 'Software Engineer (C++) / Database Systems',
			organization: { name: 'MIND Software', inn: null, sourceOrgId: null },
			grade: { raw: 'senior' },
			location: { city: 'Москва', remote: null },
			employment: { raw: 'Полный рабочий день' },
			publishedAt: '2026-09-24T15:49:03.000Z'
		});
		expect(posting?.skillsRaw).toEqual([
			'PostgreSQL',
			'Базыданных',
			'C++',
			'YandexDatabase',
			'Проектированиебазданных',
			'ClickHouse'
		]);
		expect(posting?.salary.min).toBeNull();
	});

	it('keeps the title verbatim to find the template sentences after it', () => {
		const [item] = parseFeed(RSS).filter((i) => i.title?.includes('КАЗАНЬ'));
		if (!item) throw new Error('fixture item is missing');
		const posting = habrPostingFromFeed(item);
		expect(posting?.title).toBe('ОБЯЗАТЕЛЬНЫЙ ПЕРЕЕЗД!!Python backend разработчик в г. КАЗАНЬ');
		expect(posting?.salary).toMatchObject({ min: 80_000, max: 600_000, currency: 'RUB', taxBase: null });
		expect(posting?.location.city).toBe('Казань');
	});

	it('reads a salary sentence and leaves the tax base unknown', () => {
		expect(parseHabrSalary('От 70 000 ₽')).toMatchObject({ min: 70_000, max: null, currency: 'RUB', taxBase: null });
		expect(parseHabrSalary('До 90 000 ₽')).toMatchObject({ min: null, max: 90_000 });
		expect(parseHabrSalary('Полный рабочий день')).toBeNull();
	});

	it('hashes a record the same way every time and differently when it changes', () => {
		const [item] = parseFeed(RSS);
		if (!item) throw new Error('fixture item is missing');
		expect(habrPostingFromFeed(item)?.rawSha256).toBe(habrPostingFromFeed({ ...item })?.rawSha256);
		expect(habrPostingFromFeed({ ...item, title: `${item.title ?? ''}!` })?.rawSha256).not.toBe(
			habrPostingFromFeed(item)?.rawSha256
		);
	});

	it('refuses a document that is not RSS as a protocol error', async () => {
		const page = await source({
			'https://career.habr.com/vacancies/rss': { status: 200, body: '<html></html>' }
		}).list();
		expect(page).toMatchObject({ ok: false, error: { code: 'protocol_error', retryable: false } });
	});
});

describe('Habr Career vacancy page', () => {
	it('confirms a live posting from its JobPosting', async () => {
		const result = await source({
			'https://career.habr.com/vacancies/1000168750': { status: 200, body: PAGE }
		}).get('1000168750');
		if (!result.ok || 'gone' in result.value) throw new Error('expected a posting');
		expect(result.value).toMatchObject({
			title: 'Руководитель Frontend-разработки / Head of Frontend',
			organization: { name: 'IT-hunter' },
			grade: { raw: 'Lead' },
			location: { city: 'Москва', remote: true },
			skillsRaw: ['JavaScript', 'Nuxt.js', 'Vue.js', 'Node.js', 'TypeScript'],
			description: null
		});
		expect(JSON.stringify(result.value)).not.toMatch(/example_recruiter|jobs@example/);
	});

	it('takes a posting off on 404 and after its validity date', async () => {
		const missing = await source({ 'https://career.habr.com/vacancies/1': { status: 404, body: '' } }).get('1');
		expect(missing).toEqual({ ok: true, value: { gone: true } });
		const expired = await new HabrCareerSource({
			http: {
				fetch: tableFetch({ 'https://career.habr.com/vacancies/1000168750': { status: 200, body: PAGE } }),
				userAgent: 'test',
				timeoutMs: 5_000
			},
			now: () => new Date('2026-11-01T00:00:00Z')
		}).get('1000168750');
		expect(expired).toEqual({ ok: true, value: { gone: true } });
	});

	it('maps rate limits and refusals to adapter errors', async () => {
		const limited = await source({
			'https://career.habr.com/vacancies/2': { status: 429, body: '', headers: { 'retry-after': '120' } }
		}).get('2');
		expect(limited).toMatchObject({
			ok: false,
			error: { code: 'rate_limited', retryable: true, details: { retry_after_seconds: 120 } }
		});
		const forbidden = await source({ 'https://career.habr.com/vacancies/3': { status: 403, body: '' } }).get('3');
		expect(forbidden).toMatchObject({ ok: false, error: { code: 'forbidden', retryable: false } });
		expect(await source({}).get('../admin')).toMatchObject({ ok: false, error: { code: 'protocol_error' } });
	});
});
