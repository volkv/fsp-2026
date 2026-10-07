import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { offerTermsOfNeed } = await import('./offer-form');

describe('offerTermsOfNeed', () => {
	it('starts an offer from a shortlist with the format and the range of its need', () => {
		expect(
			offerTermsOfNeed({
				skill_keys: ['go'],
				nice_skill_keys: [],
				work_format: 'hybrid',
				salary: { min: 250_000, max: 320_000, currency: 'RUB', period: 'month', tax_base: 'net' }
			})
		).toEqual({ workFormat: 'hybrid', salary: { min: 250_000, max: 320_000, taxBase: 'net' } });
	});

	it('leaves a term the need does not state to the employer', () => {
		expect(offerTermsOfNeed({ skill_keys: ['go'], nice_skill_keys: [] })).toEqual({ workFormat: null, salary: null });
	});
});
