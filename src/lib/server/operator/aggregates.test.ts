import { describe, expect, it } from 'vitest';
import { awardsAtLeast } from './partnerships';
import { smallCell } from './small-numbers';

describe('smallCell', () => {
	it('hides a count below the threshold and keeps zero and larger counts', () => {
		expect(smallCell(0, 5)).toEqual({ value: 0 });
		expect(smallCell(1, 5)).toEqual({ below: 5 });
		expect(smallCell(4, 5)).toEqual({ below: 5 });
		expect(smallCell(5, 5)).toEqual({ value: 5 });
	});
});

describe('awardsAtLeast', () => {
	it('admits the award of the rule and every award above it', () => {
		expect(awardsAtLeast('winner')).toEqual(['winner']);
		expect(awardsAtLeast('finalist')).toEqual(['winner', 'prize', 'finalist']);
		expect(awardsAtLeast('participant')).toEqual(['winner', 'prize', 'finalist', 'participant']);
	});
});
