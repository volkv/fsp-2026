import { describe, expect, it } from 'vitest';
import { parseDate, parsePeriod, PERIOD_PATTERN } from './periods';

const AS_OF = new Date('2026-09-25T12:00:00Z');

describe('periods of experience', () => {
	it('finds periods as resumes write them', () => {
		const found = (text: string) => Array.from(text.matchAll(PERIOD_PATTERN), (m) => [m[1], m[2]]);
		expect(found('Март 2021 —\nнастоящее время\n5 лет 7 месяцев')).toEqual([['Март 2021', 'настоящее время']]);
		expect(found('01.2022 – н. в.')).toEqual([['01.2022', 'н. в.']]);
		expect(found('10/2022 – по наст. время')).toEqual([['10/2022', 'по наст. время']]);
		expect(found('Июнь 2019 — Февраль 2021')).toEqual([['Июнь 2019', 'Февраль 2021']]);
		expect(found('2017 - 2019')).toEqual([['2017', '2019']]);
		expect(found('Высшее, 2019')).toEqual([]);
	});

	it('keeps the precision of each end', () => {
		expect(parseDate('Сентябрь 2018', false)).toEqual({ date: '2018-09-01', precision: 'month' });
		expect(parseDate('2019', false)).toEqual({ date: '2019-01-01', precision: 'year' });
		expect(parseDate('2019', true)).toEqual({ date: '2019-12-01', precision: 'year' });
		expect(parseDate('03.2021', false)).toEqual({ date: '2021-03-01', precision: 'month' });
	});

	it('marks a period without a start as missing and an impossible one as invalid', () => {
		expect(parsePeriod('Март 2021', 'настоящее время', AS_OF)).toMatchObject({
			status: 'valid',
			isCurrent: true,
			to: null
		});
		expect(parsePeriod('05.2019', '2019', AS_OF).status).toBe('valid');
		expect(parsePeriod(null, '2021', AS_OF).status).toBe('missing');
		expect(parsePeriod('2022', '2020', AS_OF).status).toBe('invalid');
		expect(parsePeriod('2027', 'настоящее время', AS_OF).status).toBe('invalid');
		expect(parsePeriod('01.2026', '2026', AS_OF).status).toBe('valid');
	});
});
