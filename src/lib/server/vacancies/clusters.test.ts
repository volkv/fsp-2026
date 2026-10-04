import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { externalStatus, organizationKey, postingKeys, termsConflict } = await import('./clusters');
const { checkVacancyText } = await import('./text-check');

type Posting = Parameters<typeof termsConflict>[0][number];

const NOW = new Date('2026-09-25T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function posting(overrides: Partial<Posting> = {}): Posting {
	return {
		id: '00000000-0000-7000-8000-000000000001',
		vacancyId: '00000000-0000-7000-8000-000000000002',
		source: 'trudvsem',
		externalId: '1',
		url: 'https://example.test/1',
		organization: { name: 'Пример', inn: null },
		title: 'Разработчик',
		originalTerms: {},
		rawSha256: '0'.repeat(64),
		normalized: {},
		normalizationVersion: 'pending',
		sourcePublishedAt: null,
		sourceUpdatedAt: null,
		firstFetchedAt: days(1),
		lastFetchedAt: days(1),
		lastCheckedAt: days(1),
		freshness: 'active',
		goneAt: null,
		dedup: {},
		lastImportRunId: '00000000-0000-7000-8000-000000000003',
		seedBatchId: null,
		createdAt: days(1),
		updatedAt: days(1),
		...overrides
	};
}

const normalized = (salary: [number, number] | null, grade: string | null) => ({
	normalizationVersion: 'vacancy-normalize/1+test',
	normalized: {
		rules_version: 'vacancy-normalize/1',
		role: { key: null, method: 'none', rule: null },
		grade: grade
			? { min: grade, max: grade, basis: 'stated', method: 'source_field' }
			: { min: null, max: null, basis: 'unknown', method: 'none' },
		skills: { required: [], nice: [], unknown: [], methods: {} },
		salary: salary
			? {
					status: 'stated',
					reason: null,
					min: salary[0],
					max: salary[1],
					currency: 'RUB',
					period: 'month',
					tax_base: 'unknown'
				}
			: { status: 'absent', reason: null, min: null, max: null, currency: null, period: null, tax_base: null },
		work_format: null,
		employment_form: null,
		city: null
	}
});

describe('keys of postings', () => {
	it('folds legal forms, quotes and case of an organization', () => {
		expect(organizationKey('ООО «Яндекс»')).toBe(organizationKey('яндекс'));
		expect(organizationKey('АО "РАЙФФАЙЗЕНБАНК"')).toBe('райффайзенбанк');
	});

	it('gives an exact key only with an INN', () => {
		const withInn = postingKeys({
			title: 'Go-разработчик',
			organization: { name: 'ООО Ромашка', inn: '7700000000' },
			city: 'Москва'
		});
		const withoutInn = postingKeys({
			title: 'Go разработчик',
			organization: { name: 'Ромашка', inn: null },
			city: 'москва'
		});
		expect(withInn.exact).toBe('7700000000|go разработчик|москва');
		expect(withoutInn.exact).toBeNull();
		expect(withoutInn.fingerprint).toBe(withInn.fingerprint);
	});
});

describe('cluster state', () => {
	const clean = checkVacancyText({ title: 'Разработчик' });

	it('is closed when every posting is gone and hidden when the text is blocked', () => {
		expect(externalStatus([posting({ freshness: 'gone', goneAt: NOW })], clean, NOW, 14)).toBe('closed');
		expect(externalStatus([posting()], checkVacancyText({ title: 'Только мужчины' }), NOW, 14)).toBe('hidden');
	});

	it('goes stale when no live posting was confirmed within the policy', () => {
		expect(externalStatus([posting({ lastCheckedAt: days(20) })], clean, NOW, 14)).toBe('stale');
		expect(
			externalStatus([posting({ lastCheckedAt: days(20) }), posting({ lastCheckedAt: days(2) })], clean, NOW, 14)
		).toBe('active');
		expect(externalStatus([posting({ lastCheckedAt: days(200) })], clean, NOW, null)).toBe('active');
	});

	it('marks a conflict only between live postings with known, different terms', () => {
		const a = posting(normalized([100_000, 150_000], 'middle'));
		expect(termsConflict([a, posting(normalized([100_000, 150_000], 'middle'))])).toBe(false);
		expect(termsConflict([a, posting(normalized([120_000, 150_000], 'middle'))])).toBe(true);
		expect(termsConflict([a, posting(normalized(null, 'senior'))])).toBe(true);
		expect(termsConflict([a, posting(normalized(null, null))])).toBe(false);
		expect(termsConflict([a, posting({ ...normalized([1, 2], 'lead'), freshness: 'gone', goneAt: NOW })])).toBe(false);
	});
});
