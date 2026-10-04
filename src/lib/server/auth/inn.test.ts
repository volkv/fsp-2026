import { describe, expect, it } from 'vitest';
import { isValidInn } from './inn';

describe('isValidInn', () => {
	it('accepts organisation and entrepreneur numbers with correct check digits', () => {
		// ПАО «Сбербанк» and a published sample of an individual entrepreneur.
		expect(isValidInn('7707083893')).toBe(true);
		expect(isValidInn('500100732259')).toBe(true);
	});

	it('refuses a wrong check digit, a wrong length and non-digits', () => {
		expect(isValidInn('7707083894')).toBe(false);
		expect(isValidInn('500100732258')).toBe(false);
		expect(isValidInn('77070838')).toBe(false);
		expect(isValidInn('77070838 3')).toBe(false);
	});
});
