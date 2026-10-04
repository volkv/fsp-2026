import { describe, expect, it } from 'vitest';
import { shownPostings, type PostingView } from './attribution';

const posting: PostingView = {
	source: 'habr_career',
	sourceName: 'Хабр Карьера',
	attribution: 'По данным Хабр Карьеры',
	url: 'https://career.habr.com/vacancies/1',
	title: 'Go-разработчик',
	organizationName: 'Пример',
	freshness: 'active',
	sourcePublishedAt: null,
	firstFetchedAt: new Date('2026-09-25T00:00:00Z'),
	lastCheckedAt: new Date('2026-09-25T00:00:00Z')
};

describe('postings a vacancy is shown with', () => {
	it('are the postings of an external vacancy', () => {
		expect(shownPostings({ id: 'v1', origin: 'external' }, new Map([['v1', [posting]]]))).toEqual([posting]);
	});

	it('refuse to show an external vacancy without a posting: it would have no source', () => {
		expect(() => shownPostings({ id: 'v1', origin: 'external' }, new Map())).toThrow(/no posting/u);
	});

	it('are none for an own vacancy', () => {
		expect(shownPostings({ id: 'v2', origin: 'own' }, new Map())).toEqual([]);
	});
});
