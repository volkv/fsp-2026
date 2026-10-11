import { describe, expect, it } from 'vitest';
import { stepAfterConsent, type OnboardingState } from './onboarding';

type Candidate = NonNullable<OnboardingState['candidate']>;

function state(candidate: Partial<Candidate> = {}, emailVerified = true): OnboardingState {
	return {
		emailVerified,
		role: 'candidate',
		candidate: {
			id: 'candidate-1',
			status: 'active',
			eligibleFrom: null,
			minor: false,
			profileConsent: true,
			representative: null,
			survey: null,
			declaredGrade: null,
			...candidate
		},
		company: null,
		complete: false
	};
}

describe('the step after the processing consent', () => {
	it('is the survey for an adult with a confirmed address and no survey yet', () => {
		expect(stepAfterConsent(state())).toBe('/onboarding/survey');
	});

	it('is the list of steps for a minor: the representative comes first', () => {
		expect(stepAfterConsent(state({ minor: true }))).toBe('/onboarding');
	});

	it('is the list of steps while the address is not confirmed', () => {
		expect(stepAfterConsent(state({}, false))).toBe('/onboarding');
	});

	it('is the list of steps when the profile did not open or the survey is taken', () => {
		expect(stepAfterConsent(state({ status: 'onboarding' }))).toBe('/onboarding');
		expect(stepAfterConsent(state({ survey: { version: 1, specialization: 'backend' } }))).toBe('/onboarding');
	});
});
