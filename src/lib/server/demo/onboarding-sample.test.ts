import { describe, expect, it } from 'vitest';
import { candidatePreferencesSchema } from '$lib/server/candidates/preferences';
import { DECLARED_SKILLS_MAX } from '$lib/server/grades/surveys';
import { surveySample } from './onboarding-sample';

const named = (...keys: string[]) => keys.map((key) => ({ key, name: key }));
const vocabulary = {
	skills: named('python', 'fastapi', 'postgresql', 'sql', 'rest', 'docker', 'git', 'go'),
	workFormats: named('office', 'hybrid', 'remote'),
	employmentForms: named('full', 'part')
};

describe('the example survey of a demo session', () => {
	it('is a Backend developer with a stack, terms and expectations the survey accepts', () => {
		const sample = surveySample(vocabulary, new Set(['backend']));
		expect(sample).toMatchObject({ direction: 'development', specialization: 'backend' });
		expect(sample?.declaredSkillKeys.length).toBeGreaterThan(0);
		expect(sample?.declaredSkillKeys.length).toBeLessThanOrEqual(DECLARED_SKILLS_MAX);
		expect(candidatePreferencesSchema.parse(sample?.preferences)).toMatchObject({
			work_formats: ['hybrid', 'remote'],
			employment_forms: ['full'],
			salary_expectation: { currency: 'RUB', period: 'month' }
		});
	});

	it('leaves out the keys the taxonomy version in force does not know', () => {
		const sample = surveySample(
			{ ...vocabulary, skills: named('python', 'sql'), workFormats: named('remote') },
			new Set(['backend'])
		);
		expect(sample?.declaredSkillKeys).toEqual(['python', 'sql']);
		expect(sample?.preferences.work_formats).toEqual(['remote']);
	});

	it('is not offered while the test of its specialization is not released', () => {
		expect(surveySample(vocabulary, new Set(['frontend']))).toBeNull();
	});
});
